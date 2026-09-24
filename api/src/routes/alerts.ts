import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { getRules, getCategoryRules, getContacts } from '../services/settings-store';
import { classify } from '../severity';
import {
  indexById, toOpenBlockingErrors, computeTxLast60, computeBaselineLast60,
  computeThresholdFlowCounts, computeNsCategoryCounts, computeStalePending, errorsForFlow,
} from '../store/aggregate';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const store = getStore();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);

    // Current severity state
    const openErrors = await store.getOpenErrors();
    const openTx = await Promise.all(
      [...new Set(openErrors.map(e => e.transaction_id))].map(id => store.getTransactionById(id)),
    );
    const openTxById = indexById(openTx.filter((t): t is NonNullable<typeof t> => !!t));
    const openBlocking = toOpenBlockingErrors(openErrors, openTxById);

    const hb = await store.getLatestHeartbeat();
    const heartbeatAgeMin = hb ? (Date.now() - new Date(hb.heartbeat_at).getTime()) / 60000 : 999;

    const last28d = await store.queryTransactions({ start: new Date(now.getTime() - 28 * 86400000), end: new Date(now.getTime() + 1000) });
    const txLast60 = computeTxLast60(last28d, now);
    const baselineLast60 = computeBaselineLast60(last28d, now);

    const overallSeverity = classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60);

    const RULES = getRules();
    const CONTACTS = getContacts();
    const CATEGORY_RULES = getCategoryRules();

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
    const rangeTransactions = await store.queryTransactions({ start: new Date(startDate), end: endDatePlus1 });
    const flowCounts = computeThresholdFlowCounts(rangeTransactions);

    const checks: [string, number, string][] = [
      ['S2N.errors', flowCounts['S2N']?.errors || 0, 'Shopify → NetSuite order errors'],
      ['N2S.errors', flowCounts['N2S']?.errors || 0, 'NetSuite → Shopify draft/order errors'],
      ['S2N.rerun', (flowCounts['S2N']?.reruns || 0) + (flowCounts['N2S']?.reruns || 0) + (flowCounts['IDX']?.reruns || 0), 'SO re-run messages'],
      ['IDX.failed', flowCounts['IDX']?.errors || 0, 'Indexing failures'],
    ];

    // NS category thresholds
    const rangeErrors = await store.queryErrors({ start: new Date(startDate), end: endDatePlus1 });
    const rangeTxById = indexById(rangeTransactions);
    const nsErrors = errorsForFlow(rangeErrors, rangeTxById, 'NS');
    const nsCounts = computeNsCategoryCounts(nsErrors);
    for (const [code, cnt] of Object.entries(nsCounts)) {
      const thresholdKey = `NS.${code}`;
      if (RULES.thresholds[thresholdKey]) {
        const rule = CATEGORY_RULES.find(c => c.code === code);
        checks.push([thresholdKey, cnt, `NetSuite: ${rule?.label || code}`]);
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

    // Pending SLA check — unbounded, via the maintained pending-transactions index
    // (not a date-range scan), so a transaction stuck for a long time keeps alerting.
    const pendingHours = RULES.thresholds['pending.unresolvedHours'];
    const allPending = await store.getPendingTransactions();
    const stale = computeStalePending(allPending, pendingHours, now);
    if (stale.count > 0) {
      alerts.push({
        level: 0,
        title: 'Pending transactions past SLA',
        detail: `${stale.count} pending longer than ${pendingHours} h`,
        notify: resolveContacts(['Larry', 'Quennie']),
        cc: [],
        when: now.toISOString(),
        renotifyMinutes: 240,
        ids: stale.ids.slice(0, 10),
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
