import { suiteQL, suiteQLAll, toNsDate } from './netsuite-client';
import { isConfigured } from './netsuite-auth';
import { fetchNSInternalErrors } from './netsuite-sync';

// Sales orders that reached NetSuite but have a problem inside it, by category:
//   TAX-VERTEX  Vertex tax call did not return Success
//   INV-ITEM    a line is backordered or uses an inactive item
//   VAL-DATA    open SO missing location / ship-to address, or a Shopify-draft SO missing its PO #
// One row per SO per category. Cached briefly since the tab auto-refreshes.
export interface NsIssue {
  category: 'TAX-VERTEX' | 'INV-ITEM' | 'VAL-DATA';
  so_id: string;
  so_number: string;
  draft_number: string | null;
  customer: string | null;
  detail: string;
  occurred_at: string;
  url: string;
}

export interface NsIssues {
  total_sos: number;
  issues: NsIssue[];
  source_errors: string[];   // queries that failed, so the tab can say a category is incomplete
}

const SO_URL = (id: string) => `https://7106084.app.netsuite.com/app/accounting/transactions/salesord.nl?id=${id}`;
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; value: NsIssues }>();
const DRAFT_MEMO = /^#D\d+$/;
// Cancelled / closed SOs don't need fixing
const INACTIVE_SO_STATUS = `('SalesOrd:C', 'SalesOrd:H')`;

function draftOf(memo: string | null | undefined): string | null {
  const m = memo?.trim();
  return m && DRAFT_MEMO.test(m) ? m : null;
}

async function vertexIssues(startDate: string, endDate: string): Promise<NsIssue[]> {
  const { vertex, source } = await fetchNSInternalErrors(startDate, endDate);
  if (source.startsWith('error')) throw new Error(source);
  const ids = [...new Set(vertex.errors.map(e => Number(e.transaction_id)).filter(n => Number.isInteger(n)))];
  const soById = new Map<string, Record<string, any>>();
  for (let i = 0; i < ids.length; i += 200) {
    const sos = await suiteQLAll(`
      SELECT id, tranid, memo, BUILTIN.DF(entity) AS customer
      FROM transaction WHERE id IN (${ids.slice(i, i + 200).join(',')})
    `);
    for (const s of sos) soById.set(String(s.id), s);
  }
  // Newest error per SO
  const seen = new Set<string>();
  const issues: NsIssue[] = [];
  for (const e of vertex.errors) {
    const id = String(e.transaction_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const so = soById.get(id);
    issues.push({
      category: 'TAX-VERTEX',
      so_id: id,
      so_number: so?.tranid || `#${id}`,
      draft_number: draftOf(so?.memo),
      customer: so?.customer || null,
      detail: e.error_message,
      occurred_at: e.occurred_at,
      url: SO_URL(id),
    });
  }
  return issues;
}

async function inventoryIssues(startDate: string, endDate: string): Promise<NsIssue[]> {
  const rows = await suiteQLAll(`
    SELECT t.id, t.tranid, t.memo, BUILTIN.DF(t.entity) AS customer, t.trandate,
           BUILTIN.DF(tl.item) AS item, tl.quantitybackordered AS backordered, i.isinactive AS item_inactive
    FROM transaction t
    JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN item i ON i.id = tl.item
    WHERE t.type = 'SalesOrd'
      AND t.status NOT IN ${INACTIVE_SO_STATUS}
      AND t.trandate >= '${toNsDate(startDate)}' AND t.trandate <= '${toNsDate(endDate)}'
      AND tl.mainline = 'F' AND tl.taxline = 'F' AND tl.isclosed = 'F'
      AND (NVL(tl.quantitybackordered, 0) <> 0 OR i.isinactive = 'T')
    ORDER BY t.id DESC
  `);
  const bySo = new Map<string, { row: Record<string, any>; problems: string[] }>();
  for (const r of rows) {
    const id = String(r.id);
    const entry = bySo.get(id) || { row: r, problems: [] };
    if (r.item_inactive === 'T') entry.problems.push(`${r.item}: inactive item`);
    const bo = Math.abs(Number(r.backordered) || 0);
    if (bo > 0) entry.problems.push(`${r.item}: ${bo} backordered`);
    bySo.set(id, entry);
  }
  return [...bySo.entries()].map(([id, { row, problems }]) => ({
    category: 'INV-ITEM' as const,
    so_id: id,
    so_number: row.tranid,
    draft_number: draftOf(row.memo),
    customer: row.customer || null,
    detail: problems.join('; '),
    occurred_at: row.trandate,
    url: SO_URL(id),
  }));
}

async function validationIssues(startDate: string, endDate: string): Promise<NsIssue[]> {
  // The SO's location lives on its main line, not the transaction header
  const rows = await suiteQLAll(`
    SELECT t.id, t.tranid, t.memo, BUILTIN.DF(t.entity) AS customer, t.trandate,
           ml.location, t.shippingaddress, t.otherrefnum
    FROM transaction t
    JOIN transactionline ml ON ml.transaction = t.id AND ml.mainline = 'T'
    WHERE t.type = 'SalesOrd'
      AND t.status NOT IN ${INACTIVE_SO_STATUS}
      AND t.trandate >= '${toNsDate(startDate)}' AND t.trandate <= '${toNsDate(endDate)}'
      AND (ml.location IS NULL OR t.shippingaddress IS NULL OR t.otherrefnum IS NULL)
    ORDER BY t.id DESC
  `);
  const issues: NsIssue[] = [];
  for (const r of rows) {
    const draft = draftOf(r.memo);
    const missing: string[] = [];
    if (!r.location) missing.push('location');
    if (!r.shippingaddress) missing.push('ship-to address');
    // Shopify sends the PO number with the draft, so it's only required on draft-originated SOs
    if (!r.otherrefnum && draft) missing.push('PO #');
    if (missing.length === 0) continue;
    issues.push({
      category: 'VAL-DATA',
      so_id: String(r.id),
      so_number: r.tranid,
      draft_number: draft,
      customer: r.customer || null,
      detail: `Missing ${missing.join(', ')}`,
      occurred_at: r.trandate,
      url: SO_URL(String(r.id)),
    });
  }
  return issues;
}

export async function getNsIssues(startDate: string, endDate: string): Promise<NsIssues | null> {
  if (!isConfigured()) return null;
  const key = `${startDate}|${endDate}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const source_errors: string[] = [];
  const guard = (label: string, p: Promise<NsIssue[]>) => p.catch(err => {
    console.error(`[ns-internal] ${label} query failed:`, err.message);
    source_errors.push(`${label}: ${err.message}`);
    return [] as NsIssue[];
  });

  const [vertex, inventory, validation, totalRes] = await Promise.all([
    guard('Vertex', vertexIssues(startDate, endDate)),
    guard('Inventory', inventoryIssues(startDate, endDate)),
    guard('Validation', validationIssues(startDate, endDate)),
    // Same scope as the checks (open SOs only), so the passed / success-rate figures line up
    suiteQL(`
      SELECT COUNT(id) AS cnt FROM transaction
      WHERE type = 'SalesOrd' AND status NOT IN ${INACTIVE_SO_STATUS}
        AND trandate >= '${toNsDate(startDate)}' AND trandate <= '${toNsDate(endDate)}'
    `, 1, 0).catch(err => {
      console.error('[ns-internal] SO count query failed:', err.message);
      source_errors.push(`SO count: ${err.message}`);
      return null;
    }),
  ]);

  const value: NsIssues = {
    total_sos: Number(totalRes?.items[0]?.cnt) || 0,
    issues: [...vertex, ...inventory, ...validation],
    source_errors,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
