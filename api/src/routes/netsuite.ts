import { Router, Request, Response } from 'express';
import { testConnection } from '../services/netsuite-client';
import { syncRecentOrders, fetchOrderDetail, getSyncStatus, fetchNSInternalErrors, fetchSalesOrders } from '../services/netsuite-sync';

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

// GET /api/netsuite/sales-orders — pull SO records directly from NetSuite
router.get('/sales-orders', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate query params are required' });
      return;
    }
    const result = await fetchSalesOrders(startDate, endDate);
    res.json(result);
  } catch (err: any) {
    console.error('netsuite/sales-orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// TEMPORARY — read-only discovery of the case record (rectype 2049); remove once fields are mapped
router.get('/_discover-cases', async (_req: Request, res: Response) => {
  try {
    const { suiteQL } = await import('../services/netsuite-client');
    const [sample, labels, sources] = await Promise.all([
      suiteQL(`SELECT * FROM customrecord_issue_log WHERE name = 'ISS-220926112259-0' OR custrecord_il_source = 'Sales Order' ORDER BY id DESC`, 2, 0),
      suiteQL(`SELECT id, BUILTIN.DF(custrecord_il_status) AS status, BUILTIN.DF(custrecord_il_owner) AS owner, BUILTIN.DF(custrecord_il_assigned_to) AS assigned FROM customrecord_issue_log WHERE custrecord_il_source = 'Sales Order' ORDER BY id DESC`, 2, 0),
      suiteQL(`SELECT custrecord_il_source AS source, BUILTIN.DF(custrecord_il_status) AS status, COUNT(id) AS cnt FROM customrecord_issue_log GROUP BY custrecord_il_source, BUILTIN.DF(custrecord_il_status)`, 50, 0),
    ]);
    const strip = (r: any) => { const { custrecord_il_comment_history, custrecord_il_detail, ...rest } = r; return { ...rest, detail: String(custrecord_il_detail || '').slice(0, 200) }; };
    res.json({ sample: sample.items.map(strip), labels: labels.items, sources: sources.items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
