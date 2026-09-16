import pool from '../db';
import { suiteQL, getRecord } from './netsuite-client';
import { isConfigured } from './netsuite-auth';

interface SyncState {
  running: boolean;
  lastSyncAt: string | null;
  lastSyncRecords: number;
  lastSyncErrors: string[];
}

const state: SyncState = {
  running: false,
  lastSyncAt: null,
  lastSyncRecords: 0,
  lastSyncErrors: [],
};

/**
 * Sync recent orders: find local records with sales_order_id LIKE 'SO%'
 * that lack NetSuite data, query NetSuite in batches, and store enrichment.
 */
export async function syncRecentOrders(): Promise<{
  synced: number;
  skipped: number;
  errors: string[];
}> {
  if (state.running) {
    return { synced: 0, skipped: 0, errors: ['Sync already in progress'] };
  }

  if (!isConfigured()) {
    return { synced: 0, skipped: 0, errors: ['NetSuite credentials not configured'] };
  }

  state.running = true;
  state.lastSyncErrors = [];

  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    // Find local records that need enrichment
    const localResult = await pool.query(`
      SELECT id, sales_order_id
      FROM integration_transactions
      WHERE sales_order_id LIKE 'SO%'
        AND netsuite_record_id IS NULL
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const records = localResult.rows;
    if (records.length === 0) {
      state.running = false;
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncRecords = 0;
      return { synced: 0, skipped: 0, errors: [] };
    }

    // Process in batches of 50
    const batchSize = 50;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const soIds = batch.map((r: any) => r.sales_order_id);

      try {
        // Build SuiteQL IN clause
        const inList = soIds.map((id: string) => `'${id.replace(/'/g, "''")}'`).join(', ');
        const query = `
          SELECT
            t.id AS internalid,
            t.tranid,
            t.status,
            t.foreigntotal AS total,
            t.trandate,
            c.companyname AS customer_name,
            c.entityid AS customer_id
          FROM transaction t
          LEFT JOIN customer c ON c.id = t.entity
          WHERE t.tranid IN (${inList})
            AND t.type = 'SalesOrd'
        `;

        const nsResult = await suiteQL(query, batchSize, 0);

        // Build lookup map from NetSuite results
        const nsMap = new Map<string, Record<string, any>>();
        for (const item of nsResult.items) {
          if (item.tranid) {
            nsMap.set(item.tranid, item);
          }
        }

        // Update local records with enrichment data
        for (const record of batch) {
          const nsData = nsMap.get(record.sales_order_id);
          if (!nsData) {
            skipped++;
            continue;
          }

          try {
            const enrichment = {
              netsuite_customer_name: nsData.customer_name || null,
              netsuite_customer_id: nsData.customer_id || null,
              netsuite_amount: nsData.total || null,
              netsuite_status: nsData.status || null,
              netsuite_tran_date: nsData.trandate || null,
              netsuite_synced_at: new Date().toISOString(),
            };

            await pool.query(
              `UPDATE integration_transactions
               SET netsuite_record_type = 'salesorder',
                   netsuite_record_id = $1,
                   raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb,
                   updated_at = NOW()
               WHERE id = $3`,
              [
                String(nsData.internalid),
                JSON.stringify(enrichment),
                record.id,
              ],
            );
            synced++;
          } catch (err: any) {
            errors.push(`Failed to update record ${record.id}: ${err.message}`);
          }
        }
      } catch (err: any) {
        errors.push(`Batch query failed (offset ${i}): ${err.message}`);
      }
    }
  } catch (err: any) {
    errors.push(`Sync failed: ${err.message}`);
  } finally {
    state.running = false;
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncRecords = synced;
    state.lastSyncErrors = errors;
  }

  return { synced, skipped, errors };
}

/**
 * Get combined local + live NetSuite data for a single sales order,
 * plus related errors and reruns.
 */
export async function fetchOrderDetail(salesOrderId: string): Promise<{
  local: Record<string, any> | null;
  netsuite: Record<string, any> | null;
  errors: Record<string, any>[];
  reruns: Record<string, any>[];
}> {
  // Get local record
  const localResult = await pool.query(
    `SELECT * FROM integration_transactions WHERE sales_order_id = $1 LIMIT 1`,
    [salesOrderId],
  );
  const local = localResult.rows[0] || null;

  // Get related errors
  const errorsResult = local
    ? await pool.query(
        `SELECT e.*, ec.label AS category_label, ec.error_group
         FROM integration_errors e
         LEFT JOIN error_categories ec ON ec.id = e.error_category_id
         WHERE e.transaction_id = $1
         ORDER BY e.occurred_at DESC`,
        [local.id],
      )
    : { rows: [] };

  // Get related reruns
  const rerunsResult = local
    ? await pool.query(
        `SELECT * FROM integration_reruns
         WHERE transaction_id = $1
         ORDER BY started_at DESC`,
        [local.id],
      )
    : { rows: [] };

  // Attempt live NetSuite lookup if we have the internal ID
  let netsuite: Record<string, any> | null = null;
  if (local?.netsuite_record_id && isConfigured()) {
    try {
      netsuite = await getRecord('salesOrder', local.netsuite_record_id);
    } catch (err: any) {
      netsuite = { error: err.message };
    }
  }

  return {
    local,
    netsuite,
    errors: errorsResult.rows,
    reruns: rerunsResult.rows,
  };
}

/**
 * Pull NetSuite internal errors directly from NetSuite.
 * Queries the Vertex API Call Details custom record for failures,
 * and returns them in a format the NS internal panel can use.
 */
export async function fetchNSInternalErrors(startDate?: string, endDate?: string): Promise<{
  vertex: { total: number; passed: number; failed: number; errors: Record<string, any>[] };
  source: string;
}> {
  if (!isConfigured()) {
    return {
      vertex: { total: 0, passed: 0, failed: 0, errors: [] },
      source: 'not_configured',
    };
  }

  try {
    // Query Vertex API Call Details for all records in date range
    // SuiteQL on custom records requires LIKE for string comparisons
    // and BUILTIN.DF for date field filtering
    let dateFilter = '';
    if (startDate) {
      // Convert YYYY-MM-DD to M/D/YYYY for NetSuite BUILTIN.DF
      const sd = new Date(startDate);
      const sdStr = `${sd.getUTCMonth() + 1}/${sd.getUTCDate()}/${sd.getUTCFullYear()}`;
      dateFilter += ` AND BUILTIN.DF(created) >= '${sdStr}'`;
    }
    if (endDate) {
      const ed = new Date(endDate);
      const edStr = `${ed.getUTCMonth() + 1}/${ed.getUTCDate()}/${ed.getUTCFullYear()}`;
      dateFilter += ` AND BUILTIN.DF(created) <= '${edStr}'`;
    }

    // Run three simple counts in parallel (SuiteQL doesn't support SUM+CASE with LIKE)
    const baseWhere = `custrecord_transaction_type_vt = 'salesorder'${dateFilter}`;
    const [totalRes, passedRes, failedRes] = await Promise.all([
      suiteQL(`SELECT COUNT(id) AS cnt FROM CUSTOMRECORD_CALL_DETAILS_VT WHERE ${baseWhere}`, 1, 0),
      suiteQL(`SELECT COUNT(id) AS cnt FROM CUSTOMRECORD_CALL_DETAILS_VT WHERE ${baseWhere} AND custrecord_tax_result_vt LIKE 'Success'`, 1, 0),
      suiteQL(`SELECT COUNT(id) AS cnt FROM CUSTOMRECORD_CALL_DETAILS_VT WHERE ${baseWhere} AND custrecord_tax_result_vt NOT LIKE 'Success'`, 1, 0),
    ]);

    const counts = {
      total: totalRes.items[0]?.cnt || '0',
      passed: passedRes.items[0]?.cnt || '0',
      failed: failedRes.items[0]?.cnt || '0',
    };

    // Fetch the actual failure details
    const errorQuery = `
      SELECT
        id,
        custrecord_tax_result_vt AS tax_result,
        custrecord_transaction_internalid_vt AS transaction_id,
        custrecord_transaction_type_vt AS transaction_type,
        created
      FROM CUSTOMRECORD_CALL_DETAILS_VT
      WHERE ${baseWhere}
        AND custrecord_tax_result_vt NOT LIKE 'Success'
      ORDER BY id DESC
      FETCH FIRST 100 ROWS ONLY
    `;

    const errorResult = await suiteQL(errorQuery, 100, 0);

    // Parse the error message from the tax_result field
    const errors = errorResult.items.map((item: any) => {
      let errorMessage = 'Vertex tax calculation failed';
      const result = item.tax_result || '';
      // Extract faultstring from the SOAP error if present
      const faultMatch = result.match(/<faultstring[^>]*>([^<]+)<\/faultstring>/);
      if (faultMatch) {
        errorMessage = faultMatch[1];
      }

      return {
        id: item.id,
        transaction_id: item.transaction_id,
        transaction_type: item.transaction_type,
        error_message: errorMessage,
        raw_error: result.length > 500 ? result.substring(0, 500) + '...' : result,
        occurred_at: item.created,
        error_code: 'TAX-VERTEX',
        category_label: 'Vertex tax calculation failed',
        error_group: 'NETSUITE',
        is_blocking: false,
        source: 'netsuite_direct',
      };
    });

    return {
      vertex: {
        total: parseInt(counts.total) || 0,
        passed: parseInt(counts.passed) || 0,
        failed: parseInt(counts.failed) || 0,
        errors,
      },
      source: 'netsuite_direct',
    };
  } catch (err: any) {
    console.error('fetchNSInternalErrors error:', err.message);
    return {
      vertex: { total: 0, passed: 0, failed: 0, errors: [] },
      source: `error: ${err.message}`,
    };
  }
}

/**
 * Return current sync status.
 */
export async function getSyncStatus(): Promise<{
  configured: boolean;
  running: boolean;
  lastSyncAt: string | null;
  lastSyncRecords: number;
  lastSyncErrors: string[];
  pendingCount: number;
  enrichedCount: number;
}> {
  const configured = isConfigured();

  // Count records that could be synced vs already enriched
  const pendingResult = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM integration_transactions
    WHERE sales_order_id LIKE 'SO%' AND netsuite_record_id IS NULL
  `);

  const enrichedResult = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM integration_transactions
    WHERE sales_order_id LIKE 'SO%' AND netsuite_record_id IS NOT NULL
  `);

  return {
    configured,
    running: state.running,
    lastSyncAt: state.lastSyncAt,
    lastSyncRecords: state.lastSyncRecords,
    lastSyncErrors: state.lastSyncErrors,
    pendingCount: pendingResult.rows[0]?.count || 0,
    enrichedCount: enrichedResult.rows[0]?.count || 0,
  };
}
