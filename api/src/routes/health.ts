import { Router } from 'express';
import pool from '../db';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    res.json({ status: 'ok', db: 'connected', serverTime: result.rows[0].server_time });
  } catch (err: any) {
    res.status(503).json({ status: 'error', db: 'disconnected', message: err.message });
  }
});

export default router;
