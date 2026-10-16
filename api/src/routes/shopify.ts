import { Router, Request, Response } from 'express';
import {
  fetchOrders,
  fetchDraftOrders,
  testConnection,
  isConfigured,
  isOAuthConfigured,
  getOAuthAuthorizeUrl,
  exchangeCodeForToken,
} from '../services/shopify-client';

const router = Router();

// GET /api/shopify/auth — start OAuth flow (open in browser)
router.get('/auth', (req: Request, res: Response) => {
  if (!isOAuthConfigured()) {
    res.status(400).json({ error: 'SHOPIFY_STORE, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET must be set' });
    return;
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/api/shopify/auth/callback`;
  res.redirect(getOAuthAuthorizeUrl(redirectUri));
});

// GET /api/shopify/auth/callback — receive OAuth code, exchange for token
router.get('/auth/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send('Missing code parameter');
      return;
    }
    const token = await exchangeCodeForToken(code);
    const masked = token.slice(0, 8) + '...' + token.slice(-4);
    res.send(`<h2>Shopify connected!</h2><p>Access token saved: <code>${masked}</code></p><p>You can close this tab and return to the dashboard.</p>`);
  } catch (err: any) {
    res.status(500).send(`<h2>OAuth failed</h2><p>${err.message}</p>`);
  }
});

// GET /api/shopify/status
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ configured: isConfigured() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shopify/test
router.post('/test', async (_req: Request, res: Response) => {
  try {
    const result = await testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shopify/orders?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' });
      return;
    }
    const result = await fetchOrders(startDate, endDate);
    res.json(result);
  } catch (err: any) {
    console.error('shopify/orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shopify/draft-orders?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/draft-orders', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' });
      return;
    }
    const result = await fetchDraftOrders(startDate, endDate);
    res.json(result);
  } catch (err: any) {
    console.error('shopify/draft-orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
