<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { fetchJSON } from './composables/useApi'
import { provideDateRange } from './composables/useDateRange'
import { useAutoRefresh } from './composables/useAutoRefresh'
import type {
  OverviewResponse, TrendsResponse, ErrorCategoriesResponse,
  OpenIncidentsResponse, AlertsResponse, FlowDetailResponse,
  RulesResponse, Rules, CategoryRule,
} from './types'

import TopBar from './components/TopBar.vue'
import HealthStrip from './components/HealthStrip.vue'
import TabBar from './components/TabBar.vue'
import SideBar from './components/SideBar.vue'
import OverviewPanel from './components/OverviewPanel.vue'
import FlowPanel from './components/FlowPanel.vue'
import NsPanel from './components/NsPanel.vue'
import AlertsSettings from './components/settings/AlertsSettings.vue'
import RulesSettings from './components/settings/RulesSettings.vue'
import ChannelsSettings from './components/settings/ChannelsSettings.vue'
import ContactsSettings from './components/settings/ContactsSettings.vue'

// Date range (provided to children via inject)
const dateRange = provideDateRange()

// View state — supports both dashboard tabs and settings pages
const activeView = ref('overview')

const isDashboardView = computed(() =>
  ['overview', 's2n', 'n2s', 'idx', 'nsint'].includes(activeView.value)
)

// Connection status
const connectionStatus = ref<'connecting' | 'ok' | 'error'>('connecting')

// All API data
const overview = ref<OverviewResponse | null>(null)
const trends = ref<TrendsResponse | null>(null)
const errorCategories = ref<ErrorCategoriesResponse | null>(null)
const openIncidents = ref<OpenIncidentsResponse | null>(null)
const alerts = ref<AlertsResponse | null>(null)
const rules = ref<Rules | null>(null)
const categoryRules = ref<CategoryRule[]>([])

// Flow detail data
const flowData = ref<Record<string, FlowDetailResponse | null>>({
  S2N: null, N2S: null, IDX: null, NS: null,
})
const flowErrors = ref<Record<string, string | null>>({
  S2N: null, N2S: null, IDX: null, NS: null,
})

// Chart hint
const chartHint = ref('')

// Flow panel descriptions
const flowIntros: Record<string, string> = {
  S2N: 'Orders synced from Shopify into NetSuite. Blocking errors here mean an order is sitting in Shopify with no NetSuite sales order.',
  N2S: 'Draft orders, fulfillments and inventory pushed from NetSuite to Shopify. Includes SO re-run messages.',
  IDX: 'Indexing keeps the cross-reference between Shopify and NetSuite objects. A failed or skipped index is what later becomes a MAP-* error on an order.',
}

// Load rules once at init
async function loadRules() {
  try {
    const data = await fetchJSON<RulesResponse>('/rules')
    categoryRules.value = data.categories || []
    rules.value = data.rules || null
  } catch (e) {
    console.warn('Could not load rules from API:', e)
  }
}

// Main data refresh
async function refresh() {
  const params = {
    startDate: dateRange.startDate.value,
    endDate: dateRange.endDate.value,
  }
  const trendParams = {
    ...params,
    granularity: dateRange.granularity.value,
  }

  try {
    const [ovRes, trRes, ecRes, oiRes, alRes] = await Promise.all([
      fetchJSON<OverviewResponse>('/overview', params),
      fetchJSON<TrendsResponse>('/trends', trendParams),
      fetchJSON<ErrorCategoriesResponse>('/errors/categories', params),
      fetchJSON<OpenIncidentsResponse>('/errors/open-incidents'),
      fetchJSON<AlertsResponse>('/alerts', params),
    ])

    overview.value = ovRes
    trends.value = trRes
    errorCategories.value = ecRes
    openIncidents.value = oiRes
    alerts.value = alRes
    connectionStatus.value = 'ok'

    // Update chart hint
    chartHint.value = dateRange.rangeKey.value === 'today'
      ? 'today, by hour'
      : `${params.startDate} – ${params.endDate}, by day`

    // Fetch all flow detail in parallel
    await Promise.all(
      ['S2N', 'N2S', 'IDX', 'NS'].map(async (code) => {
        try {
          flowData.value[code] = await fetchJSON<FlowDetailResponse>(`/flows/${code}`, params)
          flowErrors.value[code] = null
        } catch (err: any) {
          flowErrors.value[code] = err.message
          flowData.value[code] = null
        }
      })
    )
  } catch (err) {
    console.error('Dashboard render failed:', err)
    connectionStatus.value = 'error'
  }
}

// Auto-refresh every 60s
useAutoRefresh(refresh, 60_000)

// Re-fetch when date range changes
watch(
  [dateRange.startDate, dateRange.endDate, dateRange.granularity],
  () => { refresh() },
)

// Init
onMounted(async () => {
  await loadRules()
  await refresh()
})
</script>

<template>
  <SideBar
    :active-view="activeView"
    :incidents="openIncidents?.incidents ?? []"
    :alerts="alerts?.alerts ?? []"
    @update:active-view="activeView = $event"
  />

  <div class="app-content">
    <TopBar :connection-status="connectionStatus" />

    <template v-if="isDashboardView">
      <HealthStrip :severity="overview?.severity ?? 0" :overview="overview" />
      <TabBar
        :active-tab="activeView"
        :incidents="openIncidents?.incidents ?? []"
        :alerts="alerts?.alerts ?? []"
        @update:active-tab="activeView = $event"
      />
    </template>

    <!-- Dashboard panels -->
    <OverviewPanel
      v-if="activeView === 'overview'"
      :overview="overview"
      :trends="trends"
      :error-categories="errorCategories"
      :open-incidents="openIncidents"
      :rules="rules"
      :chart-hint="chartHint"
    />

    <FlowPanel
      v-if="activeView === 's2n'"
      flow-code="S2N"
      :data="flowData.S2N"
      :rules="rules"
      :intro="flowIntros.S2N"
      :error="flowErrors.S2N"
    />

    <FlowPanel
      v-if="activeView === 'n2s'"
      flow-code="N2S"
      :data="flowData.N2S"
      :rules="rules"
      :intro="flowIntros.N2S"
      :error="flowErrors.N2S"
    />

    <FlowPanel
      v-if="activeView === 'idx'"
      flow-code="IDX"
      :data="flowData.IDX"
      :rules="rules"
      :intro="flowIntros.IDX"
      :error="flowErrors.IDX"
    />

    <NsPanel
      v-if="activeView === 'nsint'"
      :data="flowData.NS"
      :rules="rules"
      :category-rules="categoryRules"
      :error="flowErrors.NS"
    />

    <!-- Settings panels -->
    <AlertsSettings
      v-if="activeView === 'settings-alerts'"
      :alerts="alerts?.alerts ?? []"
    />

    <RulesSettings
      v-if="activeView === 'settings-rules'"
      :rules="rules"
      :category-rules="categoryRules"
      @updated="loadRules()"
    />

    <ChannelsSettings
      v-if="activeView === 'settings-channels'"
    />

    <ContactsSettings
      v-if="activeView === 'settings-contacts'"
    />
  </div>
</template>
