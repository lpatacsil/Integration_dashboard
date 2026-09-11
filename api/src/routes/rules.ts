import { Router } from 'express';
import { CATEGORY_RULES, RULES } from '../config';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    categories: CATEGORY_RULES,
    rules: RULES,
  });
});

export default router;
