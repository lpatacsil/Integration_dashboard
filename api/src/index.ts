import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import healthRouter from './routes/health';
import overviewRouter from './routes/overview';
import trendsRouter from './routes/trends';
import errorsRouter from './routes/errors';
import flowsRouter from './routes/flows';
import indexingRouter from './routes/indexing';
import rerunsRouter from './routes/reruns';
import alertsRouter from './routes/alerts';
import rulesRouter from './routes/rules';
import netsuiteRouter from './routes/netsuite';
import alertEngineRouter from './routes/alert-engine';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3001', 10);

app.use(cors());
app.use(express.json());

app.use('/api/health', healthRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/trends', trendsRouter);
app.use('/api/errors', errorsRouter);
app.use('/api/flows', flowsRouter);
app.use('/api/indexing', indexingRouter);
app.use('/api/reruns', rerunsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/rules', rulesRouter);
app.use('/api/netsuite', netsuiteRouter);
app.use('/api/alert-engine', alertEngineRouter);

// Serve built frontend if public/ directory exists
const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
