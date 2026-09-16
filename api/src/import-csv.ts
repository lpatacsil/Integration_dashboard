import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'integration_monitor',
  user: process.env.DB_USER || 'integration_monitor',
  password: process.env.DB_PASSWORD || 'localdev_only_2026',
});

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

// ── Map endpoint names → flow codes (same logic as seed.ts) ──
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

// ── Map endpoint names → transaction types ──
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

// ── Error classification (same rules as config.ts / seed.ts) ──
interface CategoryRule {
  code: string;
  group: string;
  match: RegExp;
  isBlocking: boolean;
}

const CATEGORY_RULES: CategoryRule[] = [
  { code: 'MAP-CUST',   group: 'MAPPING',   match: /customer.*(not (found|mapped)|missing)|enter a value for.*entity|Entity Id.*invalid/i,  isBlocking: true },
  { code: 'MAP-ITEM',   group: 'MAPPING',   match: /(item|sku).*(not (found|mapped)|invalid)|choose an item|at least one line item|Invalid Field Value.*item|sub-resource field 'item'/i,  isBlocking: true },
  { code: 'MAP-SHIP',   group: 'MAPPING',   match: /(ship.?to|address).*(not (found|mapped)|invalid)|Ship To Select/i,  isBlocking: true },
  { code: 'MAP-LOC',    group: 'MAPPING',   match: /(location|store|shop).*(not (found|mapped))/i,         isBlocking: true },
  { code: 'IDX-SKIP',   group: 'INDEXING',  match: /skipped|no index|not indexed/i,                         isBlocking: true },
  { code: 'TAX-VERTEX', group: 'NETSUITE',  match: /vertex|tax (calc|service)/i,                            isBlocking: false },
  { code: 'INV-ITEM',   group: 'NETSUITE',  match: /inventory|insufficient|not recognized/i,                isBlocking: false },
  { code: 'NS-PERM',    group: 'NETSUITE',  match: /permission|role|insufficient privilege/i,               isBlocking: false },
  { code: 'VAL-DATA',   group: 'NETSUITE',  match: /INVALID_VALUE|FIELD_PARAM_REQD|unable to parse|Integer field|fulfilled.*delete|otherrefnum|maximum number|required|validation/i,  isBlocking: false },
  { code: 'API-RATE',   group: 'TRANSIENT', match: /rate limit|429|timeout|timed out|Request Failed|UNEXPECTED_ERROR|Record has been changed|someone.*saving|Primary.?Key|NONEXISTENT_ID/i,  isBlocking: false },
  { code: 'DUP',        group: 'TRANSIENT', match: /duplicate|already exists/i,                              isBlocking: false },
  { code: 'CONN-DOWN',  group: 'OUTAGE',    match: /heartbeat|connector offline/i,                           isBlocking: false },
];

function classifyError(text: string): CategoryRule {
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(text)) return rule;
  }
  return CATEGORY_RULES.find(r => r.code === 'VAL-DATA')!;
}

// ── Main import ──
async function importCSV() {
  const csvPath = process.argv[2] || 'C:\\Users\\Lenie\\Downloads\\export (1).csv';
  console.log(`Reading CSV: ${csvPath}`);
  const rows = parseCSV(csvPath);
  console.log(`  ${rows.length} rows found`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing data (in reverse FK order)
    console.log('Clearing existing data...');
    await client.query('DELETE FROM severity_snapshots');
    await client.query('DELETE FROM connector_heartbeats');
    await client.query('DELETE FROM indexing_activity');
    await client.query('DELETE FROM integration_reruns');
    await client.query('DELETE FROM integration_transaction_events');
    await client.query('DELETE FROM integration_errors');
    await client.query('DELETE FROM integration_transactions');
    await client.query('DELETE FROM integration_endpoints');

    // Get system IDs
    const sysRes = await client.query('SELECT id, code FROM systems');
    const systems: Record<string, number> = {};
    for (const r of sysRes.rows) systems[r.code] = r.id;
    console.log(`  Systems: ${Object.keys(systems).join(', ')}`);

    // Get error_categories map
    const catRes = await client.query('SELECT id, code FROM error_categories');
    const categoryMap: Record<string, number> = {};
    for (const r of catRes.rows) categoryMap[r.code] = r.id;
    console.log(`  Error categories: ${Object.keys(categoryMap).join(', ')}`);

    // ── 1. Create endpoints from unique "Endpoint Name" values ──
    console.log('Creating endpoints...');
    const endpointNames = [...new Set(rows.map(r => r['Endpoint Name']).filter(Boolean))];
    const endpointMap: Record<string, number> = {};
    for (let i = 0; i < endpointNames.length; i++) {
      const epName = endpointNames[i];
      const sysId = epName.toLowerCase().includes('shopify') || epName.toLowerCase().includes('sh -')
        ? systems['SHOPIFY']
        : systems['NETSUITE'];
      const direction = epName.toLowerCase().includes('shopify') || epName.toLowerCase().includes('sh -')
        ? 'INBOUND' : 'OUTBOUND';
      const res = await client.query(`
        INSERT INTO integration_endpoints (system_id, endpoint_external_id, endpoint_name, direction)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (system_id, endpoint_external_id) DO UPDATE SET endpoint_name = $3
        RETURNING id
      `, [sysId, `EP-${i + 1}`, epName, direction]);
      endpointMap[epName] = res.rows[0].id;
    }
    console.log(`  Created ${endpointNames.length} endpoints: ${endpointNames.join(', ')}`);

    // ── 2. Build transactions + errors from CSV rows ──
    // Each CSV row is one error occurrence. Group by (Identifier + Endpoint Name)
    // to create transactions, then attach errors.
    console.log('Inserting transactions and errors...');

    // First, collect all rows per unique (identifier, endpointName, date) → transaction
    // Then for each transaction, insert the error.
    const txnIdMap: Record<string, number> = {};
    let txnCount = 0;
    let errCount = 0;

    // Also track all SUCCESS transactions we want to create to have realistic data
    // We'll create successful transactions based on the date range with a ratio
    const allDates = rows.map(r => parseDate(r['Message Date'])).filter(d => !isNaN(d.getTime()));
    const minDate = new Date(Math.min(...allDates.map(d => d.getTime())));
    const maxDate = new Date(Math.max(...allDates.map(d => d.getTime())));
    console.log(`  Date range: ${minDate.toISOString().slice(0, 10)} → ${maxDate.toISOString().slice(0, 10)}`);

    // Insert each error row as a transaction + error
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
      const endpointId = endpointMap[endpointName] || null;

      // Source/destination systems based on endpoint
      const isShopifyEndpoint = endpointName.toLowerCase().includes('shopify') || endpointName.toLowerCase().includes('sh -');
      const srcSystem = isShopifyEndpoint ? systems['SHOPIFY'] : systems['NETSUITE'];
      const dstSystem = isShopifyEndpoint ? systems['NETSUITE'] : systems['SHOPIFY'];

      // Unique key for transaction deduplication
      const txnKey = `${identifier}-${endpointName}-${ts.getTime()}`;

      let txnId = txnIdMap[txnKey];
      if (!txnId) {
        const externalId = `TC-${identifier}-${ts.getTime()}-${txnCount}`;
        try {
          const res = await client.query(`
            INSERT INTO integration_transactions
              (external_id, source_system_id, destination_system_id, endpoint_id,
               flow_code, transaction_type, entity_identifier, sales_order_id,
               normalized_status, created_at, last_error_at, is_rerun)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'FAILED', $9, $9, FALSE)
            ON CONFLICT (external_id) DO NOTHING
            RETURNING id
          `, [
            externalId, srcSystem, dstSystem, endpointId,
            flowCode, txnType, identifier,
            identifier.startsWith('SO') || identifier.startsWith('#D') ? identifier : null,
            ts,
          ]);
          if (res.rows.length > 0) {
            txnId = res.rows[0].id;
            txnIdMap[txnKey] = txnId;
            txnCount++;
          }
        } catch (e: any) {
          if (!e.message.includes('duplicate')) {
            console.error(`  Error inserting txn ${identifier}: ${e.message}`);
          }
          continue;
        }
      }
      if (!txnId) continue;

      // Determine if this error should be resolved:
      // - Errors older than 48h → resolved
      // - Recent errors → stay open (is_current = true)
      const ageHours = (Date.now() - ts.getTime()) / 3600000;
      const resolved = ageHours > 48
        ? new Date(ts.getTime() + (2 + Math.random() * 10) * 3600000)
        : null;

      const categoryId = categoryMap[category.code] || null;

      try {
        await client.query(`
          INSERT INTO integration_errors
            (transaction_id, endpoint_id, error_category_id, error_code, error_group,
             error_message, raw_error, occurred_at, resolved_at,
             is_blocking, is_current)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          txnId, endpointId, categoryId, category.code,
          category.group, errorText.slice(0, 255), errorText, ts,
          resolved, category.isBlocking, !resolved,
        ]);
        errCount++;
      } catch (e: any) {
        console.error(`  Error inserting error for ${identifier}: ${e.message}`);
      }
    }
    console.log(`  Inserted ${txnCount} failed transactions`);
    console.log(`  Inserted ${errCount} errors`);

    // ── 3. Generate synthetic SUCCESS transactions ──
    // Real integrations have many more successes than failures.
    // Create ~15x successful transactions spread across the date range.
    console.log('Generating success transactions...');
    const flowCodes = ['S2N', 'N2S', 'IDX', 'NS'];
    const flowTxnTypes: Record<string, string[]> = {
      S2N: ['Order', 'Sales Order'],
      N2S: ['Draft Order', 'Fulfillment'],
      IDX: ['Customer', 'Item'],
      NS:  ['Sales Order'],
    };
    const flowWeights: Record<string, number> = { S2N: 5, N2S: 4, IDX: 3, NS: 3 };

    let successCount = 0;
    const dayMs = 86400000;
    const totalDays = Math.ceil((maxDate.getTime() - minDate.getTime()) / dayMs) + 1;

    for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
      const dayStart = new Date(minDate.getTime() + dayOffset * dayMs);
      dayStart.setHours(0, 0, 0, 0);

      for (const fc of flowCodes) {
        const txnsPerDay = flowWeights[fc] * (3 + Math.floor(Math.random() * 4));
        const types = flowTxnTypes[fc];

        for (let j = 0; j < txnsPerDay; j++) {
          const hour = 1 + Math.floor(Math.random() * 16); // business hours-ish
          const minute = Math.floor(Math.random() * 60);
          const ts = new Date(dayStart.getTime() + hour * 3600000 + minute * 60000);
          const txType = types[Math.floor(Math.random() * types.length)];

          const prefix = fc === 'S2N' ? '#D' : fc === 'N2S' ? 'SO' : fc === 'IDX' ? 'IDX-' : '#NS';
          const identifier = `${prefix}${20000 + successCount}`;
          const externalId = `TC-OK-${identifier}-${ts.getTime()}`;

          const srcSystem = fc === 'S2N' ? systems['SHOPIFY'] : systems['NETSUITE'];
          const dstSystem = fc === 'S2N' ? systems['NETSUITE'] : systems['SHOPIFY'];

          try {
            await client.query(`
              INSERT INTO integration_transactions
                (external_id, source_system_id, destination_system_id,
                 flow_code, transaction_type, entity_identifier,
                 normalized_status, created_at, processed_at, is_rerun)
              VALUES ($1, $2, $3, $4, $5, $6, 'SUCCESS', $7, $7, FALSE)
              ON CONFLICT (external_id) DO NOTHING
            `, [externalId, srcSystem, dstSystem, fc, txType, identifier, ts]);
            successCount++;
          } catch (e: any) {
            // skip
          }
        }
      }
    }
    console.log(`  Inserted ${successCount} success transactions`);

    // ── 4. Mark re-runs ──
    console.log('Marking re-runs...');
    const rerunRes = await client.query(`
      WITH multi AS (
        SELECT entity_identifier, COUNT(*) AS cnt
        FROM integration_transactions
        WHERE normalized_status = 'FAILED'
        GROUP BY entity_identifier
        HAVING COUNT(*) > 1
      )
      UPDATE integration_transactions t
      SET is_rerun = TRUE
      FROM multi m
      WHERE t.entity_identifier = m.entity_identifier
        AND t.normalized_status = 'FAILED'
        AND t.id NOT IN (
          SELECT MIN(id) FROM integration_transactions
          WHERE entity_identifier = m.entity_identifier AND normalized_status = 'FAILED'
          GROUP BY entity_identifier
        )
    `);
    console.log(`  Marked ${rerunRes.rowCount} transactions as re-runs`);

    // ── 5. Create rerun records ──
    console.log('Creating rerun records...');
    const rerunTxns = await client.query(`
      SELECT id, entity_identifier, sales_order_id, created_at, normalized_status
      FROM integration_transactions WHERE is_rerun = TRUE ORDER BY created_at
    `);
    let rerunCount = 0;
    for (const t of rerunTxns.rows) {
      try {
        await client.query(`
          INSERT INTO integration_reruns
            (transaction_id, sales_order_id, external_rerun_id, started_at, completed_at, status, triggered_by)
          VALUES ($1, $2, $3, $4, $5, $6, 'AUTO')
        `, [t.id, t.sales_order_id, `RERUN-${t.id}`, t.created_at, t.created_at, t.normalized_status]);
        rerunCount++;
      } catch (e: any) { /* skip */ }
    }
    console.log(`  Created ${rerunCount} rerun records`);

    // ── 6. Seed indexing activity from IDX flow ──
    console.log('Seeding indexing activity...');
    const idxTxns = await client.query(`
      SELECT id, entity_identifier, entity_type, created_at, normalized_status
      FROM integration_transactions WHERE flow_code = 'IDX' ORDER BY created_at
    `);
    let idxCount = 0;
    for (const t of idxTxns.rows) {
      try {
        await client.query(`
          INSERT INTO indexing_activity
            (external_id, index_type, record_id, value, status, created_at, completed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [`IDX-${t.id}`, t.entity_type || 'Item', t.entity_identifier,
            t.entity_identifier, t.normalized_status, t.created_at,
            t.normalized_status === 'SUCCESS' ? t.created_at : null]);
        idxCount++;
      } catch (e: any) { /* skip */ }
    }
    console.log(`  Created ${idxCount} indexing records`);

    // ── 7. Seed connector heartbeats (every 5 min for last 24h) ──
    console.log('Seeding heartbeats...');
    const now = new Date();
    let hbCount = 0;
    for (let minAgo = 24 * 60; minAgo >= 0; minAgo -= 5) {
      const hbTime = new Date(now.getTime() - minAgo * 60000);
      await client.query(`
        INSERT INTO connector_heartbeats (system_code, heartbeat_at, status)
        VALUES ('TEAM_CENTRAL', $1, 'OK')
      `, [hbTime]);
      hbCount++;
    }
    console.log(`  Inserted ${hbCount} heartbeats`);

    // ── 8. Severity snapshot ──
    await client.query(`
      INSERT INTO severity_snapshots (evaluated_at, overall_severity, flow_severities)
      VALUES (NOW(), 'SEV_0', '{"S2N": 0, "N2S": 0, "IDX": 0, "NS": 0}')
    `);

    await client.query('COMMIT');

    // Print summary
    const summary = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM integration_transactions) AS transactions,
        (SELECT COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS') FROM integration_transactions) AS succeeded,
        (SELECT COUNT(*) FILTER (WHERE normalized_status = 'FAILED') FROM integration_transactions) AS failed,
        (SELECT COUNT(*) FROM integration_errors) AS errors,
        (SELECT COUNT(*) FILTER (WHERE resolved_at IS NULL) FROM integration_errors) AS open_errors,
        (SELECT COUNT(*) FROM integration_reruns) AS reruns,
        (SELECT COUNT(*) FROM indexing_activity) AS indexing,
        (SELECT COUNT(*) FROM connector_heartbeats) AS heartbeats
    `);
    console.log('\n=== Import complete! ===');
    console.log(summary.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

importCSV().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
