// Pure in-memory replacements for the SQL views / inline GROUP BY-FILTER queries
// that used to run against Postgres. Routes load raw rows via the Store, then
// call these functions to compute the same numbers the old SQL did.

import type { Transaction, IntegrationError, Rerun, IndexingActivity } from './types';
import type { OpenBlockingError } from '../severity';

const PENDING_RERUN_STATUSES = new Set(['PENDING', 'RETRY', 'PROCESSING']);
const MAP_CODES = new Set(['MAP-CUST', 'MAP-ITEM', 'MAP-SHIP', 'MAP-LOC']);

export function dayKeyUTC(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map(r => [r.id, r]));
}

export function groupErrorsByTransaction(errors: IntegrationError[]): Map<string, IntegrationError[]> {
  const map = new Map<string, IntegrationError[]>();
  for (const e of errors) {
    const list = map.get(e.transaction_id) || [];
    list.push(e);
    map.set(e.transaction_id, list);
  }
  return map;
}

/** Errors whose parent transaction matches the given flow code. */
export function errorsForFlow(
  errors: IntegrationError[], transactionsById: Map<string, Transaction>, flowCode: string,
): IntegrationError[] {
  return errors.filter(e => transactionsById.get(e.transaction_id)?.flow_code === flowCode);
}

// ── Open blocking / open incidents (was v_open_blocking_errors / v_open_incidents) ──

export function toOpenBlockingErrors(
  openErrors: IntegrationError[], transactionsById: Map<string, Transaction>,
): OpenBlockingError[] {
  return openErrors
    .filter(e => e.is_blocking)
    .map(e => {
      const tx = transactionsById.get(e.transaction_id);
      return {
        error_id: e.id,
        transaction_id: e.transaction_id,
        flow_code: tx?.flow_code || '',
        entity_identifier: tx?.entity_identifier || '',
        error_code: e.error_code || '',
        error_message: e.error_message,
        occurred_at: e.occurred_at,
      };
    });
}

export function toOpenIncidents(openErrors: IntegrationError[], transactionsById: Map<string, Transaction>) {
  const now = Date.now();
  return openErrors
    .map(e => {
      const tx = transactionsById.get(e.transaction_id);
      return {
        error_id: e.id,
        transaction_id: e.transaction_id,
        flow_code: tx?.flow_code,
        entity_identifier: tx?.entity_identifier,
        transaction_type: tx?.transaction_type,
        error_code: e.error_code,
        error_group: e.error_group,
        category_label: e.category_label,
        is_blocking: e.is_blocking,
        error_message: e.error_message,
        raw_error: e.raw_error,
        retry_count: e.retry_count,
        occurred_at: e.occurred_at,
        age_minutes: (now - new Date(e.occurred_at).getTime()) / 60000,
      };
    })
    .sort((a, b) => new Date(b.occurred_at!).getTime() - new Date(a.occurred_at!).getTime());
}

// ── Flow / KPI stats ─────────────────────────────────────────────────────────

export interface FlowCardStats {
  total: number; succeeded: number; errored: number; pending_rerun: number; reruns: number;
}

/** Matches overview.ts's per-flow flowStatsRes query. */
export function computeFlowCardStats(transactions: Transaction[]): FlowCardStats {
  let total = 0, succeeded = 0, errored = 0, pending_rerun = 0, reruns = 0;
  for (const t of transactions) {
    total++;
    if (t.normalized_status === 'SUCCESS') succeeded++;
    if (t.normalized_status === 'FAILED') errored++;
    if (PENDING_RERUN_STATUSES.has(t.normalized_status)) pending_rerun++;
    if (t.is_rerun) reruns++;
  }
  return { total, succeeded, errored, pending_rerun, reruns };
}

export function groupByFlow<T>(transactions: Transaction[], compute: (rows: Transaction[]) => T): Record<string, T> {
  const byFlow = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const list = byFlow.get(t.flow_code) || [];
    list.push(t);
    byFlow.set(t.flow_code, list);
  }
  const out: Record<string, T> = {};
  for (const [flow, rows] of byFlow) out[flow] = compute(rows);
  return out;
}

export interface FlowKpi {
  total: number; succeeded: number; errored: number; pending: number; reruns: number; reruns_succeeded: number;
}

/**
 * Matches flows.ts's kpiRes query. `isErroredOverride` lets the NS flow count only
 * FAILED transactions that have an associated NETSUITE-group error (the EXISTS subquery).
 */
export function computeFlowKpi(
  transactions: Transaction[], isErroredOverride?: (t: Transaction) => boolean,
): FlowKpi {
  let total = 0, succeeded = 0, errored = 0, pending = 0, reruns = 0, reruns_succeeded = 0;
  for (const t of transactions) {
    total++;
    if (t.normalized_status === 'SUCCESS') succeeded++;
    const isErrored = t.normalized_status === 'FAILED' && (!isErroredOverride || isErroredOverride(t));
    if (isErrored) errored++;
    if (PENDING_RERUN_STATUSES.has(t.normalized_status)) pending++;
    if (t.is_rerun) {
      reruns++;
      if (t.normalized_status === 'SUCCESS') reruns_succeeded++;
    }
  }
  return { total, succeeded, errored, pending, reruns, reruns_succeeded };
}

// ── Trends (hour/day buckets) ────────────────────────────────────────────────

export interface TrendBucket { bucket: number | string; ok: number; er: number; pe: number }

export function computeHourBuckets(transactions: Transaction[]): TrendBucket[] {
  const buckets = new Map<number, { ok: number; er: number; pe: number }>();
  for (const t of transactions) {
    const hour = new Date(t.created_at).getUTCHours();
    const b = buckets.get(hour) || { ok: 0, er: 0, pe: 0 };
    if (t.normalized_status === 'SUCCESS') b.ok++;
    if (t.normalized_status === 'FAILED') b.er++;
    if (PENDING_RERUN_STATUSES.has(t.normalized_status)) b.pe++;
    buckets.set(hour, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, v]) => ({ bucket, ...v }));
}

export function computeDayBuckets(transactions: Transaction[]): TrendBucket[] {
  const buckets = new Map<string, { ok: number; er: number; pe: number }>();
  for (const t of transactions) {
    const day = dayKeyUTC(t.created_at);
    const b = buckets.get(day) || { ok: 0, er: 0, pe: 0 };
    if (t.normalized_status === 'SUCCESS') b.ok++;
    if (t.normalized_status === 'FAILED') b.er++;
    if (PENDING_RERUN_STATUSES.has(t.normalized_status)) b.pe++;
    buckets.set(day, b);
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([bucket, v]) => ({ bucket, ...v }));
}

// ── Sparklines / daily breakdowns ────────────────────────────────────────────

/** Errors-per-day sparkline for the last N days (inclusive of today). */
export function computeErrorSparkline(transactions: Transaction[], days = 14): number[] {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    if (t.normalized_status !== 'FAILED') continue;
    const day = dayKeyUTC(t.created_at);
    counts.set(day, (counts.get(day) || 0) + 1);
  }
  const points: number[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - d);
    points.push(counts.get(day.toISOString().slice(0, 10)) || 0);
  }
  return points;
}

export interface DailyBreakdownRow { day: string; ok: number; errors: number; reruns: number }

/** Matches flows.ts's dailyRes query: last N days, newest first. */
export function computeDailyBreakdown(transactions: Transaction[], limit = 10): DailyBreakdownRow[] {
  const byDay = new Map<string, DailyBreakdownRow>();
  for (const t of transactions) {
    const day = dayKeyUTC(t.created_at);
    const row = byDay.get(day) || { day, ok: 0, errors: 0, reruns: 0 };
    if (t.normalized_status === 'SUCCESS') row.ok++;
    if (t.normalized_status === 'FAILED') row.errors++;
    if (t.is_rerun) row.reruns++;
    byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, limit);
}

// ── Error category summary (was v_error_category_summary) ───────────────────

export interface ErrorCategoryRow {
  error_code: string | null; category_label: string | null; error_group: string | null;
  is_blocking: boolean; count: number;
}

export function computeErrorCategorySummary(errors: IntegrationError[]): ErrorCategoryRow[] {
  const byCode = new Map<string, ErrorCategoryRow>();
  for (const e of errors) {
    const key = e.error_code || 'UNKNOWN';
    const row = byCode.get(key) || {
      error_code: e.error_code, category_label: e.category_label,
      error_group: e.error_group, is_blocking: e.is_blocking, count: 0,
    };
    row.count++;
    byCode.set(key, row);
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

// ── Rerun summary (integration_reruns table, distinct from Transaction.is_rerun) ──

export interface RerunAgg { total: number; succeeded: number; failed: number; in_progress: number }

export function computeRerunAgg(reruns: Rerun[]): RerunAgg {
  let total = 0, succeeded = 0, failed = 0, in_progress = 0;
  for (const r of reruns) {
    total++;
    if (r.status === 'SUCCESS') succeeded++;
    if (r.status === 'FAILED') failed++;
    if (r.status === 'PROCESSING' || r.status === 'PENDING') in_progress++;
  }
  return { total, succeeded, failed, in_progress };
}

// ── Indexing summary ─────────────────────────────────────────────────────────

export interface IndexingSummaryRow {
  index_type: string; total: number; succeeded: number; failed: number; pending: number;
}

export function computeIndexingSummary(activities: IndexingActivity[]): IndexingSummaryRow[] {
  const byType = new Map<string, IndexingSummaryRow>();
  for (const a of activities) {
    const row = byType.get(a.index_type) || { index_type: a.index_type, total: 0, succeeded: 0, failed: 0, pending: 0 };
    row.total++;
    if (a.status === 'SUCCESS') row.succeeded++;
    if (a.status === 'FAILED') row.failed++;
    if (a.status === 'PENDING') row.pending++;
    byType.set(a.index_type, row);
  }
  return [...byType.values()].sort((a, b) => b.total - a.total);
}

// ── Baseline / zero-traffic check (overview.ts + alert-engine.ts) ──────────

export function computeTxLast60(transactions: Transaction[], now: Date): number {
  const cutoff = now.getTime() - 60 * 60000;
  return transactions.filter(t => t.flow_code !== 'NS' && new Date(t.created_at).getTime() > cutoff).length;
}

/** 4-week average for this hour on this weekday, from transactions in the last 28 days. */
export function computeBaselineLast60(last28Days: Transaction[], now: Date): number {
  const count = last28Days.filter(t => {
    if (t.flow_code === 'NS') return false;
    const created = new Date(t.created_at);
    return created.getUTCDay() === now.getUTCDay() && created.getUTCHours() === now.getUTCHours();
  }).length;
  return Math.round(count / 4);
}

// ── Threshold checks (alerts.ts / alert-engine.ts) ──────────────────────────

export interface FlowCounts { errors: number; reruns: number }

export function computeThresholdFlowCounts(transactions: Transaction[]): Record<string, FlowCounts> {
  return groupByFlow(transactions, (rows) => {
    let errors = 0, reruns = 0;
    for (const t of rows) {
      if (t.normalized_status === 'FAILED') errors++;
      if (t.is_rerun) reruns++;
    }
    return { errors, reruns };
  });
}

export function computeNsCategoryCounts(nsErrors: IntegrationError[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of nsErrors) {
    const code = e.error_code || 'UNKNOWN';
    counts[code] = (counts[code] || 0) + 1;
  }
  return counts;
}

export function computeStalePending(
  transactions: Transaction[], thresholdHours: number, now: Date,
): { count: number; ids: string[] } {
  const cutoff = now.getTime() - thresholdHours * 60 * 60000;
  const matches = transactions.filter(t =>
    (t.normalized_status === 'PENDING' || t.normalized_status === 'PROCESSING') &&
    new Date(t.created_at).getTime() < cutoff);
  return { count: matches.length, ids: matches.map(t => t.entity_identifier || '') };
}

// ── IDX "indexing needs" (flows.ts) ─────────────────────────────────────────

export function computeIndexingNeedsSummary(
  rangeErrors: IntegrationError[], transactionsById: Map<string, Transaction>,
) {
  const mapErrors = rangeErrors.filter(e => MAP_CODES.has(e.error_code || ''));
  const byCode = new Map<string, { error_code: string; category_label: string | null; error_count: number; orders: Set<string> }>();
  for (const e of mapErrors) {
    const code = e.error_code!;
    const row = byCode.get(code) || { error_code: code, category_label: e.category_label, error_count: 0, orders: new Set<string>() };
    row.error_count++;
    const tx = transactionsById.get(e.transaction_id);
    if (tx?.entity_identifier) row.orders.add(tx.entity_identifier);
    byCode.set(code, row);
  }
  const summary = [...byCode.values()]
    .map(r => ({ error_code: r.error_code, category_label: r.category_label, error_count: r.error_count, order_count: r.orders.size }))
    .sort((a, b) => b.error_count - a.error_count);
  return {
    summary,
    totalErrors: summary.reduce((s, r) => s + r.error_count, 0),
    totalOrders: summary.reduce((s, r) => s + r.order_count, 0),
  };
}

export function computeIndexingNeedsOpenOrders(openErrors: IntegrationError[], transactionsById: Map<string, Transaction>) {
  const now = Date.now();
  return openErrors
    .filter(e => MAP_CODES.has(e.error_code || ''))
    .map(e => {
      const tx = transactionsById.get(e.transaction_id);
      return {
        entity_identifier: tx?.entity_identifier,
        transaction_type: tx?.transaction_type,
        error_code: e.error_code,
        category_label: e.category_label,
        error_message: e.error_message,
        occurred_at: e.occurred_at,
        age_minutes: (now - new Date(e.occurred_at).getTime()) / 60000,
      };
    })
    .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
}
