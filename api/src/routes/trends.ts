import { Router, Request, Response } from 'express';
import pool from '../db';

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
    const endStr = endDatePlus1.toISOString().slice(0, 10);

    let query: string;
    if (granularity === 'hour') {
      query = `
        SELECT
          EXTRACT(HOUR FROM created_at)::int AS bucket,
          COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS ok,
          COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS er,
          COUNT(*) FILTER (WHERE normalized_status IN ('PENDING','RETRY','PROCESSING'))::int AS pe
        FROM integration_transactions
        WHERE created_at >= $1 AND created_at < $2
          AND flow_code != 'NS'
        GROUP BY bucket
        ORDER BY bucket
      `;
    } else {
      query = `
        SELECT
          DATE(created_at AT TIME ZONE 'UTC') AS bucket,
          COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')::int AS ok,
          COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS er,
          COUNT(*) FILTER (WHERE normalized_status IN ('PENDING','RETRY','PROCESSING'))::int AS pe
        FROM integration_transactions
        WHERE created_at >= $1 AND created_at < $2
          AND flow_code != 'NS'
        GROUP BY bucket
        ORDER BY bucket
      `;
    }

    const result = await pool.query(query, [startDate, endStr]);

    const buckets = result.rows.map(r => ({
      label: granularity === 'hour'
        ? `${r.bucket % 12 || 12}${r.bucket < 12 ? 'a' : 'p'}`
        : new Date(r.bucket).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
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
