<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { fetchJSON } from '../composables/useApi'
import type { ReconciliationResponse, ReconRecord } from '../types'

const startDate = ref('2026-06-01')
const endDate = ref(new Date().toISOString().slice(0, 10))
const search = ref('')

const data = ref<ReconciliationResponse | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await fetchJSON<ReconciliationResponse>('/reconciliation', {
      startDate: startDate.value,
      endDate: endDate.value,
    })
  } catch (err: any) {
    error.value = err.message
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(() => load())

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

const totalPages = computed(() => Math.max(1, Math.ceil(searched.value.length / PAGE_SIZE)))

const filtered = computed<ReconRecord[]>(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return searched.value.slice(start, start + PAGE_SIZE)
})

watch(search, () => { page.value = 1 })

function goPage(p: number) {
  page.value = Math.max(1, Math.min(p, totalPages.value))
}

function formatCurrency(val: string | null): string {
  if (val == null) return '—'
  return Number(val).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
</script>

<template>
  <div class="section-title" style="margin-top: 8px;">
    Shopify &harr; NetSuite Reconciliation
    <span class="hint">Drafts without a matching SO are sync errors that need attention</span>
  </div>

  <!-- Controls: date picker + search -->
  <div class="recon-controls">
    <div class="recon-dates">
      <label>From</label>
      <input type="date" v-model="startDate" />
      <label>To</label>
      <input type="date" v-model="endDate" />
      <button class="btn" @click="load" :disabled="loading">{{ loading ? 'Loading...' : 'Load' }}</button>
    </div>
    <div class="recon-search">
      <input type="text" v-model="search" placeholder="Search SO, draft, customer..." />
    </div>
  </div>

  <!-- Alert banner when there are missing-in-netsuite drafts -->
  <div v-if="data?.summary && data.summary.missing_in_netsuite > 0" class="alert-banner">
    <strong>&#9888; {{ data.summary.missing_in_netsuite }} Shopify draft{{ data.summary.missing_in_netsuite > 1 ? 's' : '' }} with no NetSuite SO</strong>
    &mdash; these drafts were created in Shopify but no Sales Order was synced. Check Team Central for sync errors.
  </div>

  <div class="row kpi" v-if="data?.summary">
    <div class="kpi-card">
      <div class="kpi-value">{{ data.summary.shopify_drafts }}</div>
      <div class="kpi-label">Shopify Drafts</div>
      <div class="kpi-detail">in selected range</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">{{ data.summary.netsuite_sos }}</div>
      <div class="kpi-label">NetSuite SOs</div>
      <div class="kpi-detail">in selected range</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value">{{ data.summary.matched }}</div>
      <div class="kpi-label">Matched</div>
      <div class="kpi-detail">draft &harr; SO linked</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" :class="{ bad: data.summary.missing_in_netsuite > 0 }">{{ data.summary.missing_in_netsuite }}</div>
      <div class="kpi-label">No SO Created</div>
      <div class="kpi-detail">sync error &mdash; needs fix</div>
    </div>
  </div>

  <div class="card">
    <h3>Order matching <span class="hint">live from NetSuite + Shopify &middot; {{ searched.length }} records{{ search ? ' (filtered)' : '' }}</span></h3>
    <div v-if="loading" class="empty">Loading reconciliation data...</div>
    <div v-else-if="error" class="empty">{{ error }}</div>
    <div v-else-if="!filtered.length" class="empty">{{ search ? 'No records match your search.' : 'No records found in this date range.' }}</div>
    <div v-else class="tablewrap recon-scroll">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Shopify Draft</th>
            <th>Shopify SO #</th>
            <th>Shopify Customer</th>
            <th class="num">Shopify Amount</th>
            <th>Draft Created</th>
            <th>NetSuite SO</th>
            <th>Memo</th>
            <th>NS Customer</th>
            <th class="num">NS Amount</th>
            <th>NS Date</th>
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
</template>

<style scoped>
.recon-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.recon-dates {
  display: flex;
  align-items: center;
  gap: 8px;
}
.recon-dates label {
  font-size: 0.82rem;
  color: var(--muted);
}
.recon-dates input[type="date"] {
  padding: 5px 8px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg, #fff);
  color: var(--fg, #1f2937);
}
.btn {
  padding: 5px 14px;
  border: 1px solid var(--border, #d1d5db);
  border-radius: 6px;
  background: var(--accent, #2563eb);
  color: #fff;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.recon-search {
  flex: 1;
  min-width: 200px;
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
</style>
