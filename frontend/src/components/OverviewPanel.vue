<script setup lang="ts">
import { computed } from 'vue'
import { FLOWS } from '../types'
import type {
  OverviewResponse, TrendsResponse, ErrorCategoriesResponse,
  OpenIncidentsResponse, Rules,
} from '../types'
import SeverityTile from './SeverityTile.vue'
import FlowCard from './FlowCard.vue'
import TrendChart from './TrendChart.vue'
import CategoryBreakdown from './CategoryBreakdown.vue'
import IncidentTable from './IncidentTable.vue'

const props = defineProps<{
  overview: OverviewResponse | null
  trends: TrendsResponse | null
  errorCategories: ErrorCategoriesResponse | null
  openIncidents: OpenIncidentsResponse | null
  rules: Rules | null
  chartHint: string
}>()

const flowCodes = Object.keys(FLOWS)

const nsOpenCount = computed(() => {
  return (props.openIncidents?.incidents || []).filter(i => i.flow_code === 'NS').length
})
</script>

<template>
  <section class="panel on">
    <!-- Severity tiles -->
    <div class="row sev">
      <SeverityTile
        v-for="l in [0, 1, 2, 3, 4]"
        :key="l"
        :level="l"
        :current-severity="overview?.severity ?? 0"
        :open-blocking-count="overview?.openBlockingCount ?? 0"
      />
    </div>

    <!-- Flow cards -->
    <div class="row flows">
      <FlowCard
        v-for="f in flowCodes"
        :key="f"
        :code="f"
        :stats="overview?.flowStats?.[f] ?? { name: '', dir: '', severity: 0, total: 0, succeeded: 0, errored: 0, pending_rerun: 0, reruns: 0 }"
        :severity="overview?.perFlowSeverity?.[f] ?? 0"
        :sparkline="overview?.sparklines?.[f] ?? []"
        :ns-open-count="f === 'NS' ? nsOpenCount : undefined"
      />
    </div>

    <!-- Trend chart + category breakdown -->
    <div class="row two">
      <TrendChart
        :buckets="trends?.buckets ?? []"
        :hint="chartHint"
      />
      <div class="card">
        <h3>Errors by category <span class="hint">selected range · all flows</span></h3>
        <CategoryBreakdown :categories="errorCategories?.categories ?? []" />
      </div>
    </div>

    <!-- Open incidents -->
    <div class="card">
      <h3>Open incidents <span class="hint">what is blocking right now, newest first</span></h3>
      <div class="tablewrap">
        <IncidentTable
          :incidents="openIncidents?.incidents ?? []"
          :show-flow="true"
          :rules="rules"
        />
      </div>
    </div>
  </section>
</template>
