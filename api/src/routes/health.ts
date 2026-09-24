import { Router } from 'express';
import { getStore } from '../store';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    await getStore().ping();
    res.json({ status: 'ok', storage: 'connected', serverTime: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ status: 'error', storage: 'disconnected', message: err.message });
  }
});

export default router;
