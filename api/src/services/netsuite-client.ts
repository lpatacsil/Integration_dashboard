import https from 'node:https';
import { loadCredentials, generateAuthHeader, getBaseUrl, isConfigured } from './netsuite-auth';

export interface SuiteQLResponse {
  items: Record<string, any>[];
  hasMore: boolean;
  totalResults?: number;
}

export interface NetSuiteError {
  type: string;
  title: string;
  status: number;
  detail: string;
}

/**
 * Make an HTTPS request and return the parsed JSON body.
 */
function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timed out after 30s'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * Execute a SuiteQL query against the NetSuite REST API.
 */
export async function suiteQL(
  query: string,
  limit: number = 100,
  offset: number = 0,
): Promise<SuiteQLResponse> {
  if (!isConfigured()) {
    throw new Error('NetSuite credentials not configured');
  }

  const creds = loadCredentials();
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;

  const authHeader = generateAuthHeader('POST', url, creds);
  const bodyStr = JSON.stringify({ q: query });

  const headers: Record<string, string> = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    prefer: 'transient',
  };

  const res = await request('POST', url, headers, bodyStr);

  if (res.status >= 400) {
    const detail =
      typeof res.body === 'object'
        ? res.body.detail || res.body.title || JSON.stringify(res.body)
        : String(res.body);
    throw new Error(`SuiteQL error (${res.status}): ${detail}`);
  }

  return {
    items: res.body.items || [],
    hasMore: res.body.hasMore || false,
    totalResults: res.body.totalResults,
  };
}

/**
 * GET a single NetSuite record by type and internal ID.
 */
export async function getRecord(
  recordType: string,
  id: string,
): Promise<Record<string, any>> {
  if (!isConfigured()) {
    throw new Error('NetSuite credentials not configured');
  }

  const creds = loadCredentials();
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/services/rest/record/v1/${recordType}/${id}`;

  const authHeader = generateAuthHeader('GET', url, creds);

  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: 'application/json',
  };

  const res = await request('GET', url, headers);

  if (res.status >= 400) {
    const detail =
      typeof res.body === 'object'
        ? res.body.detail || res.body.title || JSON.stringify(res.body)
        : String(res.body);
    throw new Error(`NetSuite record error (${res.status}): ${detail}`);
  }

  return res.body;
}

/**
 * Test the NetSuite connection by executing a trivial SuiteQL query.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  latencyMs: number;
}> {
  if (!isConfigured()) {
    return { ok: false, message: 'NetSuite credentials not configured', latencyMs: 0 };
  }

  const start = Date.now();
  try {
    await suiteQL('SELECT 1 AS test', 1, 0);
    return { ok: true, message: 'Connected successfully', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, message: err.message, latencyMs: Date.now() - start };
  }
}
