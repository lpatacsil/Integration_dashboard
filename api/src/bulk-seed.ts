/**
 * Fast bulk seed — groups all records by day and writes each blob once
 * instead of doing a read-modify-write per record.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import { ensureContainer, clearContainer, writeJson } from './store/blob-client';
import { getCategoryRules } from './services/settings-store';
import { loadSettings } from './services/settings-store';
import type { Transaction, IntegrationError, Rerun, IndexingActivity, Heartbeat, SeveritySnapshot } from './store/types';

// ── CSV parsing ──
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
    else current += ch;
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  });
}

function parseDate(dateStr: string): Date {
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return new Date(dateStr);
  let [, mo, dd, yyyy, hh, mm, ss, ampm] = m;
  let hour = parseInt(hh, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return new Date(parseInt(yyyy), parseInt(mo) - 1, parseInt(dd), hour, parseInt(mm), parseInt(ss));
}

function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }

function endpointToFlow(endpointName: string, system: string): string {
  const ep = endpointName.toLowerCase();
  if (ep.includes('save ecomm order') || ep.includes('update work order')) return 'S2N';
  if (ep.includes('shopify - read') || ep.includes('sh - update draft') || ep.includes('ns - update draft')) return 'N2S';
  // Sales order creation/line failures are Shopify→NetSuite sync errors, not internal
  // NetSuite processing (Vertex/inventory/permissions) — the NS flow is excluded from
  // the severity ladder, so misrouting these here silently hid ~38% of all real errors.
  if (ep.includes('netsuite - sales order')) return 'S2N';
  if (ep.includes('save order fulfillment')) return 'N2S';
  if (ep.includes('save items') || ep.includes('index') || ep.includes('save customer') || ep.includes('contact save') || ep.includes('company')) return 'IDX';
  if (ep.includes('shopify - company') || ep.includes('shopify - contact') || ep.includes('shopify - price')) return 'IDX';
  if (ep.includes('customer save') || ep.includes('company save') || ep.includes('contact save')) return 'IDX';
  if (system === 'Shopify') return 'S2N';
  return 'NS';
}

function endpointToTxnType(endpointName: string, entityType: string): string {
  const ep = endpointName.toLowerCase();
  if (entityType === 'ItemFulfillment') return 'Fulfillment';
  if (entityType === 'Product') return 'Item';
  if (entityType === 'Customer' || entityType === 'CustomerContact') return 'Customer';
  if (ep.includes('draft order') || ep.includes('draft')) return 'Draft Order';
  if (ep.includes('fulfillment')) return 'Fulfillment';
  if (ep.includes('save items')) return 'Item';
  if (ep.includes('save ecomm order') || ep.includes('update work order') || ep.includes('sales order')) return 'Sales Order';
  if (ep.includes('shopify - read')) return 'Order';
  if (ep.includes('company') || ep.includes('contact') || ep.includes('customer')) return 'Customer';
  return 'Order';
}

function classifyError(text: string): { code: string; group: string; label: string; isBlocking: boolean } {
  const blockingGroups = ['MAPPING', 'INDEXING'];
  for (const rule of getCategoryRules()) {
    if (new RegExp(rule.match, 'i').test(text)) {
      return { code: rule.code, group: rule.group, label: rule.label, isBlocking: blockingGroups.includes(rule.group) };
    }
  }
  return { code: 'VAL-DATA', group: 'NETSUITE', label: 'Data validation', isBlocking: false };
}

// ── In-memory accumulators (written to blob once at end) ──
const txByDay = new Map<string, Record<string, Transaction>>();
const errByDay = new Map<string, Record<string, IntegrationError>>();
const rerunByDay = new Map<string, Record<string, Rerun>>();
const idxByDay = new Map<string, Record<string, IndexingActivity>>();
const txIdToDay: Record<string, string> = {};
const txExternalId: Record<string, string> = {};
const txSalesOrder: Record<string, string[]> = {};
const errorIdToDay: Record<string, string> = {};
const errorTxToIds: Record<string, string[]> = {};
const openErrorIds: string[] = [];
const rerunIdToDay: Record<string, string> = {};
const rerunTxToIds: Record<string, string[]> = {};
const pendingTxIds: string[] = [];

function addTx(day: string, tx: Transaction) {
  if (!txByDay.has(day)) txByDay.set(day, {});
  txByDay.get(day)![tx.id] = tx;
  txIdToDay[tx.id] = day;
  txExternalId[tx.external_id!] = tx.id;
  if (tx.sales_order_id != null) {
    const soId: string = tx.sales_order_id;
    if (!txSalesOrder[soId]) txSalesOrder[soId] = [];
    txSalesOrder[soId].push(tx.id);
  }
  if (tx.normalized_status === 'PENDING' || tx.normalized_status === 'PROCESSING') {
    pendingTxIds.push(tx.id);
  }
}

function addError(day: string, err: IntegrationError) {
  if (!errByDay.has(day)) errByDay.set(day, {});
  errByDay.get(day)![err.id] = err;
  errorIdToDay[err.id] = day;
  if (!errorTxToIds[err.transaction_id]) errorTxToIds[err.transaction_id] = [];
  errorTxToIds[err.transaction_id].push(err.id);
  if (err.is_current) openErrorIds.push(err.id);
}

function addRerun(day: string, rerun: Rerun) {
  if (!rerunByDay.has(day)) rerunByDay.set(day, {});
  rerunByDay.get(day)![rerun.id] = rerun;
  rerunIdToDay[rerun.id] = day;
  if (!rerunTxToIds[rerun.transaction_id]) rerunTxToIds[rerun.transaction_id] = [];
  rerunTxToIds[rerun.transaction_id].push(rerun.id);
}

async function main() {
  const csvDir = process.argv[2] || path.resolve('C:\\Users\\Lenie\\Downloads\\new tc logs');
  const messagesPath = path.join(csvDir, 'export (7).csv');
  const errorsPath = path.join(csvDir, 'export (6).csv');

  await loadSettings();

  console.log('Reading CSVs...');
  const messages = parseCSV(messagesPath);
  const errors = parseCSV(errorsPath);
  console.log(`  Messages: ${messages.length}  Errors: ${errors.length}`);

  // ── Find the latest date in CSV data and compute offset to shift to today ──
  let maxTs = 0;
  for (const msg of messages) {
    const d = msg['Message Date'] || '';
    if (d) { const t = parseDate(d).getTime(); if (!isNaN(t) && t > maxTs) maxTs = t; }
  }
  for (const err of errors) {
    const d = err['Message Date'] || '';
    if (d) { const t = parseDate(d).getTime(); if (!isNaN(t) && t > maxTs) maxTs = t; }
  }
  // Shift so the latest CSV date becomes today
  const today = new Date(); today.setHours(23, 59, 59, 0);
  const dateOffsetMs = today.getTime() - maxTs;
  const offsetDays = Math.round(dateOffsetMs / 86400000);
  console.log(`  Latest CSV date: ${new Date(maxTs).toISOString().slice(0,10)}`);
  console.log(`  Shifting all dates forward by ${offsetDays} days to reach today`);

  function shiftDate(d: Date): Date {
    return new Date(d.getTime() + dateOffsetMs);
  }

  await ensureContainer();
  console.log('Clearing existing data...');
  const deleted = await clearContainer();
  console.log(`  Deleted ${deleted} blobs`);

  // ── 1. Build transactions from message logs ──
  console.log('Building transactions...');
  const insertedByExternalId = new Map<string, Transaction>();
  const byIdentifier = new Map<string, Transaction[]>();

  for (const msg of messages) {
    const system = msg['System'] || '';
    const txnType = msg['Transaction Type'] || '';
    const entityType = msg['Entity Type'] || '';
    const identifier = msg['Identifier'] || '';
    const msgErrors = parseInt(msg['Errors'] || '0', 10);
    const dateStr = msg['Message Date'] || '';
    if (!identifier || !dateStr) continue;

    const ts = shiftDate(parseDate(dateStr));
    if (isNaN(ts.getTime())) continue;
    const flowCode = endpointToFlow(txnType, system);
    const txType = endpointToTxnType(txnType, entityType);
    const status = msgErrors > 0 ? 'FAILED' : 'SUCCESS';
    const externalId = `TC-${identifier}-${ts.getTime()}`;
    if (insertedByExternalId.has(externalId)) continue;

    const now = new Date().toISOString();
    const tx: Transaction = {
      id: ulid(),
      external_id: externalId,
      team_central_id: null,
      batch_id: null,
      flow_code: flowCode,
      transaction_type: txType,
      entity_type: entityType || null,
      entity_id: null,
      entity_identifier: identifier,
      netsuite_record_type: null,
      netsuite_record_id: null,
      sales_order_id: identifier.startsWith('SO') ? identifier : null,
      external_order_id: null,
      original_status: null,
      normalized_status: status,
      created_at: ts.toISOString(),
      updated_at: now,
      processed_at: status === 'SUCCESS' ? ts.toISOString() : null,
      last_attempt_at: null,
      last_error_at: null,
      processing_duration_ms: null,
      retry_count: 0,
      rerun_count: 0,
      is_rerun: false,
      raw_payload: null,
      raw_response: null,
    };

    const day = dayKey(ts);
    addTx(day, tx);
    insertedByExternalId.set(externalId, tx);
    const list = byIdentifier.get(identifier) || [];
    list.push(tx);
    byIdentifier.set(identifier, list);
  }
  console.log(`  ${insertedByExternalId.size} transactions built`);

  // ── 2. Build errors ──
  console.log('Building errors...');
  let errCount = 0;
  for (const err of errors) {
    const endpointName = err['Endpoint Name'] || '';
    const identifier = err['Identifier'] || '';
    const errorText = err['Error Text'] || '';
    const dateStr = err['Message Date'] || '';
    if (!identifier || !dateStr || !errorText) continue;

    const ts = shiftDate(parseDate(dateStr));
    if (isNaN(ts.getTime())) continue;
    const category = classifyError(errorText);

    const txExternalIdStr = `TC-${identifier}-${ts.getTime()}`;
    let tx = insertedByExternalId.get(txExternalIdStr);
    if (!tx) {
      const candidates = byIdentifier.get(identifier) || [];
      if (candidates.length > 0) {
        tx = candidates.reduce((closest, cur) =>
          Math.abs(new Date(cur.created_at).getTime() - ts.getTime()) <
          Math.abs(new Date(closest.created_at).getTime() - ts.getTime()) ? cur : closest);
      } else {
        const flowCode = endpointToFlow(endpointName, '');
        const newExternalId = `TC-ERR-${identifier}-${ts.getTime()}`;
        const now = new Date().toISOString();
        tx = {
          id: ulid(),
          external_id: newExternalId,
          team_central_id: null, batch_id: null,
          flow_code: flowCode,
          transaction_type: endpointToTxnType(endpointName, ''),
          entity_type: null, entity_id: null,
          entity_identifier: identifier,
          netsuite_record_type: null, netsuite_record_id: null,
          sales_order_id: identifier.startsWith('SO') ? identifier : null,
          external_order_id: null, original_status: null,
          normalized_status: 'FAILED',
          created_at: ts.toISOString(), updated_at: now,
          processed_at: null, last_attempt_at: null,
          last_error_at: ts.toISOString(),
          processing_duration_ms: null,
          retry_count: 0, rerun_count: 0, is_rerun: false,
          raw_payload: null, raw_response: null,
        };
        addTx(dayKey(ts), tx);
        insertedByExternalId.set(newExternalId, tx);
        byIdentifier.set(identifier, [...(byIdentifier.get(identifier) || []), tx]);
      }
    }

    // Resolution logic: errors older than 24h have ~75% chance of being resolved;
    // errors from today/yesterday stay open (unresolved) so they show on the dashboard
    const ageHours = (Date.now() - ts.getTime()) / 3600000;
    let resolvedAt: string | null = null;
    if (ageHours > 24 && Math.random() < 0.75) {
      // Resolved after 1–12 hours
      resolvedAt = new Date(ts.getTime() + (1 + Math.random() * 11) * 3600000).toISOString();
    }

    const errRec: IntegrationError = {
      id: ulid(),
      transaction_id: tx.id,
      error_code: category.code,
      error_group: category.group,
      category_label: category.label,
      error_message: errorText.slice(0, 255),
      raw_error: errorText,
      occurred_at: ts.toISOString(),
      resolved_at: resolvedAt,
      retry_count: 0,
      is_blocking: category.isBlocking,
      is_current: !resolvedAt,
      created_at: ts.toISOString(),
    };
    addError(dayKey(ts), errRec);
    errCount++;
  }
  console.log(`  ${errCount} errors built`);

  // ── 3. Mark reruns ──
  console.log('Building reruns...');
  let rerunCount = 0;
  for (const [, txns] of byIdentifier) {
    const failed = txns.filter(t => t.normalized_status === 'FAILED')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (failed.length <= 1) continue;
    for (const t of failed.slice(1)) {
      t.is_rerun = true;
      const rerun: Rerun = {
        id: ulid(),
        transaction_id: t.id,
        sales_order_id: t.sales_order_id,
        status: t.normalized_status,
        started_at: t.created_at,
        completed_at: t.normalized_status === 'SUCCESS' ? t.created_at : null,
      };
      addRerun(dayKey(new Date(t.created_at)), rerun);
      rerunCount++;
    }
  }
  console.log(`  ${rerunCount} reruns`);

  // ── 4. Build indexing activity ──
  let idxCount = 0;
  for (const tx of insertedByExternalId.values()) {
    if (tx.flow_code !== 'IDX') continue;
    const ts = new Date(tx.created_at);
    const day = dayKey(ts);
    if (!idxByDay.has(day)) idxByDay.set(day, {});
    const rec: IndexingActivity = { id: ulid(), index_type: tx.entity_type || 'Item', status: tx.normalized_status, created_at: tx.created_at };
    idxByDay.get(day)![rec.id] = rec;
    idxCount++;
  }

  // ── 5. WRITE EVERYTHING to blob storage ──
  console.log('Writing to blob storage...');
  let blobCount = 0;

  // Day files
  for (const [day, records] of txByDay) {
    await writeJson(`transactions/${day}.json`, records);
    blobCount++;
  }
  console.log(`  ${txByDay.size} transaction day-files`);

  for (const [day, records] of errByDay) {
    await writeJson(`errors/${day}.json`, records);
    blobCount++;
  }
  console.log(`  ${errByDay.size} error day-files`);

  for (const [day, records] of rerunByDay) {
    await writeJson(`reruns/${day}.json`, records);
    blobCount++;
  }
  console.log(`  ${rerunByDay.size} rerun day-files`);

  for (const [day, records] of idxByDay) {
    await writeJson(`indexing/${day}.json`, records);
    blobCount++;
  }

  // Index files
  await writeJson('index/tx-id-to-day.json', txIdToDay); blobCount++;
  await writeJson('index/tx-external-id.json', txExternalId); blobCount++;
  await writeJson('index/tx-sales-order.json', txSalesOrder); blobCount++;
  await writeJson('index/error-id-to-day.json', errorIdToDay); blobCount++;
  await writeJson('index/error-tx-to-ids.json', errorTxToIds); blobCount++;
  await writeJson('index/open-error-ids.json', openErrorIds); blobCount++;
  await writeJson('index/rerun-id-to-day.json', rerunIdToDay); blobCount++;
  await writeJson('index/rerun-tx-to-ids.json', rerunTxToIds); blobCount++;
  await writeJson('index/unsent-notifications.json', {}); blobCount++;
  await writeJson('index/pending-tx-ids.json', pendingTxIds); blobCount++;

  // Heartbeat + severity snapshot
  const hb: Heartbeat = { heartbeat_at: new Date().toISOString(), system_code: 'TEAM_CENTRAL', status: 'OK', metadata: null };
  await writeJson('heartbeats/latest.json', hb); blobCount++;

  const snap: SeveritySnapshot = {
    id: ulid(),
    evaluated_at: new Date().toISOString(),
    overall_severity: 'SEV_0',
    flow_severities: { S2N: 'SEV_0', N2S: 'SEV_0', IDX: 'SEV_0', NS: 'SEV_0' },
    open_blocking_count: 0,
    heartbeat_age_min: 0,
    tx_last_60: null,
    baseline_last_60: null,
    details: null,
  };
  await writeJson('severity/latest.json', snap); blobCount++;

  console.log(`\nDone! Wrote ${blobCount} blobs.`);
  console.log({
    transactions: insertedByExternalId.size,
    errors: errCount,
    reruns: rerunCount,
    indexing: idxCount,
  });
}

main().catch(err => { console.error('Seed failed:', err); process.exit(1); });
