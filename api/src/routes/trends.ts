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

    // Order-matching data by hour: every hour from the start of the range to now, labelled in Central time
    if (orderSync && granularity === 'hour') {
      const fromMs = new Date(startDate + 'T00:00:00Z').getTime();
      const toMs = Math.min(now.getTime(), endDatePlus1.getTime() - 1);
      const counts = new Map<number, { ok: number; er: number; pe: number }>();
      for (const o of orderSync.outcomes) {
        const hourMs = Math.floor(new Date(o.created_at).getTime() / 3600000) * 3600000;
        const b = counts.get(hourMs) || { ok: 0, er: 0, pe: 0 };
        b[o.outcome]++;
        counts.set(hourMs, b);
      }
      const buckets = [];
      for (let h = fromMs; h <= toMs; h += 3600000) {
        const label = new Date(h).toLocaleString('en-US', { hour: 'numeric', hour12: true, timeZone: 'America/Chicago' })
          .replace(' AM', 'a').replace(' PM', 'p');
        buckets.push({ label, ...(counts.get(h) || { ok: 0, er: 0, pe: 0 }) });
      }
      res.json({ granularity, buckets });
      return;
    }

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
