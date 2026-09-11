import { Router, Request, Response } from 'express';
import pool from '../db';

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

    const result = await pool.query(`
      SELECT
        index_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending
      FROM indexing_activity
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY index_type
      ORDER BY total DESC
    `, [startDate, endStr]);

    res.json({ indexing: result.rows });
  } catch (err: any) {
    console.error('indexing error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
