import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { FLOWS } from '../config';
import { getRules, getContacts } from '../services/settings-store';
import { classify, classifyFlow } from '../severity';
import {
  toOpenBlockingErrors, indexById, groupByFlow, computeFlowCardStats,
  computeTxLast60, computeBaselineLast60, computeErrorSparkline, computeFlowErrorResolution,
} from '../store/aggregate';
import { fetchDraftsByDateRange, isConfigured as shopifyConfigured } from '../services/shopify-client';
import { fetchSalesOrders } from '../services/netsuite-sync';
import { isConfigured as netsuiteConfigured } from '../services/netsuite-auth';

const router = Router();

function parseDates(req: Request): { startDate: string; endDate: string } {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  return {
    startDate: (req.query.startDate as string) || todayStr,
    endDate: (req.query.endDate as string) || todayStr,
  };
}

// Order Sync card — follows each Shopify draft created in the range through both legs:
//   draft → NetSuite SO (SO memo = draft #) → SO marked integration ready → Shopify order exists.
// Ready + Shopify order = resolved; no SO, or ready without a Shopify order = error;
// otherwise (not ready yet, or too new to judge) = pending. Cached briefly since the overview auto-refreshes.
export interface OrderSyncStats {
  drafts: number;
  so_created: number;
  ready: number;
  resolved: number;
  errors: number;
  errors_no_so: number;
  errors_no_order: number;
  pending: number;
}

const ORDER_SYNC_CACHE_MS = 2 * 60 * 1000;
const ORDER_SYNC_GRACE_MINUTES = 15;   // same window the recon alerts wait before flagging a draft
const SO_LOOKAHEAD_DAYS = 7;           // an SO can be created a few days after its draft
const orderSyncCache = new Map<string, { at: number; value: OrderSyncStats }>();
const DRAFT_MEMO = /^#D\d+$/;

async function getOrderSyncStats(startDate: string, endDate: string): Promise<OrderSyncStats | null> {
  if (!shopifyConfigured() || !netsuiteConfigured()) return null;
  const key = `${startDate}|${endDate}`;
  const cached = orderSyncCache.get(key);
  if (cached && Date.now() - cached.at < ORDER_SYNC_CACHE_MS) return cached.value;

  const todayStr = new Date().toISOString().slice(0, 10);
  const nsEnd = new Date(endDate + 'T00:00:00Z');
  nsEnd.setUTCDate(nsEnd.getUTCDate() + SO_LOOKAHEAD_DAYS);
  const nsEndStr = nsEnd.toISOString().slice(0, 10) < todayStr ? nsEnd.toISOString().slice(0, 10) : todayStr;

  const [drafts, netsuiteSOs] = await Promise.all([
    fetchDraftsByDateRange(startDate, endDate),
    fetchSalesOrders(startDate, nsEndStr),
  ]);
  const soByMemo = new Map<string, Record<string, any>>();
  for (const so of netsuiteSOs.orders) {
    const memo = so.memo?.trim();
    if (memo && DRAFT_MEMO.test(memo)) soByMemo.set(memo, so);
  }

  const stats: OrderSyncStats = {
    drafts: drafts.size, so_created: 0, ready: 0, resolved: 0,
    errors: 0, errors_no_so: 0, errors_no_order: 0, pending: 0,
  };
  const now = Date.now();
  for (const [name, draft] of drafts) {
    const ageMin = (now - new Date(draft.created_at).getTime()) / 60000;
    const so = soByMemo.get(name);
    if (!so) {
      if (ageMin >= ORDER_SYNC_GRACE_MINUTES) stats.errors_no_so++;
      else stats.pending++;
      continue;
    }
    stats.so_created++;
    if (so.integration_ready !== 'T') { stats.pending++; continue; }
    stats.ready++;
    // Shopify order must exist; if NetSuite already recorded a Shopify SO #, it must be that order
    const shopifyOrder: string | null = draft.shopify_order;
    const nsShopifySo: string | null = so.shopify_so?.trim() || null;
    if (shopifyOrder && (!nsShopifySo || nsShopifySo === shopifyOrder)) stats.resolved++;
    else stats.errors_no_order++;
  }
  stats.errors = stats.errors_no_so + stats.errors_no_order;

  orderSyncCache.set(key, { at: Date.now(), value: stats });
  return stats;
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

    // Run independent data fetches in parallel
    const [openErrors, hb, last28d, rangeTransactions, rangeErrors, orderSync] = await Promise.all([
      store.getOpenErrors(),
      store.getLatestHeartbeat(),
      store.queryTransactions({ start: new Date(now.getTime() - 28 * 86400000), end: new Date(now.getTime() + 1000) }),
      store.queryTransactions({ start: new Date(startDate), end: endDatePlus1 }),
      store.queryErrors({ start: new Date(startDate), end: endDatePlus1 }),
      getOrderSyncStats(startDate, endDate).catch(err => {
        console.error('overview order sync error:', err.message);
        return null;
      }),
    ]);

    // 1. Open blocking errors, scoped to the selected date range by occurred_at
    const openErrTxMap = await store.getTransactionsByIds([...new Set(openErrors.map(e => e.transaction_id))]);
    const openErrTxById = indexById([...openErrTxMap.values()]);
    const rangeStartMs = new Date(startDate).getTime();
    const rangeEndMs = endDatePlus1.getTime();
    const openBlocking = toOpenBlockingErrors(openErrors, openErrTxById).filter(e => {
      const t = new Date(e.occurred_at).getTime();
      return t >= rangeStartMs && t < rangeEndMs;
    });

    // 2. Heartbeat age
    const heartbeatAgeMin = hb ? (Date.now() - new Date(hb.heartbeat_at).getTime()) / 60000 : 999;

    // 3 & 4. Transactions in last 60 min + 28-day baseline
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
    const flowStatsByFlow = groupByFlow(rangeTransactions, computeFlowCardStats);

    const rangeErrTxMap = await store.getTransactionsByIds([...new Set(rangeErrors.map(e => e.transaction_id))]);
    const rangeErrTxById = indexById([...rangeErrTxMap.values()]);
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
      orderSync,
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
