import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { seed } from '../seed';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { messages, errors } = req.body as { messages?: string; errors?: string };

  if (!messages || !errors) {
    res.status(400).json({ status: 'error', message: 'Both CSV files are required (messages and errors).' });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-import-'));

  try {
    if (messages) {
      fs.writeFileSync(path.join(tmpDir, 'Message logs from team central.csv'), messages, 'utf-8');
    }
    if (errors) {
      fs.writeFileSync(path.join(tmpDir, 'Error logs in team central.csv'), errors, 'utf-8');
    }

    await seed(tmpDir);

    res.json({ status: 'ok', message: 'CSV import completed successfully.' });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message || 'Import failed.' });
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

export default router;
