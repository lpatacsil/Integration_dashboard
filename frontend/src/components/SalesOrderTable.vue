<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { fetchJSON } from '../composables/useApi'
import { useDateRange } from '../composables/useDateRange'
import type { SalesOrdersResponse } from '../types'

const dateRange = useDateRange()

const orders = ref<SalesOrdersResponse['orders']>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await fetchJSON<SalesOrdersResponse>('/netsuite/sales-orders', {
      startDate: dateRange.startDate.value,
      endDate: dateRange.endDate.value,
    })
    orders.value = res.orders
    if (res.source.startsWith('error:')) {
      error.value = res.source
    }
  } catch (err: any) {
    error.value = err.message
    orders.value = []
  } finally {
    loading.value = false
  }
}

watch([dateRange.startDate, dateRange.endDate], () => load())
onMounted(() => load())

function formatCurrency(val: number | null): string {
  if (val == null) return '\u2014'
  return Number(val).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <div class="card">
    <h3>Sales Orders from NetSuite <span class="hint">live query · {{ orders.length }} records</span></h3>
    <div v-if="loading" class="empty">Loading sales orders from NetSuite...</div>
    <div v-else-if="error" class="empty">{{ error }}</div>
    <div v-else-if="!orders.length" class="empty">No sales orders found in this date range.</div>
    <div v-else class="tablewrap">
      <table>
        <thead>
          <tr>
            <th>SO No.</th>
            <th>Memo</th>
            <th>Customer</th>
            <th class="num">Total Amount</th>
            <th>Location</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.so_number">
            <td class="mono">{{ o.so_number }}</td>
            <td>{{ o.memo || '\u2014' }}</td>
            <td>{{ o.customer || '\u2014' }}</td>
            <td class="num">{{ formatCurrency(o.total_amount) }}</td>
            <td>{{ o.location || '\u2014' }}</td>
            <td class="muted">{{ formatDate(o.trandate) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
