import { Router, Request, Response } from 'express';
import pool from '../db';
import { FLOWS, RULES } from '../config';
import { classifyFlow, OpenBlockingError } from '../severity';
import { isConfigured } from '../services/netsuite-auth';
import { fetchNSInternalErrors } from '../services/netsuite-sync';

const router = Router();

// GET /api/flows/:code?startDate&endDate
router.get('/:code', async (req: Request, res: Response) => {
  try {
    const flowCode = req.params.code.toUpperCase();
    if (!FLOWS[flowCode]) {
      res.status(404).json({ error: `Unknown flow code: ${flowCode}` });
      return;
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);
    const endStr = endDatePlus1.toISOString().slice(0, 10);

    // KPI stats in range
    // For NS flow, only count transactions whose errors are in the NETSUITE group
    const kpiRes = flowCode === 'NS'
      ? await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS succeeded,
            COUNT(*) FILTER (WHERE normalized_status = 'FAILED'
              AND EXISTS (
                SELECT 1 FROM integration_errors ie
                JOIN error_categories ec2 ON ec2.id = ie.error_category_id
                WHERE ie.transaction_id = integration_transactions.id AND ec2.error_group = 'NETSUITE'
              ))::int AS errored,
            COUNT(*) FILTER (WHERE normalized_status IN ('PENDING','RETRY','PROCESSING'))::int AS pending,
            COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns,
            COUNT(*) FILTER (WHERE is_rerun = TRUE AND normalized_status = 'SUCCESS')::int AS reruns_succeeded
          FROM integration_transactions
          WHERE flow_code = $1 AND created_at >= $2 AND created_at < $3
        `, [flowCode, startDate, endStr])
      : await pool.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS succeeded,
            COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errored,
            COUNT(*) FILTER (WHERE normalized_status IN ('PENDING','RETRY','PROCESSING'))::int AS pending,
            COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns,
            COUNT(*) FILTER (WHERE is_rerun = TRUE AND normalized_status = 'SUCCESS')::int AS reruns_succeeded
          FROM integration_transactions
          WHERE flow_code = $1 AND created_at >= $2 AND created_at < $3
        `, [flowCode, startDate, endStr]);

    // Error categories in range
    // For NS flow, only show NETSUITE-group errors (not integration faults)
    const catRes = flowCode === 'NS'
      ? await pool.query(`
          SELECT
            e.error_code,
            ec.label AS category_label,
            ec.error_group,
            ec.is_blocking,
            COUNT(*)::int AS count
          FROM integration_errors e
          JOIN integration_transactions t ON t.id = e.transaction_id
          LEFT JOIN error_categories ec ON ec.id = e.error_category_id
          WHERE t.flow_code = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3
            AND ec.error_group = 'NETSUITE'
          GROUP BY e.error_code, ec.label, ec.error_group, ec.is_blocking
          ORDER BY count DESC
        `, [flowCode, startDate, endStr])
      : await pool.query(`
          SELECT
            e.error_code,
            ec.label AS category_label,
            ec.error_group,
            ec.is_blocking,
            COUNT(*)::int AS count
          FROM integration_errors e
          JOIN integration_transactions t ON t.id = e.transaction_id
          LEFT JOIN error_categories ec ON ec.id = e.error_category_id
          WHERE t.flow_code = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3
          GROUP BY e.error_code, ec.label, ec.error_group, ec.is_blocking
          ORDER BY count DESC
        `, [flowCode, startDate, endStr]);

    // Daily breakdown (last 10 days within range)
    const dailyRes = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS ok,
        COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errors,
        COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns
      FROM integration_transactions
      WHERE flow_code = $1 AND created_at >= $2 AND created_at < $3
      GROUP BY day
      ORDER BY day DESC
      LIMIT 10
    `, [flowCode, startDate, endStr]);

    // Open incidents (regardless of range)
    // For NS flow, only show NETSUITE-group errors (not integration faults)
    const openRes = flowCode === 'NS'
      ? await pool.query(`
          SELECT
            e.id AS error_id,
            t.entity_identifier,
            t.transaction_type,
            e.error_code,
            ec.label AS category_label,
            ec.error_group,
            ec.is_blocking,
            e.error_message,
            e.occurred_at,
            EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS age_minutes
          FROM integration_errors e
          JOIN integration_transactions t ON t.id = e.transaction_id
          LEFT JOIN error_categories ec ON ec.id = e.error_category_id
          WHERE t.flow_code = $1 AND e.resolved_at IS NULL AND e.is_current = TRUE
            AND ec.error_group = 'NETSUITE'
          ORDER BY e.occurred_at DESC
        `, [flowCode])
      : await pool.query(`
          SELECT
            e.id AS error_id,
            t.entity_identifier,
            t.transaction_type,
            e.error_code,
            ec.label AS category_label,
            ec.error_group,
            ec.is_blocking,
            e.error_message,
            e.occurred_at,
            EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS age_minutes
          FROM integration_errors e
          JOIN integration_transactions t ON t.id = e.transaction_id
          LEFT JOIN error_categories ec ON ec.id = e.error_category_id
          WHERE t.flow_code = $1 AND e.resolved_at IS NULL AND e.is_current = TRUE
          ORDER BY e.occurred_at DESC
        `, [flowCode]);

    // Sparkline: errors per day, last 14 days
    const sparkRes = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS d,
        COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errors
      FROM integration_transactions
      WHERE flow_code = $1 AND created_at >= (CURRENT_DATE - INTERVAL '13 days')
      GROUP BY d ORDER BY d
    `, [flowCode]);
    const sparkline: number[] = [];
    for (let d = 13; d >= 0; d--) {
      const day = new Date(); day.setDate(day.getDate() - d);
      const dayStr = day.toISOString().slice(0, 10);
      const row = sparkRes.rows.find(r => r.d?.toISOString?.()?.slice(0, 10) === dayStr);
      sparkline.push(row?.errors || 0);
    }

    // Per-flow severity
    const blockingRes = await pool.query<OpenBlockingError>(`
      SELECT error_id, transaction_id, flow_code, entity_identifier,
             error_code, error_message, occurred_at
      FROM v_open_blocking_errors WHERE flow_code = $1
    `, [flowCode]);
    const hbRes = await pool.query(`SELECT heartbeat_at FROM connector_heartbeats ORDER BY heartbeat_at DESC LIMIT 1`);
    const heartbeatAgeMin = hbRes.rows.length
      ? (Date.now() - new Date(hbRes.rows[0].heartbeat_at).getTime()) / 60000
      : 999;
    const severity = classifyFlow(blockingRes.rows, heartbeatAgeMin, flowCode);

    const kpi = kpiRes.rows[0];
    const successRate = kpi.total > 0 ? ((kpi.succeeded / kpi.total) * 100).toFixed(1) : '—';

    // For the NS flow, merge live NetSuite Vertex data if credentials are configured
    let nsInternalData = null;
    if (flowCode === 'NS' && isConfigured()) {
      try {
        nsInternalData = await fetchNSInternalErrors(startDate, endDate);

        // Merge Vertex counts from NetSuite into KPIs
        const vtx = nsInternalData.vertex;
        kpi.total += vtx.total;
        kpi.succeeded += vtx.passed;
        kpi.errored += vtx.failed;

        // Add Vertex failures from NetSuite to open incidents if they don't overlap
        const localErrorTxnIds = new Set(openRes.rows.map((r: any) => String(r.entity_identifier)));
        for (const err of vtx.errors) {
          if (!localErrorTxnIds.has(String(err.transaction_id))) {
            openRes.rows.push({
              error_id: `ns-vtx-${err.id}`,
              entity_identifier: err.transaction_id,
              transaction_type: 'Sales Order',
              error_code: err.error_code,
              category_label: err.category_label,
              error_group: err.error_group,
              is_blocking: false,
              error_message: err.error_message,
              occurred_at: err.occurred_at,
              age_minutes: 0,
              source: 'netsuite_direct',
            });
          }
        }

        // Merge Vertex category into categories list
        if (vtx.failed > 0) {
          const existingVtx = catRes.rows.find((c: any) => c.error_code === 'TAX-VERTEX');
          if (existingVtx) {
            existingVtx.count += vtx.failed;
            existingVtx.netsuite_direct_count = vtx.failed;
          } else {
            catRes.rows.push({
              error_code: 'TAX-VERTEX',
              category_label: 'Vertex tax calculation failed',
              error_group: 'NETSUITE',
              is_blocking: false,
              count: vtx.failed,
              netsuite_direct_count: vtx.failed,
            });
          }
          catRes.rows.sort((a: any, b: any) => b.count - a.count);
        }
      } catch (err: any) {
        console.error('Failed to fetch NS internal errors from NetSuite:', err.message);
      }
    }

    // For the IDX flow, show "indexing needs" — MAP-* errors across all flows
    // that indicate which objects need to be indexed (customer, item, ship-to, location)
    let indexingNeeds = null;
    if (flowCode === 'IDX') {
      const needsSummaryRes = await pool.query(`
        SELECT
          e.error_code,
          ec.label AS category_label,
          COUNT(*)::int AS error_count,
          COUNT(DISTINCT t.entity_identifier)::int AS order_count
        FROM integration_errors e
        JOIN integration_transactions t ON t.id = e.transaction_id
        LEFT JOIN error_categories ec ON ec.id = e.error_category_id
        WHERE e.error_code IN ('MAP-CUST', 'MAP-ITEM', 'MAP-SHIP', 'MAP-LOC')
          AND e.occurred_at >= $1 AND e.occurred_at < $2
        GROUP BY e.error_code, ec.label
        ORDER BY error_count DESC
      `, [startDate, endStr]);

      const needsOrdersRes = await pool.query(`
        SELECT
          t.entity_identifier,
          t.transaction_type,
          e.error_code,
          ec.label AS category_label,
          e.error_message,
          e.occurred_at,
          EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS age_minutes
        FROM integration_errors e
        JOIN integration_transactions t ON t.id = e.transaction_id
        LEFT JOIN error_categories ec ON ec.id = e.error_category_id
        WHERE e.error_code IN ('MAP-CUST', 'MAP-ITEM', 'MAP-SHIP', 'MAP-LOC')
          AND e.resolved_at IS NULL AND e.is_current = TRUE
        ORDER BY e.occurred_at DESC
      `);

      indexingNeeds = {
        summary: needsSummaryRes.rows,
        totalErrors: needsSummaryRes.rows.reduce((s: number, r: any) => s + r.error_count, 0),
        totalOrders: needsSummaryRes.rows.reduce((s: number, r: any) => s + r.order_count, 0),
        openOrders: needsOrdersRes.rows,
      };
    }

    res.json({
      flowCode,
      ...FLOWS[flowCode],
      severity,
      kpi: { ...kpi, successRate: kpi.total > 0 ? ((kpi.succeeded / kpi.total) * 100).toFixed(1) : '—' },
      categories: catRes.rows,
      daily: dailyRes.rows,
      openIncidents: openRes.rows,
      sparkline,
      ...(indexingNeeds ? { indexingNeeds } : {}),
      ...(nsInternalData ? { nsDirectSource: nsInternalData.source, nsVertexCounts: nsInternalData.vertex } : {}),
    });
  } catch (err: any) {
    console.error('flows error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
