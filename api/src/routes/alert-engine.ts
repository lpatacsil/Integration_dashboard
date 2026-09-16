import { Router, Request, Response } from 'express';
import {
  evaluate,
  getOpenIncidents,
  getRecentNotifications,
  getIncidentHistory,
  getUnsentNotifications,
} from '../services/alert-engine';

const router = Router();

// POST /api/alert-engine/evaluate — run the alert engine (evaluate + generate notifications)
router.post('/evaluate', async (_req: Request, res: Response) => {
  try {
    const result = await evaluate();
    res.json(result);
  } catch (err: any) {
    console.error('alert-engine/evaluate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alert-engine/incidents — get all open incidents
router.get('/incidents', async (_req: Request, res: Response) => {
  try {
    const incidents = await getOpenIncidents();
    res.json({ incidents });
  } catch (err: any) {
    console.error('alert-engine/incidents error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alert-engine/history — get incident history (open + resolved)
router.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const incidents = await getIncidentHistory(limit);
    res.json({ incidents });
  } catch (err: any) {
    console.error('alert-engine/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alert-engine/notifications — get recent notifications
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const notifications = await getRecentNotifications(limit);
    res.json({ notifications });
  } catch (err: any) {
    console.error('alert-engine/notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alert-engine/unsent — get notifications waiting to be sent
router.get('/unsent', async (_req: Request, res: Response) => {
  try {
    const notifications = await getUnsentNotifications();
    res.json({ notifications, count: notifications.length });
  } catch (err: any) {
    console.error('alert-engine/unsent error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
