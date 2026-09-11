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

// -- CSV parsing (handles quoted fields with commas) --
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

// -- Parse "MM/DD/YYYY, HH:MM:SS AM/PM" date format --
function parseDate(dateStr: string): Date {
  // "09/07/2026, 09:29:21 PM"
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return new Date(dateStr);
  let [, mo, dd, yyyy, hh, mm, ss, ampm] = m;
  let hour = parseInt(hh, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  return new Date(parseInt(yyyy), parseInt(mo) - 1, parseInt(dd), hour, parseInt(mm), parseInt(ss));
}

// -- Map endpoint names to flow codes --
function endpointToFlow(endpointName: string, system: string): string {
  const ep = endpointName.toLowerCase();
  // Shopify → NetSuite direction
  if (ep.includes('save ecomm order') || ep.includes('update work order')) {
    if (system === 'Shopify') return 'S2N'; // Shopify sending orders
    return 'S2N'; // NetSuite receiving/saving eComm orders from Shopify
  }
  if (ep.includes('shopify - read') || ep.includes('sh - update draft') || ep.includes('ns - update draft')) {
    return 'N2S'; // NetSuite → Shopify (draft orders, updates going to Shopify)
  }
  if (ep.includes('netsuite - sales order') || ep.includes('netSuite - sales order')) {
    return 'NS'; // NetSuite internal log (sales order line errors inside NS)
  }
  if (ep.includes('save order fulfillment')) {
    return 'N2S'; // Fulfillments going from NS to Shopify
  }
  if (ep.includes('save items') || ep.includes('index') || ep.includes('save customer') || ep.includes('contact save') || ep.includes('company')) {
    return 'IDX'; // Indexing operations
  }
  if (ep.includes('shopify - company') || ep.includes('shopify - contact') || ep.includes('shopify - price')) {
    return 'IDX'; // Shopify entity indexing
  }
  if (ep.includes('customer save') || ep.includes('company save') || ep.includes('contact save')) {
    return 'IDX';
  }
  // Default based on system
  if (system === 'Shopify') return 'S2N';
  return 'NS';
}

// -- Map endpoint names to transaction types --
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

// -- Classify error text to error category --
interface CategoryRule {
  code: string;
  group: string;
  match: RegExp;
  isBlocking: boolean;
}

const CATEGORY_RULES: CategoryRule[] = [
  { code: 'MAP-CUST',   group: 'MAPPING',   match: /customer.*(not (found|mapped)|missing)/i,              isBlocking: true },
  { code: 'MAP-ITEM',   group: 'MAPPING',   match: /(item|sku).*(not (found|mapped)|invalid)/i,            isBlocking: true },
  { code: 'MAP-SHIP',   group: 'MAPPING',   match: /(ship.?to|address).*(not (found|mapped)|invalid)/i,    isBlocking: true },
  { code: 'MAP-LOC',    group: 'MAPPING',   match: /(location|store|shop).*(not (found|mapped))/i,         isBlocking: true },
  { code: 'IDX-SKIP',   group: 'INDEXING',  match: /skipped|no index|not indexed/i,                         isBlocking: true },
  { code: 'TAX-VERTEX', group: 'NETSUITE',  match: /vertex|tax (calc|service)/i,                            isBlocking: false },
  { code: 'INV-ITEM',   group: 'NETSUITE',  match: /inventory|insufficient|not recognized/i,                isBlocking: false },
  { code: 'NS-PERM',    group: 'NETSUITE',  match: /permission|role|insufficient privilege/i,               isBlocking: false },
  { code: 'VAL-DATA',   group: 'NETSUITE',  match: /required|invalid value|validation/i,                   isBlocking: false },
  { code: 'API-RATE',   group: 'TRANSIENT', match: /rate limit|429|timeout|timed out/i,                     isBlocking: false },
  { code: 'DUP',        group: 'TRANSIENT', match: /duplicate|already exists/i,                              isBlocking: false },
  { code: 'CONN-DOWN',  group: 'OUTAGE',    match: /heartbeat|connector offline/i,                           isBlocking: false },
];

function classifyError(text: string): CategoryRule | null {
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(text)) return rule;
  }
  // Default to VAL-DATA for NetSuite errors that don't match anything specific
  return CATEGORY_RULES.find(r => r.code === 'VAL-DATA')!;
}

// -- Determine normalized status from message log --
function normalizeStatus(errors: number, endpointName: string): string {
  if (errors > 0) return 'FAILED';
  return 'SUCCESS';
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing seed data (in reverse FK order)
    console.log('Clearing existing data...');
    await client.query('DELETE FROM integration_errors');
    await client.query('DELETE FROM integration_reruns');
    await client.query('DELETE FROM integration_transaction_events');
    await client.query('DELETE FROM integration_transactions');
    await client.query('DELETE FROM indexing_activity');
    await client.query('DELETE FROM connector_heartbeats');
    await client.query('DELETE FROM severity_snapshots');

    // Seed integration endpoints from the data
    console.log('Seeding endpoints...');
    const endpointNames = new Set<string>();
    messages.forEach(m => endpointNames.add(m['Transaction Type']));
    errors.forEach(e => endpointNames.add(e['Endpoint Name']));

    // Get system IDs
    const sysRes = await client.query('SELECT id, code FROM systems');
    const systems: Record<string, number> = {};
    for (const r of sysRes.rows) systems[r.code] = r.id;

    // Seed endpoints
    const endpointMap: Record<string, number> = {};
    let epIdx = 0;
    for (const epName of endpointNames) {
      if (!epName) continue;
      epIdx++;
      const sysId = epName.toLowerCase().includes('shopify') ? systems['SHOPIFY'] : systems['NETSUITE'];
      const direction = epName.toLowerCase().includes('shopify') ? 'INBOUND' : 'OUTBOUND';
      const res = await client.query(
        `INSERT INTO integration_endpoints (system_id, endpoint_external_id, endpoint_name, direction)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (system_id, endpoint_external_id) DO UPDATE SET endpoint_name = $3
         RETURNING id`,
        [sysId, `EP-${epIdx}`, epName, direction]
      );
      endpointMap[epName] = res.rows[0].id;
    }

    // Get error_categories map
    const catRes = await client.query('SELECT id, code FROM error_categories');
    const categoryMap: Record<string, number> = {};
    for (const r of catRes.rows) categoryMap[r.code] = r.id;

    // -- Process message logs (main transactions) --
    console.log('Inserting transactions from message logs...');
    // Deduplicate: group by (identifier + transaction type + message date) to handle retries
    // Each row is one transaction attempt
    let txnCount = 0;
    const txnIdMap: Record<string, number> = {}; // external_id -> DB id

    for (const msg of messages) {
      const system = msg['System'] || '';
      const txnType = msg['Transaction Type'] || '';
      const entityType = msg['Entity Type'] || '';
      const identifier = msg['Identifier'] || '';
      const mainKey = msg['Main Key'] || '';
      const processed = parseInt(msg['Processed'] || '0', 10);
      const msgErrors = parseInt(msg['Errors'] || '0', 10);
      const dateStr = msg['Message Date'] || '';

      if (!identifier || !dateStr) continue;

      const ts = parseDate(dateStr);
      const flowCode = endpointToFlow(txnType, system);
      const txType = endpointToTxnType(txnType, entityType);
      const status = normalizeStatus(msgErrors, txnType);

      // Create a unique external_id per row
      const externalId = `TC-${identifier}-${ts.getTime()}`;

      const srcSystem = system === 'Shopify' ? systems['SHOPIFY'] : systems['NETSUITE'];
      const dstSystem = system === 'Shopify' ? systems['NETSUITE'] : systems['SHOPIFY'];

      // Determine if this is a rerun (same identifier appearing multiple times with errors)
      const isRerun = false; // We'll mark reruns in a second pass

      try {
        const res = await client.query(`
          INSERT INTO integration_transactions
            (external_id, source_system_id, destination_system_id, flow_code,
             transaction_type, entity_type, entity_identifier, sales_order_id,
             normalized_status, created_at, processed_at, is_rerun)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (external_id) DO NOTHING
          RETURNING id
        `, [
          externalId, srcSystem, dstSystem, flowCode,
          txType, entityType || null, identifier,
          identifier.startsWith('SO') ? identifier : null,
          status, ts, status === 'SUCCESS' ? ts : null, isRerun,
        ]);

        if (res.rows.length > 0) {
          txnIdMap[externalId] = res.rows[0].id;
          txnCount++;
        }
      } catch (err: any) {
        // Skip duplicates silently
        if (!err.message.includes('duplicate')) {
          console.error(`  Error inserting txn ${identifier}: ${err.message}`);
        }
      }
    }
    console.log(`  Inserted ${txnCount} transactions`);

    // -- Process error logs --
    console.log('Inserting errors from error logs...');
    let errCount = 0;

    for (const err of errors) {
      const endpointName = err['Endpoint Name'] || '';
      const identifier = err['Identifier'] || '';
      const errorText = err['Error Text'] || '';
      const totalErrors = parseInt(err['Total Errors'] || '1', 10);
      const dateStr = err['Message Date'] || '';

      if (!identifier || !dateStr || !errorText) continue;

      const ts = parseDate(dateStr);
      const flowCode = endpointToFlow(endpointName, '');
      const category = classifyError(errorText);

      // Find matching transaction or create one
      const txExternalId = `TC-${identifier}-${ts.getTime()}`;
      let txnId = txnIdMap[txExternalId];

      if (!txnId) {
        // Try to find an existing transaction for this identifier near this time
        const findRes = await client.query(`
          SELECT id FROM integration_transactions
          WHERE entity_identifier = $1
          ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $2::timestamptz)))
          LIMIT 1
        `, [identifier, ts.toISOString()]);

        if (findRes.rows.length > 0) {
          txnId = findRes.rows[0].id;
        } else {
          // Create a transaction for this error
          const txType = endpointToTxnType(endpointName, '');
          const srcSystem = endpointName.toLowerCase().includes('shopify') ? systems['SHOPIFY'] : systems['NETSUITE'];
          const dstSystem = endpointName.toLowerCase().includes('shopify') ? systems['NETSUITE'] : systems['SHOPIFY'];
          const newExternalId = `TC-ERR-${identifier}-${ts.getTime()}`;

          try {
            const res = await client.query(`
              INSERT INTO integration_transactions
                (external_id, source_system_id, destination_system_id, flow_code,
                 transaction_type, entity_identifier, sales_order_id,
                 normalized_status, created_at, last_error_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'FAILED', $8, $8)
              ON CONFLICT (external_id) DO NOTHING
              RETURNING id
            `, [
              newExternalId, srcSystem, dstSystem, flowCode,
              txType, identifier,
              identifier.startsWith('SO') ? identifier : null,
              ts,
            ]);

            if (res.rows.length > 0) {
              txnId = res.rows[0].id;
              txnIdMap[newExternalId] = txnId;
            }
          } catch (e: any) {
            if (!e.message.includes('duplicate')) {
              console.error(`  Error creating txn for error ${identifier}: ${e.message}`);
            }
            continue;
          }
        }
      }

      if (!txnId) continue;

      // Determine if error should be resolved (older errors get resolved, recent ones stay open)
      const ageHours = (Date.now() - ts.getTime()) / 3600000;
      // Errors older than 48h are resolved; some recent ones too (random)
      const resolved = ageHours > 48 ? new Date(ts.getTime() + (2 + Math.random() * 10) * 3600000) : null;

      const categoryId = category ? categoryMap[category.code] : null;

      try {
        await client.query(`
          INSERT INTO integration_errors
            (transaction_id, error_category_id, error_code, error_group,
             error_message, raw_error, occurred_at, resolved_at,
             is_blocking, is_current)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          txnId, categoryId, category?.code || null,
          category?.group || 'NETSUITE',
          errorText.slice(0, 255), errorText, ts,
          resolved, category?.isBlocking || false,
          !resolved, // is_current only if not resolved
        ]);
        errCount++;
      } catch (e: any) {
        console.error(`  Error inserting error for ${identifier}: ${e.message}`);
      }
    }
    console.log(`  Inserted ${errCount} errors`);

    // -- Mark re-runs: transactions with same identifier that appear multiple times with errors --
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

    // -- Insert re-run records for re-run transactions --
    console.log('Creating rerun records...');
    const rerunTxns = await client.query(`
      SELECT id, entity_identifier, sales_order_id, created_at, normalized_status
      FROM integration_transactions
      WHERE is_rerun = TRUE
      ORDER BY created_at
    `);
    let rerunCount = 0;
    for (const t of rerunTxns.rows) {
      try {
        await client.query(`
          INSERT INTO integration_reruns
            (transaction_id, sales_order_id, external_rerun_id, started_at, completed_at,
             status, triggered_by)
          VALUES ($1, $2, $3, $4, $5, $6, 'AUTO')
        `, [
          t.id, t.sales_order_id, `RERUN-${t.id}`,
          t.created_at, t.normalized_status === 'SUCCESS' ? t.created_at : null,
          t.normalized_status,
        ]);
        rerunCount++;
      } catch (e: any) {
        // Skip duplicates
      }
    }
    console.log(`  Created ${rerunCount} rerun records`);

    // -- Seed indexing activity from IDX flow transactions --
    console.log('Seeding indexing activity...');
    const idxTxns = await client.query(`
      SELECT id, entity_identifier, entity_type, created_at, normalized_status
      FROM integration_transactions
      WHERE flow_code = 'IDX'
      ORDER BY created_at
    `);
    let idxCount = 0;
    for (const t of idxTxns.rows) {
      const indexType = t.entity_type || 'Item';
      try {
        await client.query(`
          INSERT INTO indexing_activity
            (external_id, index_type, record_id, value, status, created_at, completed_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          `IDX-${t.id}`, indexType, t.entity_identifier,
          t.entity_identifier, t.normalized_status,
          t.created_at,
          t.normalized_status === 'SUCCESS' ? t.created_at : null,
        ]);
        idxCount++;
      } catch (e: any) {
        // Skip duplicates
      }
    }
    console.log(`  Created ${idxCount} indexing records`);

    // -- Seed connector heartbeats (every 5 min for last 24h, plus a gap for demo) --
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

    // -- Seed a severity snapshot --
    console.log('Seeding severity snapshot...');
    await client.query(`
      INSERT INTO severity_snapshots (evaluated_at, overall_severity, flow_severities)
      VALUES (NOW(), 'SEV_0', '{"S2N": 0, "N2S": 0, "IDX": 0, "NS": 0}')
    `);

    await client.query('COMMIT');
    console.log('\nSeed complete!');

    // Print summary
    const summary = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM integration_transactions) AS transactions,
        (SELECT COUNT(*) FROM integration_errors) AS errors,
        (SELECT COUNT(*) FROM integration_reruns) AS reruns,
        (SELECT COUNT(*) FROM indexing_activity) AS indexing,
        (SELECT COUNT(*) FROM connector_heartbeats) AS heartbeats
    `);
    console.log('Summary:', summary.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
