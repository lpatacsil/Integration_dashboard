import { fetchDraftsByDateRange, isConfigured as shopifyConfigured } from './shopify-client';
import { fetchSalesOrders } from './netsuite-sync';
import { isConfigured as netsuiteConfigured } from './netsuite-auth';
import type { OpenBlockingError } from '../severity';

// Order flow stats — follow each Shopify draft created in the range through both legs:
//   draft → NetSuite SO (SO memo = draft #) → SO marked integration ready → Shopify SO # matches a Shopify order.
// Ready + matching Shopify SO # = resolved; no SO, or ready without a Shopify order = error;
// otherwise (not ready yet, or too new to judge) = pending. Cached briefly since the overview auto-refreshes.
export interface OrderSyncStats {
  drafts: number;
  so_created: number;
  ready: number;
  resolved: number;
  errors: number;
  errors_no_so: number;
  errors_no_order: number;
  pending: number;
  pending_draft: number;   // draft too new to judge (S2N)
  pending_ready: number;   // SO created but not integration ready yet (N2S)
  unmatched: UnmatchedOrder[];   // each error as a blocking item, so it feeds the severity ladder
  outcomes: DraftOutcome[];      // one per draft, for the volume-by-outcome chart
}

export interface UnmatchedOrder extends OpenBlockingError {
  draft_number: string;
  customer: string | null;
  amount: string | null;
}

export interface DraftOutcome {
  created_at: string;
  outcome: 'ok' | 'er' | 'pe';
}

const ORDER_SYNC_CACHE_MS = 2 * 60 * 1000;
const ORDER_SYNC_GRACE_MINUTES = 15;   // same window the recon alerts wait before flagging a draft
const SO_LOOKAHEAD_DAYS = 7;           // an SO can be created a few days after its draft
const orderSyncCache = new Map<string, { at: number; value: Promise<OrderSyncStats> }>();
const DRAFT_MEMO = /^#D\d+$/;

function unmatchedItem(
  flowCode: string, ref: string, code: string, message: string, salesOrder: string | null, draft: Record<string, any>,
): UnmatchedOrder {
  const occurredAt: string = draft.created_at;
  return {
    draft_number: draft.draft_number, customer: draft.customer || null, amount: draft.total_price || null,
    error_id: `${code}:${ref}`, transaction_id: ref, flow_code: flowCode, entity_identifier: ref,
    error_code: code, error_message: message, occurred_at: occurredAt,
    sales_order_id: salesOrder, transaction_type: flowCode === 'S2N' ? 'Draft Order' : 'Sales Order',
  };
}

export async function getOrderSyncStats(startDate: string, endDate: string): Promise<OrderSyncStats | null> {
  if (!shopifyConfigured() || !netsuiteConfigured()) return null;
  const key = `${startDate}|${endDate}`;
  const cached = orderSyncCache.get(key);
  if (cached && Date.now() - cached.at < ORDER_SYNC_CACHE_MS) return cached.value;

  // Cache the in-flight fetch so the overview, trends and flow tabs share one round of API calls
  const value = computeOrderSyncStats(startDate, endDate);
  orderSyncCache.set(key, { at: Date.now(), value });
  value.catch(() => orderSyncCache.delete(key));
  return value;
}

// Shopify returns "#2029097"; tolerate a missing "#", stray spaces or case differences on the NetSuite side
function normalizeOrderName(name: string | null | undefined): string | null {
  const n = name?.replace(/\s+/g, '').replace(/^#/, '').toUpperCase();
  return n || null;
}

async function computeOrderSyncStats(startDate: string, endDate: string): Promise<OrderSyncStats> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const nsEnd = new Date(endDate + 'T00:00:00Z');
  nsEnd.setUTCDate(nsEnd.getUTCDate() + SO_LOOKAHEAD_DAYS);
  const nsEndStr = nsEnd.toISOString().slice(0, 10) < todayStr ? nsEnd.toISOString().slice(0, 10) : todayStr;

  const [drafts, netsuiteSOs] = await Promise.all([
    fetchDraftsByDateRange(startDate, endDate),
    fetchSalesOrders(startDate, nsEndStr),
  ]);
  // fetchSalesOrders swallows its errors; an outage must not turn every draft into "no SO"
  if (netsuiteSOs.source.startsWith('error')) throw new Error(`NetSuite sales order fetch failed (${netsuiteSOs.source})`);
  const soByMemo = new Map<string, Record<string, any>>();
  for (const so of netsuiteSOs.orders) {
    const memo = so.memo?.trim();
    if (memo && DRAFT_MEMO.test(memo)) soByMemo.set(memo, so);
  }

  const stats: OrderSyncStats = {
    drafts: drafts.size, so_created: 0, ready: 0, resolved: 0,
    errors: 0, errors_no_so: 0, errors_no_order: 0, pending: 0, pending_draft: 0, pending_ready: 0,
    unmatched: [], outcomes: [],
  };
  const now = Date.now();
  for (const [name, draft] of drafts) {
    const ageMin = (now - new Date(draft.created_at).getTime()) / 60000;
    const so = soByMemo.get(name);
    if (!so) {
      if (ageMin >= ORDER_SYNC_GRACE_MINUTES) {
        stats.errors_no_so++;
        stats.unmatched.push(unmatchedItem('S2N', name, 'UNMATCHED-SO', `${name} has no NetSuite sales order`, null, draft));
        stats.outcomes.push({ created_at: draft.created_at, outcome: 'er' });
      } else {
        stats.pending_draft++;
        stats.outcomes.push({ created_at: draft.created_at, outcome: 'pe' });
      }
      continue;
    }
    stats.so_created++;
    if (so.integration_ready !== 'T') {
      stats.pending_ready++;
      stats.outcomes.push({ created_at: draft.created_at, outcome: 'pe' });
      continue;
    }
    stats.ready++;
    // NetSuite's Shopify SO # must be filled in and be the order this draft became in Shopify
    const shopifyOrder: string | null = draft.shopify_order;
    const nsShopifySo: string | null = so.shopify_so?.trim() || null;
    if (nsShopifySo && normalizeOrderName(nsShopifySo) === normalizeOrderName(shopifyOrder)) {
      stats.resolved++;
      stats.outcomes.push({ created_at: draft.created_at, outcome: 'ok' });
    } else {
      stats.errors_no_order++;
      stats.unmatched.push(unmatchedItem('N2S', so.so_number, 'UNMATCHED-ORDER',
        nsShopifySo ? `${so.so_number} Shopify SO # ${nsShopifySo} does not match a Shopify order` : `${so.so_number} is integration ready but has no Shopify SO #`,
        so.so_number, draft));
      stats.outcomes.push({ created_at: draft.created_at, outcome: 'er' });
    }
  }
  stats.errors = stats.errors_no_so + stats.errors_no_order;
  stats.pending = stats.pending_draft + stats.pending_ready;

  return stats;
}
