import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { FLOWS } from '../config';
import { getRules, getContacts } from '../services/settings-store';
import { classify, classifyFlow } from '../severity';
import {
  toOpenBlockingErrors, indexById, groupByFlow, computeFlowCardStats,
  computeTxLast60, computeBaselineLast60, computeErrorSparkline, computeFlowErrorResolution,
} from '../store/aggregate';
import { fetchDraftsByDateRange, lookupDraftsByName, isConfigured as shopifyConfigured } from '../services/shopify-client';
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

// Processed / Succeeded for the order flows come straight from the Shopify + NetSuite APIs:
//   S2N: processed = draft orders created in range, succeeded = drafts with a NetSuite SO (SO memo = draft #)
//   N2S: processed = NetSuite SOs (with a draft memo) dated in range, succeeded = SOs whose draft exists in Shopify
// Cached briefly since the overview auto-refreshes.
interface FlowCounts { processed: number; succeeded: number }
interface ReconCounts { S2N: FlowCounts; N2S: FlowCounts }

const RECON_CACHE_MS = 2 * 60 * 1000;
const reconCountsCache = new Map<string, { at: number; value: ReconCounts }>();
const DRAFT_MEMO = /^#D\d+$/;

// NetSuite trandate comes back as M/D/YYYY; normalise to YYYY-MM-DD for range checks
function toIsoDate(trandate: string | null | undefined): string | null {
  if (!trandate) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trandate.trim());
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return trandate.slice(0, 10);
}

async function getReconCounts(startDate: string, endDate: string): Promise<ReconCounts | null> {
  if (!shopifyConfigured() || !netsuiteConfigured()) return null;
  const key = `${startDate}|${endDate}`;
  const cached = reconCountsCache.get(key);
  if (cached && Date.now() - cached.at < RECON_CACHE_MS) return cached.value;

  // SOs can land a day after their draft, so look one day past the range on the NetSuite side
  const nsEnd = new Date(endDate + 'T00:00:00Z');
  nsEnd.setUTCDate(nsEnd.getUTCDate() + 1);
  const [drafts, netsuiteSOs] = await Promise.all([
    fetchDraftsByDateRange(startDate, endDate),
    fetchSalesOrders(startDate, nsEnd.toISOString().slice(0, 10)),
  ]);
  const draftSOs = netsuiteSOs.orders.filter((so: any) => DRAFT_MEMO.test(so.memo?.trim() || ''));

  const soMemos = new Set(draftSOs.map((so: any) => so.memo.trim()));
  let s2nSucceeded = 0;
  for (const name of drafts.keys()) if (soMemos.has(name)) s2nSucceeded++;

  // N2S only counts SOs dated inside the range; drafts created before the range are looked up by name
  const rangeSOs = draftSOs.filter((so: any) => {
    const d = toIsoDate(so.trandate);
    return d != null && d >= startDate && d <= endDate;
  });
  const missingNames = rangeSOs.map((so: any) => so.memo.trim()).filter((n: string) => !drafts.has(n));
  const lookedUp = await lookupDraftsByName(missingNames);
  const n2sSucceeded = rangeSOs.filter((so: any) => {
    const name = so.memo.trim();
    return drafts.has(name) || lookedUp.has(name);
  }).length;

  const value: ReconCounts = {
    S2N: { processed: drafts.size, succeeded: s2nSucceeded },
    N2S: { processed: rangeSOs.length, succeeded: n2sSucceeded },
  };
  reconCountsCache.set(key, { at: Date.now(), value });
  return value;
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
    const [openErrors, hb, last28d, rangeTransactions, rangeErrors, reconCounts] = await Promise.all([
      store.getOpenErrors(),
      store.getLatestHeartbeat(),
      store.queryTransactions({ start: new Date(now.getTime() - 28 * 86400000), end: new Date(now.getTime() + 1000) }),
      store.queryTransactions({ start: new Date(startDate), end: endDatePlus1 }),
      store.queryErrors({ start: new Date(startDate), end: endDatePlus1 }),
      getReconCounts(startDate, endDate).catch(err => {
        console.error('overview recon counts error:', err.message);
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

    // Errors / resolved / reruns stay on Team Central data until its API is wired up
    if (reconCounts) {
      for (const f of ['S2N', 'N2S'] as const) {
        flowStats[f].total = reconCounts[f].processed;
        flowStats[f].succeeded = reconCounts[f].succeeded;
      }
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
