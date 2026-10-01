import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ulid } from 'ulid';
import { ensureContainer, clearContainer, writeJson } from './store/blob-client';
import { getCategoryRules } from './services/settings-store';
import type { Transaction, IntegrationError, Rerun, IndexingActivity } from './store/types';

// ── CSV parsing (handles quoted fields with commas) ──
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'; i++; // escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] || ''; });
    return row;
  });
}

// ── Parse "MM/DD/YYYY, HH:MM:SS AM/PM" date format ──
function parseDate(dateStr: string): Date {
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return new Date(dateStr);
  let [, mo, dd, yyyy, hh, mm, ss, ampm] = m;
  let hour = parseInt(hh, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return new Date(parseInt(yyyy), parseInt(mo) - 1, parseInt(dd), hour, parseInt(mm), parseInt(ss));
}

// ── Map endpoint names to flow codes ──
function endpointToFlow(endpointName: string, system: string): string {
  const ep = endpointName.toLowerCase();
  if (ep.includes('save ecomm order') || ep.includes('update work order')) return 'S2N';
  if (ep.includes('shopify - read') || ep.includes('sh - update draft') || ep.includes('ns - update draft')) return 'N2S';
  if (ep.includes('netsuite - sales order')) return 'S2N';
  if (ep.includes('save order fulfillment')) return 'N2S';
  if (ep.includes('save items') || ep.includes('index') || ep.includes('save customer') || ep.includes('contact save') || ep.includes('company')) return 'IDX';
  if (ep.includes('shopify - company') || ep.includes('shopify - contact') || ep.includes('shopify - price')) return 'IDX';
  if (ep.includes('customer save') || ep.includes('company save') || ep.includes('contact save')) return 'IDX';
  if (system === 'Shopify') return 'S2N';
  return 'NS';
}

// ── Map endpoint names to transaction types ──
function endpointToTxnType(endpointName: string, entityType: string): string {
  const ep = endpointName.toLowerCase();
  if (entityType === 'ItemFulfillment') return 'Fulfillment';
  if (entityType === 'Product') return 'Item';
  if (entityType === 'Customer') return 'Customer';
  if (entityType === 'CustomerContact') return 'Customer';
  if (ep.includes('draft order') || ep.includes('draft')) return 'Draft Order';
  if (ep.includes('fulfillment')) return 'Fulfillment';
  if (ep.includes('save items')) return 'Item';
  if (ep.includes('save ecomm order') || ep.includes('update work order') || ep.includes('sales order')) return 'Sales Order';
  if (ep.includes('shopify - read')) return 'Order';
  if (ep.includes('company') || ep.includes('contact') || ep.includes('customer')) return 'Customer';
  return 'Order';
}

// ── Classify error text using the same CATEGORY_RULES the live dashboards use ──
function classifyError(text: string): { code: string; group: string; isBlocking: boolean } {
  const blockingGroups = ['MAPPING', 'INDEXING'];
  for (const rule of getCategoryRules()) {
    if (new RegExp(rule.match, 'i').test(text)) {
      return { code: rule.code, group: rule.group, isBlocking: blockingGroups.includes(rule.group) };
    }
  }
  return { code: 'VAL-DATA', group: 'NETSUITE', isBlocking: false };
}

function normalizeStatus(errors: number): string {
  return errors > 0 ? 'FAILED' : 'SUCCESS';
}

function dayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

function monthKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 7);
}

/** Find messages and errors CSV files in a directory by header detection. */
function findCSVFiles(dir: string): { messagesPath: string; errorsPath: string } {
  // Try well-known names first
  const knownMessages = ['Message logs from team central.csv', 'export (7).csv'];
  const knownErrors = ['Error logs in team central.csv', 'export (6).csv'];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv'));

  let messagesPath = '';
  let errorsPath = '';

  for (const name of knownMessages) {
    if (files.includes(name)) { messagesPath = path.join(dir, name); break; }
  }
  for (const name of knownErrors) {
    if (files.includes(name)) { errorsPath = path.join(dir, name); break; }
  }

  // Fallback: detect by header content
  if (!messagesPath || !errorsPath) {
    for (const f of files) {
      const filePath = path.join(dir, f);
      const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
      if (!messagesPath && firstLine.includes('System') && firstLine.includes('Transaction Type')) {
        messagesPath = filePath;
      } else if (!errorsPath && firstLine.includes('Endpoint Name') && firstLine.includes('Error Text')) {
        errorsPath = filePath;
      }
    }
  }

  if (!messagesPath) throw new Error(`No messages CSV found in ${dir}. Expected headers: System, Transaction Type`);
  if (!errorsPath) throw new Error(`No errors CSV found in ${dir}. Expected headers: Endpoint Name, Error Text`);
  return { messagesPath, errorsPath };
}

// ── In-memory day-file helpers ──
function addToDayMap<T>(map: Map<string, Record<string, T>>, key: string, id: string, record: T) {
  if (!map.has(key)) map.set(key, {});
  map.get(key)![id] = record;
}

// ── Parallel blob write with concurrency limit ──
async function writeAllBlobs(blobs: Array<{ path: string; data: unknown }>, concurrency = 10) {
  let i = 0;
  async function next(): Promise<void> {
    while (i < blobs.length) {
      const blob = blobs[i++];
      await writeJson(blob.path, blob.data);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, blobs.length) }, () => next());
  await Promise.all(workers);
}

export async function seed(csvDirOverride?: string) {
  const csvDir = csvDirOverride || process.argv[2] || path.resolve('C:\\Users\\Lenie\\Downloads\\team central data source');
  const { messagesPath, errorsPath } = findCSVFiles(csvDir);

  console.log('Reading CSV files...');
  console.log(`  Messages file: ${messagesPath}`);
  console.log(`  Errors file: ${errorsPath}`);
  const messages = parseCSV(messagesPath);
  const errors = parseCSV(errorsPath);
  console.log(`  Messages: ${messages.length} rows`);
  console.log(`  Errors: ${errors.length} rows`);

  await ensureContainer();

  console.log('Clearing existing data...');
  const deleted = await clearContainer();
  console.log(`  Deleted ${deleted} blobs`);

  // ── In-memory data structures ──
  const txDayMap = new Map<string, Record<string, Transaction>>();
  const errDayMap = new Map<string, Record<string, IntegrationError>>();
  const rerunDayMap = new Map<string, Record<string, Rerun>>();
  const idxDayMap = new Map<string, Record<string, IndexingActivity>>();

  // Index blobs
  const txIdToDay: Record<string, string> = {};
  const txExternalId: Record<string, string> = {};
  const txSalesOrder: Record<string, string[]> = {};
  const errorIdToDay: Record<string, string> = {};
  const errorTxToIds: Record<string, string[]> = {};
  const openErrorIds: string[] = [];
  const rerunIdToDay: Record<string, string> = {};
  const rerunTxToIds: Record<string, string[]> = {};

  // Lookup maps
  const insertedByExternalId = new Map<string, Transaction>();
  const byIdentifier = new Map<string, Transaction[]>();

  const now = new Date().toISOString();

  // -- Process message logs (main transactions) --
  console.log('Building transactions in memory...');
  let txnCount = 0;

  for (const msg of messages) {
    const system = msg['System'] || '';
    const txnType = msg['Transaction Type'] || '';
    const entityType = msg['Entity Type'] || '';
    const identifier = msg['Identifier'] || '';
    const msgErrors = parseInt(msg['Errors'] || '0', 10);
    const dateStr = msg['Message Date'] || '';

    if (!identifier || !dateStr) continue;

    const ts = parseDate(dateStr);
    const flowCode = endpointToFlow(txnType, system);
    const txType = endpointToTxnType(txnType, entityType);
    const status = normalizeStatus(msgErrors);
    const externalId = `TC-${identifier}-${ts.getTime()}`;

    if (insertedByExternalId.has(externalId)) continue;

    const id = ulid();
    const createdAt = ts.toISOString();
    const key = dayKey(createdAt);

    const tx: Transaction = {
      id,
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
      created_at: createdAt,
      updated_at: now,
      processed_at: status === 'SUCCESS' ? createdAt : null,
      last_attempt_at: null,
      last_error_at: null,
      processing_duration_ms: null,
      retry_count: 0,
      rerun_count: 0,
      is_rerun: false,
      raw_payload: null,
      raw_response: null,
    };

    addToDayMap(txDayMap, key, id, tx);
    txIdToDay[id] = key;
    txExternalId[externalId] = id;
    if (tx.sales_order_id) {
      if (!txSalesOrder[tx.sales_order_id]) txSalesOrder[tx.sales_order_id] = [];
      txSalesOrder[tx.sales_order_id].push(id);
    }

    insertedByExternalId.set(externalId, tx);
    const list = byIdentifier.get(identifier) || [];
    list.push(tx);
    byIdentifier.set(identifier, list);
    txnCount++;
  }
  console.log(`  Built ${txnCount} transactions`);

  // -- Process error logs --
  console.log('Building errors in memory...');
  let errCount = 0;

  for (const err of errors) {
    const endpointName = err['Endpoint Name'] || '';
    const identifier = err['Identifier'] || '';
    const errorText = err['Error Text'] || '';
    const dateStr = err['Message Date'] || '';

    if (!identifier || !dateStr || !errorText) continue;

    const ts = parseDate(dateStr);
    const flowCode = endpointToFlow(endpointName, '');
    const category = classifyError(errorText);

    const txExternalIdKey = `TC-${identifier}-${ts.getTime()}`;
    let tx = insertedByExternalId.get(txExternalIdKey);

    if (!tx) {
      const candidates = byIdentifier.get(identifier) || [];
      if (candidates.length > 0) {
        tx = candidates.reduce((closest, cur) =>
          Math.abs(new Date(cur.created_at).getTime() - ts.getTime()) <
          Math.abs(new Date(closest.created_at).getTime() - ts.getTime()) ? cur : closest);
      } else {
        // Create orphan transaction for this error
        const newExternalId = `TC-ERR-${identifier}-${ts.getTime()}`;
        const orphanId = ulid();
        const createdAt = ts.toISOString();
        const key = dayKey(createdAt);

        tx = {
          id: orphanId,
          external_id: newExternalId,
          team_central_id: null,
          batch_id: null,
          flow_code: flowCode,
          transaction_type: endpointToTxnType(endpointName, ''),
          entity_type: null,
          entity_id: null,
          entity_identifier: identifier,
          netsuite_record_type: null,
          netsuite_record_id: null,
          sales_order_id: identifier.startsWith('SO') ? identifier : null,
          external_order_id: null,
          original_status: null,
          normalized_status: 'FAILED',
          created_at: createdAt,
          updated_at: now,
          processed_at: null,
          last_attempt_at: null,
          last_error_at: createdAt,
          processing_duration_ms: null,
          retry_count: 0,
          rerun_count: 0,
          is_rerun: false,
          raw_payload: null,
          raw_response: null,
        };

        addToDayMap(txDayMap, key, orphanId, tx);
        txIdToDay[orphanId] = key;
        txExternalId[newExternalId] = orphanId;
        if (tx.sales_order_id) {
          if (!txSalesOrder[tx.sales_order_id]) txSalesOrder[tx.sales_order_id] = [];
          txSalesOrder[tx.sales_order_id].push(orphanId);
        }

        insertedByExternalId.set(newExternalId, tx);
        byIdentifier.set(identifier, [...(byIdentifier.get(identifier) || []), tx]);
      }
    }

    const ageHours = (Date.now() - ts.getTime()) / 3600000;
    const resolvedAt = ageHours > 48 ? new Date(ts.getTime() + (2 + Math.random() * 10) * 3600000).toISOString() : null;

    const blockingGroups = ['MAPPING', 'INDEXING'];
    const errId = ulid();
    const occurredAt = ts.toISOString();
    const errKey = dayKey(occurredAt);

    const integrationError: IntegrationError = {
      id: errId,
      transaction_id: tx.id,
      error_code: category.code,
      error_group: category.group,
      category_label: getCategoryRules().find(c => c.code === category.code)?.label || null,
      error_message: errorText.slice(0, 255),
      raw_error: errorText,
      occurred_at: occurredAt,
      resolved_at: resolvedAt,
      retry_count: 0,
      is_blocking: blockingGroups.includes(category.group),
      is_current: !resolvedAt,
      created_at: now,
    };

    addToDayMap(errDayMap, errKey, errId, integrationError);
    errorIdToDay[errId] = errKey;
    if (!errorTxToIds[tx.id]) errorTxToIds[tx.id] = [];
    errorTxToIds[tx.id].push(errId);
    if (!resolvedAt) openErrorIds.push(errId);
    errCount++;
  }
  console.log(`  Built ${errCount} errors`);

  // -- Mark re-runs --
  console.log('Building rerun records...');
  let rerunCount = 0;
  for (const [, txns] of byIdentifier) {
    const failed = txns.filter(t => t.normalized_status === 'FAILED')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (failed.length <= 1) continue;

    for (const t of failed.slice(1)) {
      // Update the in-memory transaction
      t.is_rerun = true;
      // Also update in day map
      const tKey = dayKey(t.created_at);
      const dayRec = txDayMap.get(tKey);
      if (dayRec && dayRec[t.id]) dayRec[t.id].is_rerun = true;

      const rerunId = ulid();
      const rerun: Rerun = {
        id: rerunId,
        transaction_id: t.id,
        sales_order_id: t.sales_order_id,
        status: t.normalized_status,
        started_at: t.created_at,
        completed_at: t.normalized_status === 'SUCCESS' ? t.created_at : null,
      };
      const rKey = dayKey(rerun.started_at);
      addToDayMap(rerunDayMap, rKey, rerunId, rerun);
      rerunIdToDay[rerunId] = rKey;
      if (!rerunTxToIds[t.id]) rerunTxToIds[t.id] = [];
      rerunTxToIds[t.id].push(rerunId);
      rerunCount++;
    }
  }
  console.log(`  Built ${rerunCount} rerun records`);

  // -- Build indexing activity --
  console.log('Building indexing activity...');
  let idxCount = 0;
  for (const tx of insertedByExternalId.values()) {
    if (tx.flow_code !== 'IDX') continue;
    const actId = ulid();
    const activity: IndexingActivity = {
      id: actId,
      index_type: tx.entity_type || 'Item',
      status: tx.normalized_status,
      created_at: tx.created_at,
    };
    addToDayMap(idxDayMap, dayKey(tx.created_at), actId, activity);
    idxCount++;
  }
  console.log(`  Built ${idxCount} indexing records`);

  // ── Write all blobs in parallel ──
  console.log('Writing all blobs to storage...');
  const blobs: Array<{ path: string; data: unknown }> = [];

  // Day-files
  for (const [key, records] of txDayMap) blobs.push({ path: `transactions/${key}.json`, data: records });
  for (const [key, records] of errDayMap) blobs.push({ path: `errors/${key}.json`, data: records });
  for (const [key, records] of rerunDayMap) blobs.push({ path: `reruns/${key}.json`, data: records });
  for (const [key, records] of idxDayMap) blobs.push({ path: `indexing/${key}.json`, data: records });

  // Index blobs
  blobs.push({ path: 'index/tx-id-to-day.json', data: txIdToDay });
  blobs.push({ path: 'index/tx-external-id.json', data: txExternalId });
  blobs.push({ path: 'index/tx-sales-order.json', data: txSalesOrder });
  blobs.push({ path: 'index/error-id-to-day.json', data: errorIdToDay });
  blobs.push({ path: 'index/error-tx-to-ids.json', data: errorTxToIds });
  blobs.push({ path: 'index/open-error-ids.json', data: openErrorIds });
  blobs.push({ path: 'index/rerun-id-to-day.json', data: rerunIdToDay });
  blobs.push({ path: 'index/rerun-tx-to-ids.json', data: rerunTxToIds });
  blobs.push({ path: 'index/pending-tx-ids.json', data: [] });
  blobs.push({ path: 'index/unsent-notifications.json', data: [] });

  // Heartbeat
  blobs.push({ path: 'heartbeats/latest.json', data: { heartbeat_at: now, system_code: 'TEAM_CENTRAL', status: 'OK', metadata: null } });

  // Severity snapshot
  const snapId = ulid();
  blobs.push({
    path: `severity-snapshots/${monthKey(now)}.json`,
    data: [{
      id: snapId,
      evaluated_at: now,
      overall_severity: 'SEV_0',
      flow_severities: { S2N: 'SEV_0', N2S: 'SEV_0', IDX: 'SEV_0', NS: 'SEV_0' },
      open_blocking_count: 0,
      heartbeat_age_min: 0,
      tx_last_60: null,
      baseline_last_60: null,
      details: null,
    }],
  });

  console.log(`  ${blobs.length} blobs to write (${txDayMap.size} tx days, ${errDayMap.size} err days, ${rerunDayMap.size} rerun days, ${idxDayMap.size} idx days + indexes)`);
  await writeAllBlobs(blobs, 15);
  console.log('  All blobs written!');

  console.log('\nSeed complete!');
  console.log('Summary:', {
    transactions: insertedByExternalId.size,
    errors: errCount,
    reruns: rerunCount,
    indexing: idxCount,
    blobs: blobs.length,
  });
}

// Only run directly when invoked as a script (not imported as a module)
if (require.main === module) {
  seed().catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
