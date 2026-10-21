<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { fetchJSON, postJSON } from '../composables/useApi'
import KpiCard from './KpiCard.vue'
import type { ReconciliationResponse, ReconRecord, ReconSyncStatus, ResolvedDraft } from '../types'
import { formatAge } from '../types'

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}
function mondayThisWeek(): string {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
}

const rangeKey = ref('week')
const startDate = ref(mondayThisWeek())
const endDate = ref(todayStr())
const search = ref('')

const ranges = [
  { key: 'week', label: 'This week' },
  { key: '30', label: 'Last 30 days' },
  { key: 'all', label: 'Since Jun 1' },
  { key: 'custom', label: 'Custom' },
]

function setRange(key: string) {
  rangeKey.value = key
  switch (key) {
    case 'week':
      startDate.value = mondayThisWeek()
      endDate.value = todayStr()
      break
    case '30':
      startDate.value = daysAgo(29)
      endDate.value = todayStr()
      break
    case 'all':
      startDate.value = '2026-06-01'
      endDate.value = todayStr()
      break
  }
  load()
}

const data = ref<ReconciliationResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const lastLoadMs = ref(0)

async function load() {
  loading.value = true
  error.value = null
  const t0 = Date.now()
  try {
    data.value = await fetchJSON<ReconciliationResponse>('/reconciliation', {
      startDate: startDate.value,
      endDate: endDate.value,
    })
    lastLoadMs.value = Date.now() - t0
  } catch (err: any) {
    error.value = err.message
    data.value = null
  } finally {
    loading.value = false
  }
}

// Background sync status — polls automatically every 30s
const syncStatus = ref<ReconSyncStatus | null>(null)
let syncTimer: ReturnType<typeof setInterval> | null = null

const syncRunning = ref(false)
const nextSyncSec = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

async function fetchSyncStatus() {
  try {
    syncStatus.value = await fetchJSON<ReconSyncStatus>('/reconciliation/sync-status')
    if (syncStatus.value?.last_sync_at) {
      const elapsed = (Date.now() - new Date(syncStatus.value.last_sync_at).getTime()) / 1000
      nextSyncSec.value = Math.max(0, Math.round(300 - elapsed))
    }
  } catch { /* silent */ }
}

async function triggerSync() {
  syncRunning.value = true
  try {
    syncStatus.value = await postJSON<ReconSyncStatus>('/reconciliation/sync')
    nextSyncSec.value = 300
  } catch { /* silent */ }
  syncRunning.value = false
}

function tickCountdown() {
  if (nextSyncSec.value > 0) nextSyncSec.value--
}

const nextSyncLabel = computed(() => {
  const s = nextSyncSec.value
  if (s <= 0) return 'any moment'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
})

onMounted(() => {
  load()
  fetchSyncStatus()
  syncTimer = setInterval(fetchSyncStatus, 30_000)
  countdownTimer = setInterval(tickCountdown, 1000)
})

onUnmounted(() => {
  if (syncTimer) clearInterval(syncTimer)
  if (countdownTimer) clearInterval(countdownTimer)
})

const PAGE_SIZE = 100
const page = ref(1)

const searched = computed<ReconRecord[]>(() => {
  if (!data.value) return []
  const q = search.value.trim().toLowerCase()
  if (!q) return data.value.records
  return data.value.records.filter(r =>
    (r.netsuite_so || '').toLowerCase().includes(q) ||
    (r.netsuite_memo || '').toLowerCase().includes(q) ||
    (r.netsuite_customer || '').toLowerCase().includes(q) ||
    (r.netsuite_shopify_so || '').toLowerCase().includes(q) ||
    (r.shopify_draft || '').toLowerCase().includes(q) ||
    (r.shopify_customer || '').toLowerCase().includes(q) ||
    (r.shopify_order || '').toLowerCase().includes(q)
  )
})

// Column sorting — click a header to sort ascending, click again for descending
type SortKind = 'text' | 'number' | 'date'
const SORT_COLUMNS: Record<string, { kind: SortKind; value: (r: ReconRecord) => string | null }> = {
  status:            { kind: 'text',   value: r => statusLabel(r.status) },
  shopify_draft:     { kind: 'text',   value: r => r.shopify_draft },
  shopify_so:        { kind: 'text',   value: r => r.netsuite_shopify_so || r.shopify_order },
  shopify_customer:  { kind: 'text',   value: r => r.shopify_customer },
  shopify_amount:    { kind: 'number', value: r => r.shopify_amount },
  shopify_created:   { kind: 'date',   value: r => r.shopify_created },
  netsuite_so:       { kind: 'text',   value: r => r.netsuite_so },
  netsuite_memo:     { kind: 'text',   value: r => r.netsuite_memo },
  netsuite_customer: { kind: 'text',   value: r => r.netsuite_customer },
  netsuite_amount:   { kind: 'number', value: r => r.netsuite_amount },
  netsuite_date:     { kind: 'date',   value: r => r.netsuite_date },
}
const sortKey = ref<string | null>(null)
const sortDir = ref<'asc' | 'desc'>('asc')

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
  page.value = 1
}

function sortIndicator(key: string): string {
  if (sortKey.value !== key) return '↕'
  return sortDir.value === 'asc' ? '▲' : '▼'
}

const sorted = computed<ReconRecord[]>(() => {
  const col = sortKey.value ? SORT_COLUMNS[sortKey.value] : null
  if (!col) return searched.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  const toComparable = (v: string | null): number | string | null => {
    if (v == null || v === '') return null
    if (col.kind === 'number') { const n = Number(v); return isNaN(n) ? null : n }
    if (col.kind === 'date') { const t = new Date(v).getTime(); return isNaN(t) ? null : t }
    return v.toLowerCase()
  }
  return [...searched.value].sort((a, b) => {
    const va = toComparable(col.value(a))
    const vb = toComparable(col.value(b))
    // Empty values always go last, regardless of direction
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    if (va < vb) return -1 * dir
    if (va > vb) return 1 * dir
    return 0
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / PAGE_SIZE)))

const filtered = computed<ReconRecord[]>(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return sorted.value.slice(start, start + PAGE_SIZE)
})

watch(search, () => { page.value = 1 })

function goPage(p: number) {
  page.value = Math.max(1, Math.min(p, totalPages.value))
}

const matchRate = computed(() => {
  if (!data.value?.summary) return '—'
  const s = data.value.summary
  const total = s.matched + s.missing_in_netsuite + s.missing_in_shopify
  if (!total) return '—'
  return `${((s.matched / total) * 100).toFixed(1)}%`
})

function formatCurrency(val: string | null): string {
  if (val == null) return '—'
  return Number(val).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Manila',
  })
}

function statusLabel(s: string): string {
  switch (s) {
    case 'matched': return 'Matched'
    case 'missing_in_netsuite': return 'No SO created'
    case 'missing_in_shopify': return 'Draft not found'
    case 'no_memo': return 'No draft memo'
    default: return s
  }
}

function statusClass(s: string): string {
  switch (s) {
    case 'matched': return 'ok'
    case 'missing_in_netsuite': return 'alert'
    case 'missing_in_shopify': return 'warnp'
    default: return ''
  }
}

function formatSyncTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
</script>

<template>
  <section class="panel on">
    <!-- Unified header: title + KPIs -->
    <div class="recon-header">
      <div class="section-title" style="margin:0;padding:0;">
        NetSuite &harr; Shopify Reconciliation
        <span class="pill" :class="data?.summary && (data.summary.missing_in_netsuite > 0 || data.summary.missing_in_shopify > 0) ? 's3' : 'ok'">
          {{ data?.summary && (data.summary.missing_in_netsuite > 0 || data.summary.missing_in_shopify > 0) ? 'Issues found' : 'Healthy' }}
        </span>
        <span class="hint">Cross-system order matching — Shopify drafts matched to NetSuite SOs by memo</span>
      </div>
      <div class="row kpi" v-if="data?.summary" style="margin-top:10px;">
        <KpiCard label="Shopify Drafts" :value="data.summary.shopify_drafts" detail="in selected range" />
        <KpiCard label="NetSuite SOs" :value="data.summary.netsuite_sos" detail="in selected range" />
        <KpiCard label="Matched" :value="data.summary.matched" :detail="`${matchRate} match rate`" />
        <KpiCard
          label="No SO Created"
          :value="data.summary.missing_in_netsuite"
          detail="sync error — needs fix"
          :value-class="data.summary.missing_in_netsuite > 0 ? 'bad' : ''"
        />
        <KpiCard
          label="Draft not found"
          :value="data.summary.missing_in_shopify"
          detail="memo references missing draft"
          :value-class="data.summary.missing_in_shopify > 0 ? 'warnv' : ''"
        />
        <KpiCard
          v-if="syncStatus"
          label="Sync Errors"
          :value="syncStatus.unmatched_drafts.length"
          :detail="syncStatus.last_sync_at ? `last check ${formatSyncTime(syncStatus.last_sync_at)}` : 'waiting for first sync'"
          :value-class="syncStatus.unmatched_drafts.length > 0 ? 'bad' : ''"
        />
      </div>
    </div>

    <!-- Sync Monitor — always visible proof the sync is running -->
    <div v-if="syncStatus" class="card sync-card">
      <div class="sync-header">
        <div class="sync-title">
          <span class="sync-dot" :class="syncStatus.error ? 'err' : 'live'"></span>
          <strong>Background Sync Monitor</strong>
          <span class="pill" :class="syncStatus.error ? 's3' : 'ok'" style="margin-left:6px;">
            {{ syncStatus.error ? 'Error' : 'Running' }}
          </span>
        </div>
        <button class="sync-btn" @click="triggerSync" :disabled="syncRunning">
          {{ syncRunning ? 'Syncing...' : 'Sync Now' }}
        </button>
      </div>
      <div class="sync-grid">
        <div class="sync-stat">
          <span class="sync-label">Last Sync</span>
          <span class="sync-value">{{ syncStatus.last_sync_at ? formatSyncTime(syncStatus.last_sync_at) : 'Waiting...' }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Next Sync</span>
          <span class="sync-value">{{ nextSyncLabel }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Checks Run</span>
          <span class="sync-value">{{ syncStatus.sync_count }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Last Duration</span>
          <span class="sync-value">{{ syncStatus.last_sync_duration_ms ? (syncStatus.last_sync_duration_ms / 1000).toFixed(1) + 's' : '—' }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Shopify Drafts Scanned</span>
          <span class="sync-value">{{ syncStatus.shopify_drafts }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">NetSuite SOs Scanned</span>
          <span class="sync-value">{{ syncStatus.netsuite_sos }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Matched</span>
          <span class="sync-value" style="color:#22c55e;">{{ syncStatus.matched_count }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Unmatched</span>
          <span class="sync-value" :style="syncStatus.unmatched_drafts.length > 0 ? 'color:#dc2626;font-weight:700;' : ''">{{ syncStatus.unmatched_drafts.length }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Resolved</span>
          <span class="sync-value">{{ syncStatus.resolved_drafts.length }}</span>
        </div>
        <div class="sync-stat">
          <span class="sync-label">Notifications Sent</span>
          <span class="sync-value">{{ syncStatus.notifications_sent }}</span>
        </div>
      </div>
      <div v-if="syncStatus.error" class="sync-error">{{ syncStatus.error }}</div>
    </div>
    <div v-else class="card sync-card">
      <div class="sync-header">
        <div class="sync-title">
          <span class="sync-dot waiting"></span>
          <strong>Background Sync Monitor</strong>
          <span class="pill s3" style="margin-left:6px;">Starting...</span>
        </div>
      </div>
      <div class="empty">Waiting for first sync check (runs 10s after server start)...</div>
    </div>

    <!-- Alert banners -->
    <div v-if="data?.summary && data.summary.missing_in_netsuite > 0" class="alert-banner">
      <strong>&#9888; {{ data.summary.missing_in_netsuite }} Shopify draft{{ data.summary.missing_in_netsuite > 1 ? 's' : '' }} with no NetSuite SO</strong>
      — these drafts were created in Shopify but no Sales Order was synced. Check Team Central for sync errors.
    </div>

    <div v-if="data?.summary && data.summary.missing_in_shopify > 0" class="alert-banner warn">
      <strong>&#9888; {{ data.summary.missing_in_shopify }} NetSuite SO{{ data.summary.missing_in_shopify > 1 ? 's' : '' }} with draft not found in Shopify</strong>
      — the memo references a draft that doesn't exist in Shopify.
    </div>

    <!-- Unmatched drafts from background sync -->
    <div v-if="syncStatus && syncStatus.unmatched_drafts.length > 0" class="card unmatched-card">
      <h3>
        <span class="pill alert">{{ syncStatus.unmatched_drafts.length }}</span>
        Unmatched Shopify Drafts — Possible Team Central Errors
        <span class="hint">Background sync every 5 min · alerts after 15 min · Teams + email notifications</span>
      </h3>
      <div class="tablewrap" style="max-height:300px;overflow-y:auto;">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Draft #</th>
              <th>Customer</th>
              <th class="num">Amount</th>
              <th>Created</th>
              <th>Age</th>
              <th>Notified</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in syncStatus.unmatched_drafts" :key="d.draft_number" class="row-alert">
              <td>
                <span v-if="d.age_minutes >= 15" class="pill alert">Alert</span>
                <span v-else class="pill s3">Watching</span>
              </td>
              <td class="mono">{{ d.draft_number }}</td>
              <td>{{ d.shopify_customer || '—' }}</td>
              <td class="num">{{ formatCurrency(d.shopify_amount) }}</td>
              <td class="muted">{{ formatDate(d.shopify_created) }}</td>
              <td class="age">{{ formatAge(d.age_minutes) }}</td>
              <td>
                <span v-if="d.notified_at" class="pill ok">Sent</span>
                <span v-else-if="d.age_minutes >= 15" class="pill s3">Pending</span>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Recently resolved drafts -->
    <div v-if="syncStatus && syncStatus.resolved_drafts.length > 0" class="card resolved-card">
      <h3>
        <span class="pill ok">{{ syncStatus.resolved_drafts.length }}</span>
        Recently Resolved
        <span class="hint">Drafts that were unmatched but now have a NetSuite SO (last 7 days)</span>
      </h3>
      <div class="tablewrap" style="max-height:250px;overflow-y:auto;">
        <table>
          <thead>
            <tr>
              <th>Draft #</th>
              <th>NetSuite SO</th>
              <th>Customer</th>
              <th class="num">Amount</th>
              <th>Resolved</th>
              <th>Time to Resolve</th>
              <th>Was Alerted</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in syncStatus.resolved_drafts" :key="d.draft_number" class="row-resolved">
              <td class="mono">{{ d.draft_number }}</td>
              <td class="mono">{{ d.netsuite_so || '—' }}</td>
              <td>{{ d.shopify_customer || '—' }}</td>
              <td class="num">{{ formatCurrency(d.shopify_amount) }}</td>
              <td class="muted">{{ formatSyncTime(d.resolved_at) }}</td>
              <td>{{ formatAge(d.time_to_resolve_minutes) }}</td>
              <td>
                <span v-if="d.was_alerted" class="pill s3">Yes</span>
                <span v-else class="muted">No</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Data table card with controls inside -->
    <div class="card">
      <h3>Order matching <span class="hint">live from NetSuite + Shopify &middot; {{ searched.length }} records{{ search ? ' (filtered)' : '' }}</span></h3>

      <!-- Range selector + search above table -->
      <div class="recon-controls">
        <div class="recon-range">
          <div class="seg">
            <button
              v-for="r in ranges"
              :key="r.key"
              :aria-pressed="rangeKey === r.key ? 'true' : 'false'"
              @click="setRange(r.key)"
            >{{ r.label }}</button>
          </div>
          <template v-if="rangeKey === 'custom'">
            <input type="date" v-model="startDate" @change="load" />
            <span class="muted">to</span>
            <input type="date" v-model="endDate" @change="load" />
          </template>
          <span v-if="lastLoadMs" class="hint">{{ (lastLoadMs / 1000).toFixed(1) }}s</span>
        </div>
        <div class="recon-search">
          <input type="text" v-model="search" placeholder="Search SO, draft, customer..." />
        </div>
      </div>

      <div v-if="loading" class="empty">Loading reconciliation data...</div>
      <div v-else-if="error" class="empty">{{ error }}</div>
      <div v-else-if="!filtered.length" class="empty">{{ search ? 'No records match your search.' : 'No records found in this date range.' }}</div>
      <div v-else class="tablewrap recon-scroll">
        <table>
          <thead>
            <tr>
              <th class="sortable" :class="{ sorted: sortKey === 'status' }" @click="toggleSort('status')">Status <span class="sort-ind">{{ sortIndicator('status') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'shopify_draft' }" @click="toggleSort('shopify_draft')">Shopify Draft <span class="sort-ind">{{ sortIndicator('shopify_draft') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'shopify_so' }" @click="toggleSort('shopify_so')">Shopify SO # <span class="sort-ind">{{ sortIndicator('shopify_so') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'shopify_customer' }" @click="toggleSort('shopify_customer')">Shopify Customer <span class="sort-ind">{{ sortIndicator('shopify_customer') }}</span></th>
              <th class="num sortable" :class="{ sorted: sortKey === 'shopify_amount' }" @click="toggleSort('shopify_amount')">Shopify Amount <span class="sort-ind">{{ sortIndicator('shopify_amount') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'shopify_created' }" @click="toggleSort('shopify_created')">Draft Created <span class="sort-ind">{{ sortIndicator('shopify_created') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'netsuite_so' }" @click="toggleSort('netsuite_so')">NetSuite SO <span class="sort-ind">{{ sortIndicator('netsuite_so') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'netsuite_memo' }" @click="toggleSort('netsuite_memo')">Memo <span class="sort-ind">{{ sortIndicator('netsuite_memo') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'netsuite_customer' }" @click="toggleSort('netsuite_customer')">NS Customer <span class="sort-ind">{{ sortIndicator('netsuite_customer') }}</span></th>
              <th class="num sortable" :class="{ sorted: sortKey === 'netsuite_amount' }" @click="toggleSort('netsuite_amount')">NS Amount <span class="sort-ind">{{ sortIndicator('netsuite_amount') }}</span></th>
              <th class="sortable" :class="{ sorted: sortKey === 'netsuite_date' }" @click="toggleSort('netsuite_date')">NS Date <span class="sort-ind">{{ sortIndicator('netsuite_date') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in filtered" :key="i" :class="{ 'row-alert': r.status === 'missing_in_netsuite', 'row-warn': r.status === 'missing_in_shopify' }">
              <td>
                <span class="pill" :class="statusClass(r.status)">
                  {{ statusLabel(r.status) }}
                </span>
              </td>
              <td class="mono">{{ r.shopify_draft || '—' }}</td>
              <td class="mono">{{ r.netsuite_shopify_so || r.shopify_order || '—' }}</td>
              <td>{{ r.shopify_customer || '—' }}</td>
              <td class="num">{{ formatCurrency(r.shopify_amount) }}</td>
              <td class="muted">{{ formatDate(r.shopify_created) }}</td>
              <td class="mono">{{ r.netsuite_so || '—' }}</td>
              <td class="mono">{{ r.netsuite_memo || '—' }}</td>
              <td>{{ r.netsuite_customer || '—' }}</td>
              <td class="num">{{ formatCurrency(r.netsuite_amount) }}</td>
              <td class="muted">{{ formatDate(r.netsuite_date) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="totalPages > 1" class="pager">
        <button @click="goPage(1)" :disabled="page === 1">&laquo;</button>
        <button @click="goPage(page - 1)" :disabled="page === 1">&lsaquo;</button>
        <span class="page-info">Page {{ page }} of {{ totalPages }} &middot; {{ searched.length }} total</span>
        <button @click="goPage(page + 1)" :disabled="page === totalPages">&rsaquo;</button>
        <button @click="goPage(totalPages)" :disabled="page === totalPages">&raquo;</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.recon-header {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 10px;
  padding: 14px 18px 16px;
  margin-bottom: 12px;
}
.recon-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.recon-range {
  display: flex;
  align-items: center;
  gap: 8px;
}
.recon-range .seg {
  display: inline-flex;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  overflow: hidden;
}
.recon-range .seg button {
  padding: 5px 12px;
  border: none;
  border-right: 1px solid var(--border, #d1d5db);
  background: var(--bg, #fff);
  color: var(--fg, #1f2937);
  font-size: 0.82rem;
  cursor: pointer;
}
.recon-range .seg button:last-child {
  border-right: none;
}
.recon-range .seg button[aria-pressed="true"] {
  background: var(--accent, #2563eb);
  color: #fff;
}
.recon-range input[type="date"] {
  padding: 5px 8px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg, #fff);
  color: var(--fg, #1f2937);
}
.recon-search {
  flex: 1;
  min-width: 200px;
  max-width: 360px;
}
.recon-search input {
  width: 100%;
  padding: 5px 10px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg, #fff);
  color: var(--fg, #1f2937);
}
.recon-scroll {
  max-height: 600px;
  overflow-y: auto;
}
.recon-scroll table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--card-bg, #fff);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 0 4px;
  font-size: 0.85rem;
}
.pager button {
  padding: 3px 10px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 4px;
  background: var(--bg, #fff);
  color: var(--fg, #1f2937);
  cursor: pointer;
  font-size: 0.85rem;
}
.pager button:disabled {
  opacity: 0.35;
  cursor: default;
}
.page-info {
  color: var(--muted, #6b7280);
  margin: 0 8px;
}
.alert-banner {
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 8px;
  padding: 10px 16px;
  margin-bottom: 12px;
  color: #dc2626;
  font-size: 0.88rem;
}
.alert-banner.warn {
  background: rgba(255, 170, 0, 0.08);
  border-color: rgba(255, 170, 0, 0.3);
  color: #b45309;
}
.row-alert {
  background: rgba(220, 38, 38, 0.06);
}
.row-warn {
  background: rgba(255, 170, 0, 0.06);
}
.pill.alert {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}
.sync-card {
  border-left: 3px solid var(--accent, #2563eb);
}
.sync-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.sync-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.95rem;
}
.sync-btn {
  padding: 5px 14px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--accent, #2563eb);
  color: #fff;
  font-size: 0.82rem;
  cursor: pointer;
}
.sync-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.sync-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px 16px;
}
.sync-stat {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
}
.sync-label {
  font-size: 0.72rem;
  color: var(--muted, #6b7280);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.sync-value {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--fg, #1f2937);
}
.sync-error {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(220, 38, 38, 0.08);
  border-radius: 6px;
  color: #dc2626;
  font-size: 0.85rem;
}
.sync-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.sync-dot.live {
  background: #22c55e;
  box-shadow: 0 0 6px #22c55e;
  animation: pulse-green 2s infinite;
}
.sync-dot.err {
  background: #dc2626;
  box-shadow: 0 0 6px #dc2626;
}
.sync-dot.waiting {
  background: #f59e0b;
  box-shadow: 0 0 6px #f59e0b;
  animation: pulse-amber 1.5s infinite;
}
@keyframes pulse-green {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@keyframes pulse-amber {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.unmatched-card {
  border-left: 3px solid #dc2626;
}
.resolved-card {
  border-left: 3px solid #22c55e;
}
.row-resolved {
  background: rgba(34, 197, 94, 0.04);
}
th.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
th.sortable:hover {
  color: var(--accent, #2563eb);
}
.sort-ind {
  font-size: 0.7em;
  opacity: 0.35;
  margin-left: 2px;
}
th.sorted .sort-ind {
  opacity: 1;
  color: var(--accent, #2563eb);
}
</style>
