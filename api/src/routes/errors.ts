import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// GET /api/errors/categories?startDate&endDate
router.get('/categories', async (req: Request, res: Response) => {
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
        e.error_code,
        ec.label AS category_label,
        ec.error_group,
        ec.is_blocking,
        COUNT(*)::int AS count
      FROM integration_errors e
      LEFT JOIN error_categories ec ON ec.id = e.error_category_id
      WHERE e.occurred_at >= $1 AND e.occurred_at < $2
      GROUP BY e.error_code, ec.label, ec.error_group, ec.is_blocking
      ORDER BY count DESC
    `, [startDate, endStr]);

    res.json({ categories: result.rows });
  } catch (err: any) {
    console.error('errors/categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/errors/open-incidents
router.get('/open-incidents', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        e.id AS error_id,
        t.flow_code,
        t.entity_identifier,
        t.transaction_type,
        e.error_code,
        ec.label AS category_label,
        ec.error_group,
        ec.is_blocking,
        e.error_message,
        e.raw_error,
        e.occurred_at,
        EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS age_minutes
      FROM integration_errors e
      JOIN integration_transactions t ON t.id = e.transaction_id
      LEFT JOIN error_categories ec ON ec.id = e.error_category_id
      WHERE e.resolved_at IS NULL AND e.is_current = TRUE
      ORDER BY e.occurred_at DESC
    `);

    res.json({ incidents: result.rows });
  } catch (err: any) {
    console.error('errors/open-incidents error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
