import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { FLOWS } from '../config';
import { classifyFlow } from '../severity';
import { isConfigured } from '../services/netsuite-auth';
import { fetchNSInternalErrors } from '../services/netsuite-sync';
import {
  indexById, toOpenBlockingErrors, toOpenIncidents, errorsForFlow,
  computeFlowKpi, computeErrorCategorySummary, computeDailyBreakdown, computeErrorSparkline,
  computeIndexingNeedsSummary, computeIndexingNeedsOpenOrders,
} from '../store/aggregate';

const router = Router();

// GET /api/flows/:code?startDate&endDate
router.get('/:code', async (req: Request, res: Response) => {
  try {
    const flowCode = req.params.code.toUpperCase();
    if (!FLOWS[flowCode]) {
      res.status(404).json({ error: `Unknown flow code: ${flowCode}` });
      return;
    }

    const store = getStore();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);
    const range = { start: new Date(startDate), end: endDatePlus1 };

    const rangeTransactions = (await store.queryTransactions(range)).filter(t => t.flow_code === flowCode);
    const rangeErrors = (await store.queryErrors(range)).filter(e => rangeTransactions.some(t => t.id === e.transaction_id));
    const rangeTxById = indexById(rangeTransactions);

    // KPI stats: for NS flow, only count FAILED transactions with a NETSUITE-group error
    const nsErrorTxIds = new Set(errorsForFlow(rangeErrors, rangeTxById, flowCode)
      .filter(e => e.error_group === 'NETSUITE').map(e => e.transaction_id));
    const kpi: any = computeFlowKpi(
      rangeTransactions,
      flowCode === 'NS' ? (t) => nsErrorTxIds.has(t.id) : undefined,
    );

    // Error categories in range (NS flow: only NETSUITE-group errors)
    const categoryErrors = flowCode === 'NS'
      ? rangeErrors.filter(e => e.error_group === 'NETSUITE')
      : rangeErrors;
    const categories = computeErrorCategorySummary(categoryErrors);

    // Daily breakdown (last 10 days within range)
    const daily = computeDailyBreakdown(rangeTransactions, 10);

    // Open incidents (regardless of range)
    const openErrorsAll = await store.getOpenErrors();
    const openFlowTxIds = new Set(rangeTransactions.map(t => t.id));
    // Open incidents aren't range-bound, so re-fetch transactions for any open error not already in range
    const openTxNeeded = [...new Set(openErrorsAll.map(e => e.transaction_id))].filter(id => !rangeTxById.has(id));
    const extraTx = await Promise.all(openTxNeeded.map(id => store.getTransactionById(id)));
    const openTxById = indexById([...rangeTransactions, ...extraTx.filter((t): t is NonNullable<typeof t> => !!t)]);

    let openErrorsForFlow = errorsForFlow(openErrorsAll, openTxById, flowCode);
    if (flowCode === 'NS') openErrorsForFlow = openErrorsForFlow.filter(e => e.error_group === 'NETSUITE');
    const openIncidents = toOpenIncidents(openErrorsForFlow, openTxById);

    // Sparkline: errors per day, last 14 days
    const last14d = await store.queryTransactions({ start: new Date(now.getTime() - 13 * 86400000), end: new Date(now.getTime() + 1000) });
    const sparkline = computeErrorSparkline(last14d.filter(t => t.flow_code === flowCode), 14);

    // Per-flow severity, scoped to the selected date range by occurred_at (matches overview.ts)
    const rangeStartMs = range.start.getTime();
    const rangeEndMs = range.end.getTime();
    const flowBlocking = toOpenBlockingErrors(openErrorsForFlow, openTxById).filter(e => {
      const t = new Date(e.occurred_at).getTime();
      return t >= rangeStartMs && t < rangeEndMs;
    });
    const hb = await store.getLatestHeartbeat();
    const heartbeatAgeMin = hb ? (Date.now() - new Date(hb.heartbeat_at).getTime()) / 60000 : 999;
    const severity = classifyFlow(flowBlocking, heartbeatAgeMin, flowCode);

    kpi.successRate = kpi.total > 0 ? ((kpi.succeeded / kpi.total) * 100).toFixed(1) : '—';

    // For the NS flow, merge live NetSuite Vertex data if credentials are configured
    let nsInternalData = null;
    if (flowCode === 'NS' && isConfigured()) {
      try {
        nsInternalData = await fetchNSInternalErrors(startDate, endDate);

        const vtx = nsInternalData.vertex;
        kpi.total += vtx.total;
        kpi.succeeded += vtx.passed;
        kpi.errored += vtx.failed;

        const localErrorTxnIds = new Set(openIncidents.map((r: any) => String(r.entity_identifier)));
        for (const err of vtx.errors) {
          if (!localErrorTxnIds.has(String(err.transaction_id))) {
            openIncidents.push({
              error_id: `ns-vtx-${err.id}` as any,
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
            } as any);
          }
        }

        if (vtx.failed > 0) {
          const existingVtx = categories.find((c) => c.error_code === 'TAX-VERTEX');
          if (existingVtx) {
            (existingVtx as any).count += vtx.failed;
            (existingVtx as any).netsuite_direct_count = vtx.failed;
          } else {
            categories.push({
              error_code: 'TAX-VERTEX', category_label: 'Vertex tax calculation failed',
              error_group: 'NETSUITE', is_blocking: false, count: vtx.failed,
              netsuite_direct_count: vtx.failed,
            } as any);
          }
          categories.sort((a, b) => b.count - a.count);
        }
      } catch (err: any) {
        console.error('Failed to fetch NS internal errors from NetSuite:', err.message);
      }
    }

    // For the IDX flow, show "indexing needs" — MAP-* errors across all flows
    let indexingNeeds = null;
    if (flowCode === 'IDX') {
      const allRangeErrors = await store.queryErrors(range);
      const allRangeTx = indexById(await store.queryTransactions(range));
      const needsSummary = computeIndexingNeedsSummary(allRangeErrors, allRangeTx);

      const allOpenErrors = await store.getOpenErrors();
      const openTxIds = [...new Set(allOpenErrors.map(e => e.transaction_id))];
      const openTx = await Promise.all(openTxIds.map(id => store.getTransactionById(id)));
      const openTxIdx = indexById(openTx.filter((t): t is NonNullable<typeof t> => !!t));
      const openOrders = computeIndexingNeedsOpenOrders(allOpenErrors, openTxIdx);

      indexingNeeds = { ...needsSummary, openOrders };
    }

    res.json({
      flowCode,
      ...FLOWS[flowCode],
      severity,
      kpi,
      categories,
      daily,
      openIncidents,
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
