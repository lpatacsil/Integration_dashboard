import { Router, Request, Response } from 'express';
import { testConnection } from '../services/netsuite-client';
import { syncRecentOrders, fetchOrderDetail, getSyncStatus, fetchNSInternalErrors } from '../services/netsuite-sync';

const router = Router();

// GET /api/netsuite/status — check config + last sync status
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getSyncStatus();
    res.json(status);
  } catch (err: any) {
    console.error('netsuite/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/netsuite/test — test NS connection with a simple query
router.post('/test', async (_req: Request, res: Response) => {
  try {
    const result = await testConnection();
    res.json(result);
  } catch (err: any) {
    console.error('netsuite/test error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/netsuite/sync — trigger enrichment sync
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncRecentOrders();
    res.json(result);
  } catch (err: any) {
    console.error('netsuite/sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/netsuite/order/:id — get enriched order detail
router.get('/order/:id', async (req: Request, res: Response) => {
  try {
    const salesOrderId = req.params.id;
    const detail = await fetchOrderDetail(salesOrderId);
    if (!detail.local) {
      res.status(404).json({ error: `Sales order ${salesOrderId} not found in local database` });
      return;
    }
    res.json(detail);
  } catch (err: any) {
    console.error('netsuite/order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/netsuite/internal-errors — pull NS internal errors directly from NetSuite
router.get('/internal-errors', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const result = await fetchNSInternalErrors(startDate, endDate);
    res.json(result);
  } catch (err: any) {
    console.error('netsuite/internal-errors error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
