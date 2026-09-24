import 'dotenv/config';
import fs from 'fs';
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
        current += '"'; i++;
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

// ── Map endpoint names → flow codes / transaction types ──
function endpointToFlow(endpointName: string): string {
  const ep = endpointName.toLowerCase();
  if (ep.includes('save ecomm order') || ep.includes('update work order')) return 'S2N';
  if (ep.includes('shopify - read') || ep.includes('sh - update draft') || ep.includes('ns - update draft')) return 'N2S';
  if (ep.includes('netsuite - sales order') || ep.includes('netsuite - sales order')) return 'S2N';
  if (ep.includes('save order fulfillment')) return 'N2S';
  if (ep.includes('save items') || ep.includes('index') || ep.includes('save customer') || ep.includes('contact save') || ep.includes('company')) return 'IDX';
  if (ep.includes('shopify - company') || ep.includes('shopify - contact') || ep.includes('shopify - price')) return 'IDX';
  if (ep.includes('customer save') || ep.includes('company save') || ep.includes('contact save')) return 'IDX';
  if (ep.includes('shopify')) return 'S2N';
  return 'NS';
}

function endpointToTxnType(endpointName: string): string {
  const ep = endpointName.toLowerCase();
  if (ep.includes('draft order') || ep.includes('draft')) return 'Draft Order';
  if (ep.includes('fulfillment')) return 'Fulfillment';
  if (ep.includes('save items')) return 'Item';
  if (ep.includes('save ecomm order') || ep.includes('update work order') || ep.includes('sales order')) return 'Sales Order';
  if (ep.includes('shopify - read')) return 'Order';
  if (ep.includes('company') || ep.includes('contact') || ep.includes('customer')) return 'Customer';
  return 'Order';
}

// ── Error classification (uses the same CATEGORY_RULES the live dashboards use) ──
function classifyError(text: string): { code: string; group: string; isBlocking: boolean } {
  const blockingGroups = ['MAPPING', 'INDEXING'];
  for (const rule of getCategoryRules()) {
    if (new RegExp(rule.match, 'i').test(text)) {
      return { code: rule.code, group: rule.group, isBlocking: blockingGroups.includes(rule.group) };
    }
  }
  return { code: 'VAL-DATA', group: 'NETSUITE', isBlocking: false };
}

// ── Main import ──
async function importCSV() {
  const csvPath = process.argv[2] || 'C:\\Users\\Lenie\\Downloads\\export (1).csv';
  console.log(`Reading CSV: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`  ${rows.length} rows found`);

  const store = getStore();
  await ensureContainer();

  console.log('Clearing existing data...');
  const deleted = await clearContainer();
  console.log(`  Deleted ${deleted} blobs`);

  // ── 1. Build FAILED transactions + errors from CSV rows ──
  console.log('Inserting transactions and errors...');
  const txnByKey = new Map<string, Transaction>();
  let txnCount = 0;
  let errCount = 0;

  const allDates = rows.map(r => parseDate(r['Message Date'])).filter(d => !isNaN(d.getTime()));
  const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
  console.log(`  Date range: ${minDate.toISOString().slice(0, 10)} → ${maxDate.toISOString().slice(0, 10)}`);

  for (const row of rows) {
    const endpointName = row['Endpoint Name'] || '';
    const identifier = row['Identifier'] || '';
    const errorText = row['Error Text'] || '';
    const dateStr = row['Message Date'] || '';

    if (!identifier || !dateStr || !errorText) continue;
    const ts = parseDate(dateStr);
    if (isNaN(ts.getTime())) continue;

    const flowCode = endpointToFlow(endpointName);
    const txnType = endpointToTxnType(endpointName);
    const category = classifyError(errorText);

    const txnKey = `${identifier}-${endpointName}-${ts.getTime()}`;
    let tx = txnByKey.get(txnKey);
    if (!tx) {
      const externalId = `TC-${identifier}-${ts.getTime()}-${txnCount}`;
      tx = await store.insertTransaction({
        external_id: externalId,
        team_central_id: null,
        batch_id: null,
        flow_code: flowCode,
        transaction_type: txnType,
        entity_type: null,
        entity_id: null,
        entity_identifier: identifier,
        netsuite_record_type: null,
        netsuite_record_id: null,
        sales_order_id: identifier.startsWith('SO') || identifier.startsWith('#D') ? identifier : null,
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
      txnByKey.set(txnKey, tx);
      txnCount++;
    }

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
  console.log(`  Inserted ${txnCount} failed transactions`);
  console.log(`  Inserted ${errCount} errors`);

  // ── 2. Generate synthetic SUCCESS transactions ──
  // Real integrations have many more successes than failures.
  console.log('Generating success transactions...');
  const flowCodes = ['S2N', 'N2S', 'IDX', 'NS'];
  const flowTxnTypes: Record<string, string[]> = {
    S2N: ['Order', 'Sales Order'],
    N2S: ['Draft Order', 'Fulfillment'],
    IDX: ['Customer', 'Item'],
    NS: ['Sales Order'],
  };
  const flowWeights: Record<string, number> = { S2N: 5, N2S: 4, IDX: 3, NS: 3 };

  let successCount = 0;
  const dayMs = 86400000;
  const totalDays = Math.ceil((maxDate.getTime() - minDate.getTime()) / dayMs) + 1;
  const successTransactions: Transaction[] = [];

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
    const dayStart = new Date(minDate.getTime() + dayOffset * dayMs);
    dayStart.setHours(0, 0, 0, 0);

    for (const fc of flowCodes) {
      const txnsPerDay = flowWeights[fc] * (3 + Math.floor(Math.random() * 4));
      const types = flowTxnTypes[fc];

      for (let j = 0; j < txnsPerDay; j++) {
        const hour = 1 + Math.floor(Math.random() * 16);
        const minute = Math.floor(Math.random() * 60);
        const ts = new Date(dayStart.getTime() + hour * 3600000 + minute * 60000);
        const txType = types[Math.floor(Math.random() * types.length)];

        const prefix = fc === 'S2N' ? '#D' : fc === 'N2S' ? 'SO' : fc === 'IDX' ? 'IDX-' : '#NS';
        const identifier = `${prefix}${20000 + successCount}`;
        const externalId = `TC-OK-${identifier}-${ts.getTime()}`;

        const tx = await store.insertTransaction({
          external_id: externalId,
          team_central_id: null,
          batch_id: null,
          flow_code: fc,
          transaction_type: txType,
          entity_type: null,
          entity_id: null,
          entity_identifier: identifier,
          netsuite_record_type: null,
          netsuite_record_id: null,
          sales_order_id: null,
          external_order_id: null,
          original_status: null,
          normalized_status: 'SUCCESS',
          created_at: ts.toISOString(),
          processed_at: ts.toISOString(),
          last_attempt_at: null,
          last_error_at: null,
          processing_duration_ms: null,
          retry_count: 0,
          rerun_count: 0,
          is_rerun: false,
          raw_payload: null,
          raw_response: null,
        });
        successTransactions.push(tx);
        successCount++;
      }
    }
  }
  console.log(`  Inserted ${successCount} success transactions`);

  // ── 3. Mark re-runs (identifiers with more than one FAILED transaction) ──
  console.log('Marking re-runs and creating rerun records...');
  const byIdentifier = new Map<string, Transaction[]>();
  for (const tx of [...txnByKey.values(), ...successTransactions]) {
    const list = byIdentifier.get(tx.entity_identifier || '') || [];
    list.push(tx);
    byIdentifier.set(tx.entity_identifier || '', list);
  }

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
        completed_at: t.created_at,
      });
      rerunCount++;
    }
  }
  console.log(`  Created ${rerunCount} rerun records`);

  // ── 4. Seed indexing activity from IDX flow ──
  console.log('Seeding indexing activity...');
  let idxCount = 0;
  for (const tx of [...txnByKey.values(), ...successTransactions]) {
    if (tx.flow_code !== 'IDX') continue;
    await store.insertIndexingActivity({
      index_type: tx.entity_type || 'Item',
      status: tx.normalized_status,
      created_at: tx.created_at,
    });
    idxCount++;
  }
  console.log(`  Created ${idxCount} indexing records`);

  // ── 5. Seed a current heartbeat (only the latest is ever read) ──
  console.log('Seeding heartbeat...');
  await store.recordHeartbeat({ heartbeat_at: new Date().toISOString(), system_code: 'TEAM_CENTRAL', status: 'OK', metadata: null });

  // ── 6. Severity snapshot ──
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

  const allTx = [...txnByKey.values(), ...successTransactions];
  console.log('\n=== Import complete! ===');
  console.log({
    transactions: allTx.length,
    succeeded: allTx.filter(t => t.normalized_status === 'SUCCESS').length,
    failed: allTx.filter(t => t.normalized_status === 'FAILED').length,
    errors: errCount,
    reruns: rerunCount,
    indexing: idxCount,
  });
}

importCSV().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
