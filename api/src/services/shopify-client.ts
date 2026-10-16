import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const API_VERSION = '2024-10';

export function isConfigured(): boolean {
  return !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_ACCESS_TOKEN);
}

export function isOAuthConfigured(): boolean {
  return !!(process.env.SHOPIFY_STORE && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

export function getOAuthAuthorizeUrl(redirectUri: string): string {
  const store = process.env.SHOPIFY_STORE!;
  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const scopes = 'read_orders,read_draft_orders';
  return `https://${store}.myshopify.com/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const store = process.env.SHOPIFY_STORE!;
  const clientId = process.env.SHOPIFY_CLIENT_ID!;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET!;

  const body = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: `${store}.myshopify.com`,
        path: '/admin/oauth/access_token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.access_token) {
            process.env.SHOPIFY_ACCESS_TOKEN = parsed.access_token;
            saveTokenToEnv(parsed.access_token);
            resolve(parsed.access_token);
          } else {
            reject(new Error(parsed.error_description || parsed.error || 'Token exchange failed'));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function saveTokenToEnv(token: string): void {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return;
    let content = fs.readFileSync(envPath, 'utf8');
    if (content.includes('SHOPIFY_ACCESS_TOKEN=')) {
      content = content.replace(/SHOPIFY_ACCESS_TOKEN=.*/, `SHOPIFY_ACCESS_TOKEN=${token}`);
    } else {
      content += `\nSHOPIFY_ACCESS_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, content);
  } catch {
    console.warn('Could not save Shopify token to .env file');
  }
}

function request(
  method: string,
  path: string,
): Promise<{ status: number; body: any }> {
  const store = process.env.SHOPIFY_STORE!;
  const token = process.env.SHOPIFY_ACCESS_TOKEN!;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: `${store}.myshopify.com`,
      path: `/admin/api/${API_VERSION}${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        Accept: 'application/json',
      },
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
      req.destroy(new Error('Shopify request timed out after 30s'));
    });
    req.end();
  });
}

/**
 * Fetch orders from Shopify Admin API for a date range.
 */
export async function fetchOrders(startDate: string, endDate: string): Promise<{
  orders: Record<string, any>[];
  source: string;
}> {
  if (!isConfigured()) {
    return { orders: [], source: 'not_configured' };
  }

  try {
    // Build date range filter (ISO 8601)
    const createdMin = `${startDate}T00:00:00-00:00`;
    const createdMax = `${endDate}T23:59:59-00:00`;

    const allOrders: Record<string, any>[] = [];
    let page = `/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(createdMin)}&created_at_max=${encodeURIComponent(createdMax)}`;

    // Paginate (Shopify caps at 250 per page)
    while (page && allOrders.length < 1000) {
      const res = await request('GET', page);

      if (res.status >= 400) {
        const detail = typeof res.body === 'object'
          ? res.body.errors || JSON.stringify(res.body)
          : String(res.body);
        throw new Error(`Shopify API error (${res.status}): ${detail}`);
      }

      const orders = res.body.orders || [];
      for (const o of orders) {
        allOrders.push({
          order_number: o.name || `#${o.order_number}`,
          order_number_raw: o.order_number,
          created_at: o.created_at,
          customer: o.customer
            ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() || o.customer.email
            : null,
          total_price: o.total_price,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status || 'unfulfilled',
          note: o.note,
        });
      }

      // No simple link-header pagination needed for now; stop after first page
      // (250 orders per range is usually enough for a dashboard view)
      break;
    }

    return { orders: allOrders, source: 'shopify_admin' };
  } catch (err: any) {
    console.error('Shopify fetchOrders error:', err.message);
    return { orders: [], source: `error: ${err.message}` };
  }
}

/**
 * Fetch draft orders from Shopify Admin API for a date range.
 */
export async function fetchDraftOrders(startDate: string, endDate: string): Promise<{
  draft_orders: Record<string, any>[];
  source: string;
}> {
  if (!isConfigured()) {
    return { draft_orders: [], source: 'not_configured' };
  }

  try {
    const createdMin = `${startDate}T00:00:00-00:00`;
    const createdMax = `${endDate}T23:59:59-00:00`;

    const res = await request(
      'GET',
      `/draft_orders.json?limit=250&created_at_min=${encodeURIComponent(createdMin)}&created_at_max=${encodeURIComponent(createdMax)}`,
    );

    if (res.status >= 400) {
      const detail = typeof res.body === 'object'
        ? res.body.errors || JSON.stringify(res.body)
        : String(res.body);
      throw new Error(`Shopify API error (${res.status}): ${detail}`);
    }

    const drafts = (res.body.draft_orders || []).map((d: any) => ({
      draft_number: d.name || `#D${d.id}`,
      created_at: d.created_at,
      customer: d.customer
        ? `${d.customer.first_name || ''} ${d.customer.last_name || ''}`.trim() || d.customer.email
        : null,
      total_price: d.total_price,
      status: d.status,
      note: d.note,
    }));

    return { draft_orders: drafts, source: 'shopify_admin' };
  } catch (err: any) {
    console.error('Shopify fetchDraftOrders error:', err.message);
    return { draft_orders: [], source: `error: ${err.message}` };
  }
}

/**
 * Look up draft orders by their names (e.g., "#D29217") using GraphQL.
 */
export async function lookupDraftsByName(names: string[]): Promise<Map<string, Record<string, any>>> {
  if (!isConfigured() || names.length === 0) return new Map();

  const store = process.env.SHOPIFY_STORE!;
  const token = process.env.SHOPIFY_ACCESS_TOKEN!;
  const result = new Map<string, Record<string, any>>();

  // Process in batches of 20 (GraphQL query size limit)
  for (let i = 0; i < names.length; i += 20) {
    const batch = names.slice(i, i + 20);
    const queryFilter = batch.map(n => `\\"${n}\\"`).join(' OR ');
    const query = `{
      draftOrders(first: 50, query: "${queryFilter}") {
        edges {
          node {
            name
            createdAt
            totalPrice
            status
            customer { displayName }
            order { name }
          }
        }
      }
    }`;

    try {
      const res = await graphqlRequest(store, token, query);
      const edges = res?.data?.draftOrders?.edges || [];
      for (const edge of edges) {
        const node = edge.node;
        result.set(node.name, {
          draft_number: node.name,
          created_at: node.createdAt,
          total_price: node.totalPrice,
          status: node.status,
          customer: node.customer?.displayName || null,
          shopify_order: node.order?.name || null,
        });
      }
    } catch (err: any) {
      console.error('GraphQL draft lookup error:', err.message);
    }
  }

  return result;
}

export async function fetchDraftsByDateRange(startDate: string, endDate: string): Promise<Map<string, Record<string, any>>> {
  if (!isConfigured()) return new Map();

  const store = process.env.SHOPIFY_STORE!;
  const token = process.env.SHOPIFY_ACCESS_TOKEN!;
  const result = new Map<string, Record<string, any>>();
  let cursor: string | null = null;
  const nextDay = new Date(endDate + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endPlusOne = nextDay.toISOString().slice(0, 10);
  const dateFilter = `created_at:>=${startDate} created_at:<${endPlusOne}`;
  console.log(`[shopify] fetchDraftsByDateRange filter: "${dateFilter}"`);

  for (let page = 0; page < 20; page++) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      draftOrders(first: 250, query: "${dateFilter}"${afterClause}) {
        edges {
          cursor
          node {
            name
            createdAt
            totalPrice
            status
            customer { displayName }
            order { name }
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    try {
      const res = await graphqlRequest(store, token, query);
      const edges = res?.data?.draftOrders?.edges || [];
      for (const edge of edges) {
        const node = edge.node;
        result.set(node.name, {
          draft_number: node.name,
          created_at: node.createdAt,
          total_price: node.totalPrice,
          status: node.status,
          customer: node.customer?.displayName || null,
          shopify_order: node.order?.name || null,
        });
        cursor = edge.cursor;
      }
      if (!res?.data?.draftOrders?.pageInfo?.hasNextPage || edges.length === 0) break;
    } catch (err: any) {
      console.error('GraphQL fetchDraftsByDateRange error:', err.message);
      break;
    }
  }

  console.log(`[shopify] fetchDraftsByDateRange: ${result.size} drafts returned`);
  return result;
}

function graphqlRequest(store: string, token: string, query: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request(
      {
        hostname: `${store}.myshopify.com`,
        path: `/admin/api/${API_VERSION}/graphql.json`,
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid GraphQL response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GraphQL request timed out')));
    req.write(body);
    req.end();
  });
}

/**
 * Test Shopify API connection.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  message: string;
  latencyMs: number;
}> {
  if (!isConfigured()) {
    return { ok: false, message: 'Shopify credentials not configured', latencyMs: 0 };
  }

  const start = Date.now();
  try {
    const res = await request('GET', '/shop.json');
    if (res.status >= 400) {
      return { ok: false, message: `HTTP ${res.status}`, latencyMs: Date.now() - start };
    }
    return { ok: true, message: `Connected to ${res.body.shop?.name || 'shop'}`, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, message: err.message, latencyMs: Date.now() - start };
  }
}
