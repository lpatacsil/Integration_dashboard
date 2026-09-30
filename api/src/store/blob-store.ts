import { ulid } from 'ulid';
import { readJson, readJsonCached, updateJson, writeJson, invalidateCache } from './blob-client';
import { getCategoryRules } from '../services/settings-store';
import type {
  Store, Transaction, IntegrationError, Rerun, IndexingActivity, Heartbeat,
  AlertIncident, AlertNotification, SeveritySnapshot, DateRange,
} from './types';

// ── Key helpers ──────────────────────────────────────────────────────────────

function dayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

function monthKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 7);
}

function daysBetween(range: DateRange): string[] {
  const keys: string[] = [];
  const cur = new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth(), range.start.getUTCDate()));
  const end = range.end;
  while (cur < end) {
    keys.push(dayKey(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return keys;
}

function monthsBack(count: number): string[] {
  const keys: string[] = [];
  const cur = new Date();
  for (let i = 0; i < count; i++) {
    keys.push(monthKey(cur));
    cur.setUTCMonth(cur.getUTCMonth() - 1);
  }
  return keys;
}

function inRange(iso: string, range: DateRange): boolean {
  const t = new Date(iso).getTime();
  return t >= range.start.getTime() && t < range.end.getTime();
}

// ── Generic day-file record store helpers ───────────────────────────────────

async function loadDayRecords<T>(prefix: string, key: string): Promise<Record<string, T>> {
  const data = await readJsonCached<Record<string, T>>(`${prefix}/${key}.json`, key);
  return data ?? {};
}

async function addDayRecord<T>(prefix: string, key: string, id: string, record: T): Promise<void> {
  await updateJson<Record<string, T>>(`${prefix}/${key}.json`, {}, (cur) => ({ ...cur, [id]: record }));
  invalidateCache(`${prefix}/${key}.json`);
}

async function patchDayRecord<T>(prefix: string, key: string, id: string, patch: Partial<T>): Promise<T> {
  const updated = await updateJson<Record<string, T>>(`${prefix}/${key}.json`, {}, (cur) => {
    const existing = cur[id];
    if (!existing) return cur;
    return { ...cur, [id]: { ...existing, ...patch } };
  });
  invalidateCache(`${prefix}/${key}.json`);
  return updated[id];
}

async function queryDayRange<T extends { [k: string]: any }>(
  prefix: string, range: DateRange, timestampField: string,
): Promise<T[]> {
  const keys = daysBetween(range);
  const allRecords = await Promise.all(keys.map(key => loadDayRecords<T>(prefix, key)));
  const results: T[] = [];
  for (const records of allRecords) {
    for (const rec of Object.values(records)) {
      if (inRange(rec[timestampField], range)) results.push(rec);
    }
  }
  return results;
}

// ── Index blob helpers (small JSON maps, read-modify-write) ─────────────────

const IDX = {
  txIdToDay: 'index/tx-id-to-day.json',
  txExternalId: 'index/tx-external-id.json',
  txSalesOrder: 'index/tx-sales-order.json',
  errorIdToDay: 'index/error-id-to-day.json',
  errorTxToIds: 'index/error-tx-to-ids.json',
  openErrorIds: 'index/open-error-ids.json',
  rerunIdToDay: 'index/rerun-id-to-day.json',
  rerunTxToIds: 'index/rerun-tx-to-ids.json',
  unsentNotifications: 'index/unsent-notifications.json',
  pendingTxIds: 'index/pending-tx-ids.json',
};

const PENDING_STATUSES = new Set(['PENDING', 'PROCESSING']);

// Cached like day-blobs (short TTL) — a single dashboard request often reads the
// same index blob many times (e.g. resolving many open errors' transactions).
async function indexGet<T>(path: string, fallback: T): Promise<T> {
  const data = await readJsonCached<T>(path, 'index');
  return data ?? fallback;
}

async function indexSet<T>(path: string, mutate: (cur: T) => T, fallback: T): Promise<void> {
  await updateJson<T>(path, fallback, mutate);
  invalidateCache(path);
}

// ── Category rule lookup (denormalizes what error_categories used to join) ──

function categoryFor(errorCode: string | null | undefined): { label: string | null; group: string | null; blocking: boolean } {
  const rule = getCategoryRules().find(c => c.code === errorCode);
  if (!rule) return { label: null, group: null, blocking: false };
  const blockingGroups = ['MAPPING', 'INDEXING'];
  return { label: rule.label, group: rule.group, blocking: blockingGroups.includes(rule.group) };
}

async function getErrorsForTransactionImpl(transactionId: string): Promise<IntegrationError[]> {
  const txIndex = await indexGet<Record<string, string[]>>(IDX.errorTxToIds, {});
  const ids = txIndex[transactionId] || [];
  if (ids.length === 0) return [];
  const dayMap = await indexGet<Record<string, string>>(IDX.errorIdToDay, {});
  const dayCache = new Map<string, Record<string, IntegrationError>>();
  const results: IntegrationError[] = [];
  for (const id of ids) {
    const key = dayMap[id];
    if (!key) continue;
    if (!dayCache.has(key)) dayCache.set(key, await loadDayRecords<IntegrationError>('errors', key));
    const rec = dayCache.get(key)![id];
    if (rec) results.push(rec);
  }
  results.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  return results;
}

/** Mark a superseded error not-current, without fully "resolving" it. */
async function markErrorNotCurrent(id: string): Promise<void> {
  const dayMap = await indexGet<Record<string, string>>(IDX.errorIdToDay, {});
  const key = dayMap[id];
  if (!key) return;
  await patchDayRecord<IntegrationError>('errors', key, id, { is_current: false });
  await indexSet(IDX.openErrorIds, (cur: string[]) => cur.filter(x => x !== id), []);
}

export function createBlobStore(): Store {
  return {
    // ── Transactions ──────────────────────────────────────────────────────

    async insertTransaction(input) {
      const now = new Date().toISOString();
      const tx: Transaction = {
        id: ulid(),
        created_at: input.created_at || now,
        updated_at: now,
        ...input,
      } as Transaction;

      const key = dayKey(tx.created_at);
      await addDayRecord('transactions', key, tx.id, tx);
      await indexSet(IDX.txIdToDay, (cur: Record<string, string>) => ({ ...cur, [tx.id]: key }), {});

      if (tx.external_id) {
        await indexSet(IDX.txExternalId, (cur: Record<string, string>) => ({ ...cur, [tx.external_id!]: tx.id }), {});
      }
      if (tx.sales_order_id) {
        await indexSet(IDX.txSalesOrder, (cur: Record<string, string[]>) => ({
          ...cur, [tx.sales_order_id!]: [...(cur[tx.sales_order_id!] || []), tx.id],
        }), {});
      }
      if (PENDING_STATUSES.has(tx.normalized_status)) {
        await indexSet(IDX.pendingTxIds, (cur: string[]) => [...cur, tx.id], []);
      }
      return tx;
    },

    async updateTransaction(id, patch) {
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      const key = dayMap[id];
      if (!key) return;
      const updated = await patchDayRecord<Transaction>('transactions', key, id, { ...patch, updated_at: new Date().toISOString() });

      if (patch.sales_order_id) {
        await indexSet(IDX.txSalesOrder, (cur: Record<string, string[]>) => ({
          ...cur, [patch.sales_order_id!]: [...new Set([...(cur[patch.sales_order_id!] || []), id])],
        }), {});
      }
      if (patch.normalized_status) {
        const stillPending = PENDING_STATUSES.has(updated.normalized_status);
        await indexSet(IDX.pendingTxIds, (cur: string[]) => {
          const without = cur.filter(x => x !== id);
          return stillPending ? [...without, id] : without;
        }, []);
      }
    },

    async getTransactionById(id) {
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      const key = dayMap[id];
      if (!key) return null;
      const records = await loadDayRecords<Transaction>('transactions', key);
      return records[id] ?? null;
    },

    async getTransactionBySalesOrderId(salesOrderId) {
      const soIndex = await indexGet<Record<string, string[]>>(IDX.txSalesOrder, {});
      const ids = soIndex[salesOrderId] || [];
      if (ids.length === 0) return null;
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      // Most recently added id first (matches `LIMIT 1` on a unique lookup in the old schema)
      for (const id of [...ids].reverse()) {
        const key = dayMap[id];
        if (!key) continue;
        const records = await loadDayRecords<Transaction>('transactions', key);
        if (records[id]) return records[id];
      }
      return null;
    },

    async queryTransactions(range) {
      return queryDayRange<Transaction>('transactions', range, 'created_at');
    },

    async findTransactionsNeedingNetsuiteSync(limit) {
      const soIndex = await indexGet<Record<string, string[]>>(IDX.txSalesOrder, {});
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      const candidates: Transaction[] = [];
      const dayCache = new Map<string, Record<string, Transaction>>();

      for (const [salesOrderId, ids] of Object.entries(soIndex)) {
        if (!salesOrderId.startsWith('SO')) continue;
        for (const id of ids) {
          const key = dayMap[id];
          if (!key) continue;
          if (!dayCache.has(key)) dayCache.set(key, await loadDayRecords<Transaction>('transactions', key));
          const tx = dayCache.get(key)![id];
          if (tx && !tx.netsuite_record_id) candidates.push(tx);
        }
      }
      candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return candidates.slice(0, limit);
    },

    async getPendingTransactions() {
      const ids = await indexGet<string[]>(IDX.pendingTxIds, []);
      if (ids.length === 0) return [];
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      const dayCache = new Map<string, Record<string, Transaction>>();
      const results: Transaction[] = [];
      for (const id of ids) {
        const key = dayMap[id];
        if (!key) continue;
        if (!dayCache.has(key)) dayCache.set(key, await loadDayRecords<Transaction>('transactions', key));
        const tx = dayCache.get(key)![id];
        if (tx && PENDING_STATUSES.has(tx.normalized_status)) results.push(tx);
      }
      return results;
    },

    async countNetsuiteSyncStatus() {
      const soIndex = await indexGet<Record<string, string[]>>(IDX.txSalesOrder, {});
      const dayMap = await indexGet<Record<string, string>>(IDX.txIdToDay, {});
      const dayCache = new Map<string, Record<string, Transaction>>();
      let pending = 0, enriched = 0;

      for (const [salesOrderId, ids] of Object.entries(soIndex)) {
        if (!salesOrderId.startsWith('SO')) continue;
        for (const id of ids) {
          const key = dayMap[id];
          if (!key) continue;
          if (!dayCache.has(key)) dayCache.set(key, await loadDayRecords<Transaction>('transactions', key));
          const tx = dayCache.get(key)![id];
          if (!tx) continue;
          if (tx.netsuite_record_id) enriched++; else pending++;
        }
      }
      return { pending, enriched };
    },

    // ── Errors ────────────────────────────────────────────────────────────

    async insertError(input) {
      const now = new Date().toISOString();
      const cat = categoryFor(input.error_code);
      const err: IntegrationError = {
        ...input,
        id: ulid(),
        created_at: now,
        category_label: input.category_label ?? cat.label,
        error_group: input.error_group ?? cat.group,
        is_blocking: input.is_blocking ?? cat.blocking,
      };

      // A new error for the same transaction supersedes the previous "current" one
      if (err.is_current) {
        const prior = await getErrorsForTransactionImpl(err.transaction_id);
        for (const p of prior) {
          if (p.is_current && !p.resolved_at) {
            await markErrorNotCurrent(p.id);
          }
        }
      }

      const key = dayKey(err.occurred_at);
      await addDayRecord('errors', key, err.id, err);
      await indexSet(IDX.errorIdToDay, (cur: Record<string, string>) => ({ ...cur, [err.id]: key }), {});
      await indexSet(IDX.errorTxToIds, (cur: Record<string, string[]>) => ({
        ...cur, [err.transaction_id]: [...(cur[err.transaction_id] || []), err.id],
      }), {});

      // Open incidents include blocking AND non-blocking unresolved/current errors
      // (matches the old v_open_incidents view) — only toOpenBlockingErrors() filters to blocking.
      if (!err.resolved_at && err.is_current) {
        await indexSet(IDX.openErrorIds, (cur: string[]) => [...cur, err.id], []);
      }
      return err;
    },

    async resolveError(id) {
      const dayMap = await indexGet<Record<string, string>>(IDX.errorIdToDay, {});
      const key = dayMap[id];
      if (!key) return;
      await patchDayRecord<IntegrationError>('errors', key, id, { resolved_at: new Date().toISOString() });
      await indexSet(IDX.openErrorIds, (cur: string[]) => cur.filter(x => x !== id), []);
    },

    async getErrorsForTransaction(transactionId) {
      return getErrorsForTransactionImpl(transactionId);
    },

    async queryErrors(range) {
      return queryDayRange<IntegrationError>('errors', range, 'occurred_at');
    },

    async getOpenErrors() {
      const ids = await indexGet<string[]>(IDX.openErrorIds, []);
      if (ids.length === 0) return [];
      const dayMap = await indexGet<Record<string, string>>(IDX.errorIdToDay, {});
      // Collect unique day keys and load all needed day-files in parallel
      const uniqueDays = new Set<string>();
      for (const id of ids) { const k = dayMap[id]; if (k) uniqueDays.add(k); }
      const dayEntries = await Promise.all(
        [...uniqueDays].map(async key => [key, await loadDayRecords<IntegrationError>('errors', key)] as const),
      );
      const dayCache = new Map(dayEntries);
      const results: IntegrationError[] = [];
      for (const id of ids) {
        const key = dayMap[id];
        if (!key) continue;
        const rec = dayCache.get(key)?.[id];
        if (rec && !rec.resolved_at && rec.is_current) results.push(rec);
      }
      results.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
      return results;
    },

    // ── Reruns ────────────────────────────────────────────────────────────

    async insertRerun(input) {
      const rerun: Rerun = { id: ulid(), ...input };
      const key = dayKey(rerun.started_at);
      await addDayRecord('reruns', key, rerun.id, rerun);
      await indexSet(IDX.rerunIdToDay, (cur: Record<string, string>) => ({ ...cur, [rerun.id]: key }), {});
      await indexSet(IDX.rerunTxToIds, (cur: Record<string, string[]>) => ({
        ...cur, [rerun.transaction_id]: [...(cur[rerun.transaction_id] || []), rerun.id],
      }), {});
      return rerun;
    },

    async queryReruns(range) {
      return queryDayRange<Rerun>('reruns', range, 'started_at');
    },

    async getRerunsForTransaction(transactionId) {
      const txIndex = await indexGet<Record<string, string[]>>(IDX.rerunTxToIds, {});
      const ids = txIndex[transactionId] || [];
      if (ids.length === 0) return [];
      const dayMap = await indexGet<Record<string, string>>(IDX.rerunIdToDay, {});
      const dayCache = new Map<string, Record<string, Rerun>>();
      const results: Rerun[] = [];
      for (const id of ids) {
        const key = dayMap[id];
        if (!key) continue;
        if (!dayCache.has(key)) dayCache.set(key, await loadDayRecords<Rerun>('reruns', key));
        const rec = dayCache.get(key)![id];
        if (rec) results.push(rec);
      }
      results.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
      return results;
    },

    // ── Indexing activity ─────────────────────────────────────────────────

    async insertIndexingActivity(input) {
      const activity: IndexingActivity = { id: ulid(), ...input };
      const key = dayKey(activity.created_at);
      await addDayRecord('indexing', key, activity.id, activity);
      return activity;
    },

    async queryIndexingActivity(range) {
      return queryDayRange<IndexingActivity>('indexing', range, 'created_at');
    },

    // ── Heartbeats ────────────────────────────────────────────────────────

    async recordHeartbeat(hb) {
      await writeJson('heartbeats/latest.json', hb);
      invalidateCache('heartbeats/latest.json');
    },

    async getLatestHeartbeat() {
      const { data } = await readJson<Heartbeat>('heartbeats/latest.json');
      return data;
    },

    // ── Alert incidents ───────────────────────────────────────────────────

    async getOpenIncidents() {
      const { data } = await readJson<AlertIncident[]>('alert-incidents/open.json');
      return data ?? [];
    },

    async upsertIncident(incident) {
      await updateJson<AlertIncident[]>('alert-incidents/open.json', [], (cur) => {
        const idx = cur.findIndex(i => i.id === incident.id);
        if (idx === -1) return [...cur, incident];
        const next = [...cur];
        next[idx] = incident;
        return next;
      });
    },

    async resolveIncident(id) {
      let resolved: AlertIncident | null = null;
      await updateJson<AlertIncident[]>('alert-incidents/open.json', [], (cur) => {
        resolved = cur.find(i => i.id === id) ?? null;
        return cur.filter(i => i.id !== id);
      });
      if (resolved) {
        const key = monthKey(new Date());
        await updateJson<AlertIncident[]>(`alert-incidents/history/${key}.json`, [], (cur) => [...cur, resolved!]);
      }
    },

    async getIncidentHistory(limit) {
      const open = await this.getOpenIncidents();
      const results: AlertIncident[] = [...open];
      for (const key of monthsBack(6)) {
        if (results.length >= limit) break;
        const { data } = await readJson<AlertIncident[]>(`alert-incidents/history/${key}.json`);
        if (data) results.push(...data);
      }
      results.sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
      return results.slice(0, limit);
    },

    // ── Alert notifications ───────────────────────────────────────────────

    async insertNotification(input) {
      const n: AlertNotification = { id: ulid(), created_at: new Date().toISOString(), ...input };
      const key = monthKey(n.created_at);
      await updateJson<AlertNotification[]>(`alert-notifications/${key}.json`, [], (cur) => [...cur, n]);
      if (!n.sent) {
        await indexSet(IDX.unsentNotifications, (cur: Array<{ id: string; month: string }>) => [
          ...cur, { id: n.id, month: key },
        ], []);
      }
      return n;
    },

    async getRecentNotifications(limit) {
      const results: AlertNotification[] = [];
      for (const key of monthsBack(6)) {
        if (results.length >= limit) break;
        const { data } = await readJson<AlertNotification[]>(`alert-notifications/${key}.json`);
        if (data) results.push(...data);
      }
      results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return results.slice(0, limit);
    },

    async getUnsentNotifications() {
      const pending = await indexGet<Array<{ id: string; month: string }>>(IDX.unsentNotifications, []);
      if (pending.length === 0) return [];
      const monthCache = new Map<string, AlertNotification[]>();
      const results: AlertNotification[] = [];
      for (const { id, month } of pending) {
        if (!monthCache.has(month)) {
          const { data } = await readJson<AlertNotification[]>(`alert-notifications/${month}.json`);
          monthCache.set(month, data ?? []);
        }
        const rec = monthCache.get(month)!.find(n => n.id === id);
        if (rec && !rec.sent) results.push(rec);
      }
      results.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      return results;
    },

    async markNotificationsSent(ids) {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      const pending = await indexGet<Array<{ id: string; month: string }>>(IDX.unsentNotifications, []);
      const monthsToUpdate = new Set(pending.filter(p => idSet.has(p.id)).map(p => p.month));

      for (const month of monthsToUpdate) {
        await updateJson<AlertNotification[]>(`alert-notifications/${month}.json`, [], (cur) =>
          cur.map(n => idSet.has(n.id) ? { ...n, sent: true, sent_at: new Date().toISOString() } : n));
      }
      await indexSet(IDX.unsentNotifications, (cur: Array<{ id: string; month: string }>) =>
        cur.filter(p => !idSet.has(p.id)), []);
    },

    // ── Severity snapshots ────────────────────────────────────────────────

    async insertSeveritySnapshot(input) {
      const snap: SeveritySnapshot = { id: ulid(), ...input };
      const key = monthKey(snap.evaluated_at);
      await updateJson<SeveritySnapshot[]>(`severity-snapshots/${key}.json`, [], (cur) => [...cur, snap]);
    },

    // ── Health ────────────────────────────────────────────────────────────

    async ping() {
      await readJson('heartbeats/latest.json');
    },
  };
}
