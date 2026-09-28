import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { FLOWS } from '../config';
import { getRules, getContacts } from '../services/settings-store';
import { classify, classifyFlow } from '../severity';
import {
  toOpenBlockingErrors, indexById, groupByFlow, computeFlowCardStats,
  computeTxLast60, computeBaselineLast60, computeErrorSparkline, computeFlowErrorResolution,
} from '../store/aggregate';

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
    const store = getStore();
    const RULES = getRules();
    const CONTACTS = getContacts();
    const now = new Date();
    const { startDate, endDate } = parseDates(req);
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);

    // 1. Open blocking errors, scoped to the selected date range by occurred_at
    const openErrors = await store.getOpenErrors();
    const openErrTransactions = await Promise.all(
      [...new Set(openErrors.map(e => e.transaction_id))].map(id => store.getTransactionById(id)),
    );
    const openErrTxById = indexById(openErrTransactions.filter((t): t is NonNullable<typeof t> => !!t));
    const rangeStartMs = new Date(startDate).getTime();
    const rangeEndMs = endDatePlus1.getTime();
    const openBlocking = toOpenBlockingErrors(openErrors, openErrTxById).filter(e => {
      const t = new Date(e.occurred_at).getTime();
      return t >= rangeStartMs && t < rangeEndMs;
    });

    // 2. Latest heartbeat
    const hb = await store.getLatestHeartbeat();
    const heartbeatAgeMin = hb ? (Date.now() - new Date(hb.heartbeat_at).getTime()) / 60000 : 999;

    // 3 & 4. Transactions in last 60 min + 28-day baseline (one query covers both)
    const last28d = await store.queryTransactions({ start: new Date(now.getTime() - 28 * 86400000), end: new Date(now.getTime() + 1000) });
    const txLast60 = computeTxLast60(last28d, now);
    const baselineLast60 = computeBaselineLast60(last28d, now);

    // 5. Compute overall severity
    const overallSeverity = classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60);

    // 6. Per-flow severity
    const perFlowSeverity: Record<string, number> = {};
    for (const f of Object.keys(FLOWS)) {
      const flowBlocking = openBlocking.filter(e => e.flow_code === f);
      perFlowSeverity[f] = classifyFlow(flowBlocking, heartbeatAgeMin, f);
    }

    // 7. Flow card stats (in range)
    const rangeTransactions = await store.queryTransactions({ start: new Date(startDate), end: endDatePlus1 });
    const flowStatsByFlow = groupByFlow(rangeTransactions, computeFlowCardStats);

    const rangeErrors = await store.queryErrors({ start: new Date(startDate), end: endDatePlus1 });
    const rangeErrTransactions = await Promise.all(
      [...new Set(rangeErrors.map(e => e.transaction_id))].map(id => store.getTransactionById(id)),
    );
    const rangeErrTxById = indexById(rangeErrTransactions.filter((t): t is NonNullable<typeof t> => !!t));
    const flowErrorResolution = computeFlowErrorResolution(rangeErrors, rangeErrTxById);

    const flowStats: Record<string, any> = {};
    for (const f of Object.keys(FLOWS)) {
      const stats = flowStatsByFlow[f];
      const resolution = flowErrorResolution[f];
      flowStats[f] = {
        ...FLOWS[f],
        severity: perFlowSeverity[f],
        total: stats?.total || 0,
        succeeded: stats?.succeeded || 0,
        errored: stats?.errored || 0,
        resolved: resolution?.resolved || 0,
        open_errors: resolution?.open || 0,
        pending_rerun: stats?.pending_rerun || 0,
        reruns: stats?.reruns || 0,
      };
    }

    // 8. Sparkline data: errors per day per flow, last 14 days
    const last14ByFlow = groupByFlow(
      last28d.filter(t => new Date(t.created_at).getTime() >= now.getTime() - 13 * 86400000),
      (rows) => rows,
    );
    const sparklines: Record<string, number[]> = {};
    for (const f of Object.keys(FLOWS)) {
      sparklines[f] = computeErrorSparkline(last14ByFlow[f] || [], 14);
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
      openBlocking,
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
