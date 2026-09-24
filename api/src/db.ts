import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'integration_monitor',
  user: process.env.DB_USER || 'integration_monitor',
  password: process.env.DB_PASSWORD || 'localdev_only_2026',
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export default pool;
