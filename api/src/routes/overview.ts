import { Router, Request, Response } from 'express';
import pool from '../db';
import { FLOWS, RULES, CONTACTS } from '../config';
import { classify, classifyFlow, OpenBlockingError, startOfToday } from '../severity';

const router = Router();

function parseDates(req: Request): { startDate: string; endDate: string } {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  return {
    startDate: (req.query.startDate as string) || todayStr,
    endDate: (req.query.endDate as string) || todayStr,
  };
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = parseDates(req);
    // Add 1 day to endDate for < comparison (inclusive end)
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);
    const endStr = endDatePlus1.toISOString().slice(0, 10);

    // 1. Open blocking errors (for severity computation - always "now", not range-filtered)
    const blockingRes = await pool.query<OpenBlockingError>(`
      SELECT error_id, transaction_id, flow_code, entity_identifier,
             error_code, error_message, occurred_at
      FROM v_open_blocking_errors
    `);
    const openBlocking = blockingRes.rows;

    // 2. Latest heartbeat
    const hbRes = await pool.query(`
      SELECT heartbeat_at FROM connector_heartbeats
      ORDER BY heartbeat_at DESC LIMIT 1
    `);
    const heartbeatAgeMin = hbRes.rows.length
      ? (Date.now() - new Date(hbRes.rows[0].heartbeat_at).getTime()) / 60000
      : 999;

    // 3. Transactions in last 60 min (for sev4 zero-traffic check)
    const tx60Res = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM integration_transactions
      WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '60 minutes'
    `);
    const txLast60 = tx60Res.rows[0].cnt;

    // 4. Baseline (4-week average for this hour on this weekday)
    const baseRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM integration_transactions
      WHERE flow_code != 'NS'
        AND created_at > NOW() - INTERVAL '28 days'
        AND EXTRACT(DOW FROM created_at) = EXTRACT(DOW FROM NOW())
        AND EXTRACT(HOUR FROM created_at) = EXTRACT(HOUR FROM NOW())
    `);
    const baselineLast60 = Math.round(baseRes.rows[0].cnt / 4);

    // 5. Compute overall severity
    const overallSeverity = classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60);

    // 6. Per-flow severity
    const perFlowSeverity: Record<string, number> = {};
    for (const f of Object.keys(FLOWS)) {
      const flowBlocking = openBlocking.filter(e => e.flow_code === f);
      perFlowSeverity[f] = classifyFlow(flowBlocking, heartbeatAgeMin, f);
    }

    // 7. Flow card stats (in range)
    const flowStatsRes = await pool.query(`
      SELECT flow_code,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS succeeded,
        COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errored,
        COUNT(*) FILTER (WHERE normalized_status IN ('PENDING','RETRY','PROCESSING'))::int AS pending_rerun,
        COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns
      FROM integration_transactions
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY flow_code
    `, [startDate, endStr]);

    const flowStats: Record<string, any> = {};
    for (const f of Object.keys(FLOWS)) {
      const row = flowStatsRes.rows.find(r => r.flow_code === f);
      flowStats[f] = {
        ...FLOWS[f],
        severity: perFlowSeverity[f],
        total: row?.total || 0,
        succeeded: row?.succeeded || 0,
        errored: row?.errored || 0,
        pending_rerun: row?.pending_rerun || 0,
        reruns: row?.reruns || 0,
      };
    }

    // 8. Sparkline data: errors per day per flow, last 14 days
    const sparkRes = await pool.query(`
      SELECT flow_code,
        DATE(created_at AT TIME ZONE 'UTC') AS d,
        COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errors
      FROM integration_transactions
      WHERE created_at >= (CURRENT_DATE - INTERVAL '13 days')
      GROUP BY flow_code, DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY d
    `);
    const sparklines: Record<string, number[]> = {};
    for (const f of Object.keys(FLOWS)) {
      const pts: number[] = [];
      for (let d = 13; d >= 0; d--) {
        const day = new Date();
        day.setDate(day.getDate() - d);
        const dayStr = day.toISOString().slice(0, 10);
        const row = sparkRes.rows.find(r => r.flow_code === f && r.d?.toISOString?.()?.slice(0, 10) === dayStr);
        pts.push(row?.errors || 0);
      }
      sparklines[f] = pts;
    }

    // 9. Escalation info (resolve contact names to full name + email)
    const resolveContacts = (names: string[]) =>
      names.map(n => CONTACTS[n] ? { key: n, ...CONTACTS[n] } : { key: n, name: n, email: '' });
    const rawEsc = overallSeverity > 0 ? RULES.escalation[overallSeverity] : null;
    const escalation = rawEsc ? {
      notify: resolveContacts(rawEsc.notify),
      cc: resolveContacts(rawEsc.cc),
      renotifyMinutes: rawEsc.renotifyMinutes,
    } : null;

    res.json({
      severity: overallSeverity,
      heartbeatAgeMin: Math.round(heartbeatAgeMin),
      txLast60,
      baselineLast60,
      openBlockingCount: openBlocking.length,
      openBlocking: openBlocking.map(e => ({
        ...e,
        occurred_at: e.occurred_at,
      })),
      perFlowSeverity,
      flowStats,
      sparklines,
      escalation,
      startDate,
      endDate,
    });
  } catch (err: any) {
    console.error('overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
