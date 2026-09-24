import { Router } from 'express';
import { getCategoryRules, getRules } from '../services/settings-store';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    categories: getCategoryRules(),
    rules: getRules(),
  });
});

export default router;
