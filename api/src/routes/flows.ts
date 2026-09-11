import { Router, Request, Response } from 'express';
import pool from '../db';
import { FLOWS, RULES } from '../config';
import { classifyFlow, OpenBlockingError } from '../severity';

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
    const kpiRes = await pool.query(`
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
    const catRes = await pool.query(`
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
    const openRes = await pool.query(`
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

    res.json({
      flowCode,
      ...FLOWS[flowCode],
      severity,
      kpi: { ...kpi, successRate },
      categories: catRes.rows,
      daily: dailyRes.rows,
      openIncidents: openRes.rows,
      sparkline,
    });
  } catch (err: any) {
    console.error('flows error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
