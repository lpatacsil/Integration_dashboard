<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { fetchJSON } from '../composables/useApi'
import { useDateRange } from '../composables/useDateRange'
import type { ShopifyOrdersResponse, ShopifyDraftOrdersResponse } from '../types'

const dateRange = useDateRange()

const orders = ref<ShopifyOrdersResponse['orders']>([])
const drafts = ref<ShopifyDraftOrdersResponse['draft_orders']>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const params = {
      startDate: dateRange.startDate.value,
      endDate: dateRange.endDate.value,
    }
    const [ordersRes, draftsRes] = await Promise.all([
      fetchJSON<ShopifyOrdersResponse>('/shopify/orders', params),
      fetchJSON<ShopifyDraftOrdersResponse>('/shopify/draft-orders', params),
    ])
    orders.value = ordersRes.orders
    drafts.value = draftsRes.draft_orders
    if (ordersRes.source.startsWith('error:')) error.value = ordersRes.source
  } catch (err: any) {
    error.value = err.message
    orders.value = []
    drafts.value = []
  } finally {
    loading.value = false
  }
}

watch([dateRange.startDate, dateRange.endDate], () => load())
onMounted(() => load())

function formatCurrency(val: string | null): string {
  if (val == null) return '\u2014'
  return Number(val).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatTime(d: string): string {
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function statusPill(s: string | null): string {
  if (!s) return ''
  const map: Record<string, string> = {
    paid: 'ok', fulfilled: 'ok', completed: 'ok',
    pending: 'warnp', unfulfilled: 'warnp', open: 'warnp',
    refunded: 's3', voided: 's3',
  }
  return map[s] || ''
}
</script>

<template>
  <div class="card">
    <h3>Shopify Orders <span class="hint">live query · {{ orders.length }} orders · {{ drafts.length }} drafts</span></h3>
    <div v-if="loading" class="empty">Loading orders from Shopify...</div>
    <div v-else-if="error" class="empty">{{ error }}</div>
    <template v-else>
      <!-- Orders -->
      <div v-if="!orders.length && !drafts.length" class="empty">No Shopify orders found in this date range.</div>
      <div v-if="orders.length" class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th class="num">Total</th>
              <th>Payment</th>
              <th>Fulfillment</th>
              <th>Note</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.order_number">
              <td class="mono">{{ o.order_number }}</td>
              <td>{{ o.customer || '\u2014' }}</td>
              <td class="num">{{ formatCurrency(o.total_price) }}</td>
              <td><span class="pill" :class="statusPill(o.financial_status)">{{ o.financial_status || '\u2014' }}</span></td>
              <td><span class="pill" :class="statusPill(o.fulfillment_status)">{{ o.fulfillment_status }}</span></td>
              <td>{{ o.note || '\u2014' }}</td>
              <td class="muted">{{ formatTime(o.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Draft Orders -->
      <template v-if="drafts.length">
        <h3 style="margin-top: 12px;">Draft Orders <span class="hint">{{ drafts.length }} drafts</span></h3>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Draft</th>
                <th>Customer</th>
                <th class="num">Total</th>
                <th>Status</th>
                <th>Note</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in drafts" :key="d.draft_number">
                <td class="mono">{{ d.draft_number }}</td>
                <td>{{ d.customer || '\u2014' }}</td>
                <td class="num">{{ formatCurrency(d.total_price) }}</td>
                <td><span class="pill" :class="statusPill(d.status)">{{ d.status || '\u2014' }}</span></td>
                <td>{{ d.note || '\u2014' }}</td>
                <td class="muted">{{ formatTime(d.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
