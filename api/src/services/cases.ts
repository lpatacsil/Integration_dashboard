import { suiteQLAll, toNsDate } from './netsuite-client';
import { isConfigured as netsuiteConfigured } from './netsuite-auth';
import { lookupDraftsByName, isConfigured as shopifyConfigured } from './shopify-client';

// NetSuite "BLP Issue" cases (customrecord_issue_log, rectype 2049) linked to Shopify drafts:
// the case's Invoice / Order # is an SO created from a draft (memo #D…),
// or the case detail mentions a draft number that exists in Shopify.
// Filtered by the case's created date. Cached briefly since the flow tabs auto-refresh.
export interface RelatedCase {
  id: string;
  issue_id: string;
  detail: string;
  status: string;
  is_open: boolean;
  owner: string | null;
  assigned_to: string | null;
  customer: string | null;
  issue_type: string | null;
  sales_order: string | null;
  draft_number: string | null;
  created_date: string;
  url: string;
  integration_reason: string | null;   // why it looks like an integration case; null = other order work
}

const CASE_URL = (id: string) => `https://7106084.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=2049&id=${id}`;
const CACHE_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; value: RelatedCase[] }>();
const SO_NUMBER = /^SO\d+$/i;
// Matches "#D28627", "D28627" and "Draft order # D28627"
const DRAFT_MENTION = /#?\s*\bD\s?(\d{5,6})\b/gi;

// Integration cases are told apart from ordinary order work (freight, invoices…) by their wording
const INTEGRATION_PATTERNS: { reason: string; match: RegExp }[] = [
  { reason: 'Not porting to NetSuite', match: /\bnot\s+(porting|ported|port|syncing|synced|sync|showing|coming over|created)\b|didn'?t\s+(port|sync|come over)|\bteam\s*central\b|\bintegration\b/i },
  { reason: 'Item mapping', match: /\bre-?map|\bmapped\s+to\b|\bmapping\b|\bnot\s+mapped\b/i },
];

function integrationReason(text: string): string | null {
  return INTEGRATION_PATTERNS.find(p => p.match.test(text))?.reason ?? null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getRelatedCases(startDate: string, endDate: string): Promise<RelatedCase[] | null> {
  if (!netsuiteConfigured()) return null;
  const key = `${startDate}|${endDate}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const cases = await suiteQLAll(`
    SELECT id, name, custrecord_il_detail AS detail, BUILTIN.DF(custrecord_il_status) AS status,
           BUILTIN.DF(custrecord_il_owner) AS owner, BUILTIN.DF(custrecord_il_assigned_to) AS assigned_to,
           custrecord_il_customer AS customer, custrecord_il_issue_type AS issue_type,
           custrecord_il_invoice AS invoice, custrecord_il_created_date AS created_date
    FROM customrecord_issue_log
    WHERE custrecord_il_created_date >= '${toNsDate(startDate)}'
      AND custrecord_il_created_date <= '${toNsDate(endDate)}'
    ORDER BY id DESC
  `);

  // Look up the SOs the cases point at: were they created from a draft?
  const soNumbers = [...new Set(cases.map(c => String(c.invoice || '').trim().toUpperCase()).filter(n => SO_NUMBER.test(n)))];
  const soInfo = new Map<string, { memo: string | null }>();
  for (let i = 0; i < soNumbers.length; i += 200) {
    const list = soNumbers.slice(i, i + 200).map(n => `'${n}'`).join(',');
    const rows = await suiteQLAll(`
      SELECT tranid, memo
      FROM transaction WHERE type = 'SalesOrd' AND tranid IN (${list})
    `);
    for (const r of rows) soInfo.set(String(r.tranid).toUpperCase(), { memo: r.memo?.trim() || null });
  }

  // Draft numbers mentioned in case details only count if the draft really exists in Shopify
  const parsed = cases.map(c => {
    const text = htmlToText(String(c.detail || ''));
    const mentions = [...text.matchAll(DRAFT_MENTION)].map(m => `#D${m[1]}`);
    return { c, text, mentions };
  });
  const mentioned = [...new Set(parsed.flatMap(p => p.mentions))];
  const knownDrafts = shopifyConfigured() ? await lookupDraftsByName(mentioned) : new Map();

  const result: RelatedCase[] = [];
  for (const { c, text, mentions } of parsed) {
    const so = String(c.invoice || '').trim().toUpperCase();
    const info = soInfo.get(so);
    const soDraft = info?.memo && /^#D\d+$/.test(info.memo) ? info.memo : null;
    const draft = soDraft || mentions.find(d => knownDrafts.has(d)) || null;
    const status = c.status || 'Unknown';
    const row: RelatedCase = {
      id: String(c.id),
      issue_id: c.name,
      detail: text.length > 220 ? text.slice(0, 220) + '…' : text,
      status,
      is_open: status !== 'Closed',
      owner: c.owner || null,
      assigned_to: c.assigned_to || null,
      customer: c.customer || null,
      issue_type: c.issue_type || null,
      sales_order: info ? so : null,
      draft_number: draft,
      created_date: c.created_date,
      url: CASE_URL(String(c.id)),
      integration_reason: integrationReason(text),
    };
    if (draft) result.push(row);
  }

  cache.set(key, { at: Date.now(), value: result });
  return result;
}
