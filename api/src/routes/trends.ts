import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { computeHourBuckets, computeDayBuckets } from '../store/aggregate';
import type { Transaction } from '../store/types';
import { getOrderSyncStats } from '../services/order-sync';

const OUTCOME_STATUS = { ok: 'SUCCESS', er: 'FAILED', pe: 'PENDING' } as const;

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const granularity = (req.query.granularity as string) || (startDate === endDate ? 'hour' : 'day');

    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);

    // Volume by outcome comes from the live Shopify + NetSuite order matching (one point per draft);
    // falls back to Team Central transactions when the APIs aren't configured
    const orderSync = await getOrderSyncStats(startDate, endDate).catch(err => {
      console.error('trends order sync error:', err.message);
      return null;
    });
    const transactions = orderSync
      ? orderSync.outcomes.map(o => ({ created_at: o.created_at, normalized_status: OUTCOME_STATUS[o.outcome] }) as unknown as Transaction)
      : (await getStore().queryTransactions({ start: new Date(startDate), end: endDatePlus1 }))
        .filter(t => t.flow_code !== 'NS');

    const rows = granularity === 'hour' ? computeHourBuckets(transactions) : computeDayBuckets(transactions);

    const buckets = rows.map(r => ({
      label: granularity === 'hour'
        ? `${(r.bucket as number) % 12 || 12}${(r.bucket as number) < 12 ? 'a' : 'p'}`
        : new Date(r.bucket as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ok: r.ok,
      er: r.er,
      pe: r.pe,
    }));

    res.json({ granularity, buckets });
  } catch (err: any) {
    console.error('trends error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
