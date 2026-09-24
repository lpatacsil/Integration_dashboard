import { Router, Request, Response } from 'express';
import { getStore } from '../store';
import { computeRerunAgg } from '../store/aggregate';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const startDate = (req.query.startDate as string) || todayStr;
    const endDate = (req.query.endDate as string) || todayStr;
    const endDatePlus1 = new Date(endDate);
    endDatePlus1.setDate(endDatePlus1.getDate() + 1);

    const reruns = await getStore().queryReruns({ start: new Date(startDate), end: endDatePlus1 });
    res.json({ reruns: computeRerunAgg(reruns) });
  } catch (err: any) {
    console.error('reruns error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
