import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { seed } from '../seed';

const router = Router();

let importStatus: {
  running: boolean;
  result?: string;
  error?: string;
  startedAt?: string;
} = { running: false };

router.post('/', (req: Request, res: Response) => {
  const { messages, errors } = req.body as { messages?: string; errors?: string };

  if (!messages || !errors) {
    res.status(400).json({ status: 'error', message: 'Both CSV files are required (messages and errors).' });
    return;
  }

  if (importStatus.running) {
    res.json({ status: 'already_running', message: 'An import is already in progress.' });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-import-'));

  fs.writeFileSync(path.join(tmpDir, 'Message logs from team central.csv'), messages, 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'Error logs in team central.csv'), errors, 'utf-8');

  importStatus = { running: true, startedAt: new Date().toISOString() };

  seed(tmpDir)
    .then(() => {
      importStatus = { running: false, result: 'CSV import completed successfully.' };
    })
    .catch((err: any) => {
      importStatus = { running: false, error: err.message || 'Import failed.' };
    })
    .finally(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

  res.json({ status: 'started', message: 'Import started. Poll GET /api/csv-import/status to track progress.' });
});

router.get('/status', (_req: Request, res: Response) => {
  res.json(importStatus);
});

export default router;
