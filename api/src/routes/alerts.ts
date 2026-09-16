import { Router, Request, Response } from 'express';
import pool from '../db';
import { RULES, CATEGORY_RULES, CONTACTS } from '../config';
import { classify, OpenBlockingError } from '../severity';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);
    const endStr = endDatePlus1.toISOString().slice(0, 10);

    // Get current severity state
    const blockingRes = await pool.query<OpenBlockingError>(`
      SELECT error_id, transaction_id, flow_code, entity_identifier,
             error_code, error_message, occurred_at
      FROM v_open_blocking_errors
    `);
    const openBlocking = blockingRes.rows;

    const hbRes = await pool.query(`SELECT heartbeat_at FROM connector_heartbeats ORDER BY heartbeat_at DESC LIMIT 1`);
    const heartbeatAgeMin = hbRes.rows.length
      ? (Date.now() - new Date(hbRes.rows[0].heartbeat_at).getTime()) / 60000
      : 999;

    const tx60Res = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM integration_transactions
      WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '60 minutes'
    `);
    const baseRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM integration_transactions
      WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '28 days'
        AND EXTRACT(DOW FROM created_at) = EXTRACT(DOW FROM NOW())
        AND EXTRACT(HOUR FROM created_at) = EXTRACT(HOUR FROM NOW())
    `);

    const overallSeverity = classify(openBlocking, heartbeatAgeMin, tx60Res.rows[0].cnt, Math.round(baseRes.rows[0].cnt / 4));

    // Build alerts
    const alerts: any[] = [];
    const resolveContacts = (names: string[]) =>
      names.map(n => CONTACTS[n] ? { key: n, ...CONTACTS[n] } : { key: n, name: n, email: '' });

    // Severity alert
    if (overallSeverity > 0) {
      const esc = RULES.escalation[overallSeverity];
      alerts.push({
        level: overallSeverity,
        title: `Integration severity ${overallSeverity}`,
        detail: overallSeverity === 4
          ? 'Connector heartbeat missing / zero throughput'
          : `${openBlocking.length} transaction(s) blocked by mapping / indexing`,
        notify: resolveContacts(esc.notify),
        cc: resolveContacts(esc.cc),
        when: openBlocking.length ? new Date(Math.max(...openBlocking.map(e => new Date(e.occurred_at).getTime()))).toISOString() : now.toISOString(),
        renotifyMinutes: esc.renotifyMinutes,
        ids: openBlocking.map(e => e.entity_identifier),
      });
    }

    // Threshold alerts (from in-range counts)
    const flowCountsRes = await pool.query(`
      SELECT flow_code,
        COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errors,
        COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns
      FROM integration_transactions
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY flow_code
    `, [startDate, endStr]);

    const flowCounts: Record<string, { errors: number; reruns: number }> = {};
    for (const r of flowCountsRes.rows) {
      flowCounts[r.flow_code] = { errors: r.errors, reruns: r.reruns };
    }

    const checks: [string, number, string][] = [
      ['S2N.errors', flowCounts['S2N']?.errors || 0, 'Shopify → NetSuite order errors'],
      ['N2S.errors', flowCounts['N2S']?.errors || 0, 'NetSuite → Shopify draft/order errors'],
      ['S2N.rerun', (flowCounts['S2N']?.reruns || 0) + (flowCounts['N2S']?.reruns || 0) + (flowCounts['IDX']?.reruns || 0), 'SO re-run messages'],
      ['IDX.failed', flowCounts['IDX']?.errors || 0, 'Indexing failures'],
    ];

    // NS category thresholds
    const nsCatRes = await pool.query(`
      SELECT e.error_code, COUNT(*)::int AS cnt
      FROM integration_errors e
      JOIN integration_transactions t ON t.id = e.transaction_id
      WHERE t.flow_code = 'NS' AND e.occurred_at >= $1 AND e.occurred_at < $2
      GROUP BY e.error_code
    `, [startDate, endStr]);
    for (const r of nsCatRes.rows) {
      const thresholdKey = `NS.${r.error_code}`;
      if (RULES.thresholds[thresholdKey]) {
        const rule = CATEGORY_RULES.find(c => c.code === r.error_code);
        checks.push([thresholdKey, r.cnt, `NetSuite: ${rule?.label || r.error_code}`]);
      }
    }

    for (const [key, count, label] of checks) {
      const threshold = RULES.thresholds[key];
      if (threshold && count > threshold) {
        alerts.push({
          level: 0,
          title: `${label} over threshold`,
          detail: `${count} in range vs threshold ${threshold}`,
          notify: resolveContacts(['Larry', 'Quennie']),
          cc: [],
          when: now.toISOString(),
          renotifyMinutes: 240,
          ids: [],
        });
      }
    }

    // Pending SLA check
    const staleRes = await pool.query(`
      SELECT COUNT(*)::int AS cnt, ARRAY_AGG(entity_identifier) AS ids
      FROM integration_transactions
      WHERE normalized_status IN ('PENDING','PROCESSING')
        AND created_at < NOW() - INTERVAL '${RULES.thresholds['pending.unresolvedHours']} hours'
    `);
    if (staleRes.rows[0].cnt > 0) {
      alerts.push({
        level: 0,
        title: 'Pending transactions past SLA',
        detail: `${staleRes.rows[0].cnt} pending longer than ${RULES.thresholds['pending.unresolvedHours']} h`,
        notify: resolveContacts(['Larry', 'Quennie']),
        cc: [],
        when: now.toISOString(),
        renotifyMinutes: 240,
        ids: (staleRes.rows[0].ids || []).slice(0, 10),
      });
    }

    alerts.sort((a, b) => b.level - a.level);

    res.json({ alerts, severity: overallSeverity });
  } catch (err: any) {
    console.error('alerts error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
