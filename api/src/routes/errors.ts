import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { computeErrorCategorySummary, toOpenIncidents, indexById } from '../store/aggregate';

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

    const errors = await getStore().queryErrors({ start: new Date(startDate), end: endDatePlus1 });
    res.json({ categories: computeErrorCategorySummary(errors) });
  } catch (err: any) {
    console.error('errors/categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/errors/open-incidents
router.get('/open-incidents', async (_req: Request, res: Response) => {
  try {
    const store = getStore();
    const openErrors = await store.getOpenErrors();
    const transactions = await Promise.all(
      [...new Set(openErrors.map(e => e.transaction_id))].map(id => store.getTransactionById(id)),
    );
    const transactionsById = indexById(transactions.filter((t): t is NonNullable<typeof t> => !!t));

    res.json({ incidents: toOpenIncidents(openErrors, transactionsById) });
  } catch (err: any) {
    console.error('errors/open-incidents error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
