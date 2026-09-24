import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getStore } from './store';
import { ensureContainer, clearContainer } from './store/blob-client';
import { getCategoryRules } from './services/settings-store';
import type { Transaction } from './store/types';

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
  if (ep.includes('netsuite - sales order')) return 'NS';
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

async function seed() {
  const csvDir = process.argv[2] || path.resolve('C:\\Users\\Lenie\\Downloads\\team central data source');
  const messagesPath = path.join(csvDir, 'Message logs from team central.csv');
  const errorsPath = path.join(csvDir, 'Error logs in team central.csv');

  console.log('Reading CSV files...');
  const messages = parseCSV(messagesPath);
  const errors = parseCSV(errorsPath);
  console.log(`  Messages: ${messages.length} rows`);
  console.log(`  Errors: ${errors.length} rows`);

  const store = getStore();
  await ensureContainer();

  console.log('Clearing existing data...');
  const deleted = await clearContainer();
  console.log(`  Deleted ${deleted} blobs`);

  // -- Process message logs (main transactions) --
  console.log('Inserting transactions from message logs...');
  let txnCount = 0;
  const insertedByExternalId = new Map<string, Transaction>();
  // In-memory index for the error-matching fallback below (nearest transaction by identifier).
  const byIdentifier = new Map<string, Transaction[]>();

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

    if (insertedByExternalId.has(externalId)) continue; // dedupe, mirrors the old UNIQUE(external_id)

    const tx = await store.insertTransaction({
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
      processed_at: status === 'SUCCESS' ? ts.toISOString() : null,
      last_attempt_at: null,
      last_error_at: null,
      processing_duration_ms: null,
      retry_count: 0,
      rerun_count: 0,
      is_rerun: false,
      raw_payload: null,
      raw_response: null,
    });

    insertedByExternalId.set(externalId, tx);
    const list = byIdentifier.get(identifier) || [];
    list.push(tx);
    byIdentifier.set(identifier, list);
    txnCount++;
  }
  console.log(`  Inserted ${txnCount} transactions`);

  // -- Process error logs --
  console.log('Inserting errors from error logs...');
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

    const txExternalId = `TC-${identifier}-${ts.getTime()}`;
    let tx = insertedByExternalId.get(txExternalId);

    if (!tx) {
      // Find the nearest transaction for this identifier (mirrors the old
      // "closest by timestamp" SQL fallback, computed in-memory here).
      const candidates = byIdentifier.get(identifier) || [];
      if (candidates.length > 0) {
        tx = candidates.reduce((closest, cur) =>
          Math.abs(new Date(cur.created_at).getTime() - ts.getTime()) <
          Math.abs(new Date(closest.created_at).getTime() - ts.getTime()) ? cur : closest);
      } else {
        const newExternalId = `TC-ERR-${identifier}-${ts.getTime()}`;
        tx = await store.insertTransaction({
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
          created_at: ts.toISOString(),
          processed_at: null,
          last_attempt_at: null,
          last_error_at: ts.toISOString(),
          processing_duration_ms: null,
          retry_count: 0,
          rerun_count: 0,
          is_rerun: false,
          raw_payload: null,
          raw_response: null,
        });
        insertedByExternalId.set(newExternalId, tx);
        byIdentifier.set(identifier, [...(byIdentifier.get(identifier) || []), tx]);
      }
    }

    // Errors older than 48h are resolved; recent ones stay open.
    const ageHours = (Date.now() - ts.getTime()) / 3600000;
    const resolvedAt = ageHours > 48 ? new Date(ts.getTime() + (2 + Math.random() * 10) * 3600000).toISOString() : null;

    await store.insertError({
      transaction_id: tx.id,
      error_code: category.code,
      error_message: errorText.slice(0, 255),
      raw_error: errorText,
      occurred_at: ts.toISOString(),
      resolved_at: resolvedAt,
      retry_count: 0,
      is_current: !resolvedAt,
    });
    errCount++;
  }
  console.log(`  Inserted ${errCount} errors`);

  // -- Mark re-runs: transactions with the same identifier appearing multiple
  //    times with a FAILED status (all but the earliest are marked as reruns) --
  console.log('Marking re-runs and creating rerun records...');
  let rerunCount = 0;
  for (const [, txns] of byIdentifier) {
    const failed = txns.filter(t => t.normalized_status === 'FAILED')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    if (failed.length <= 1) continue;

    for (const t of failed.slice(1)) {
      await store.updateTransaction(t.id, { is_rerun: true });
      await store.insertRerun({
        transaction_id: t.id,
        sales_order_id: t.sales_order_id,
        status: t.normalized_status,
        started_at: t.created_at,
        completed_at: t.normalized_status === 'SUCCESS' ? t.created_at : null,
      });
      rerunCount++;
    }
  }
  console.log(`  Created ${rerunCount} rerun records`);

  // -- Seed indexing activity from IDX flow transactions --
  console.log('Seeding indexing activity...');
  let idxCount = 0;
  for (const tx of insertedByExternalId.values()) {
    if (tx.flow_code !== 'IDX') continue;
    await store.insertIndexingActivity({
      index_type: tx.entity_type || 'Item',
      status: tx.normalized_status,
      created_at: tx.created_at,
    });
    idxCount++;
  }
  console.log(`  Created ${idxCount} indexing records`);

  // -- Seed a current heartbeat (only the latest is ever read by the dashboard) --
  console.log('Seeding heartbeat...');
  await store.recordHeartbeat({ heartbeat_at: new Date().toISOString(), system_code: 'TEAM_CENTRAL', status: 'OK', metadata: null });

  // -- Seed a severity snapshot --
  console.log('Seeding severity snapshot...');
  await store.insertSeveritySnapshot({
    evaluated_at: new Date().toISOString(),
    overall_severity: 'SEV_0',
    flow_severities: { S2N: 'SEV_0', N2S: 'SEV_0', IDX: 'SEV_0', NS: 'SEV_0' },
    open_blocking_count: 0,
    heartbeat_age_min: 0,
    tx_last_60: null,
    baseline_last_60: null,
    details: null,
  });

  console.log('\nSeed complete!');
  console.log('Summary:', {
    transactions: insertedByExternalId.size,
    errors: errCount,
    reruns: rerunCount,
    indexing: idxCount,
  });
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
