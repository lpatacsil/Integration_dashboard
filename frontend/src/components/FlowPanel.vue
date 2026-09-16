<script setup lang="ts">
import { FLOWS, SEV_NAMES, pillClass, formatAge, formatTime } from '../types'
import type { FlowDetailResponse, Rules } from '../types'
import KpiCard from './KpiCard.vue'
import CategoryTable from './CategoryTable.vue'
import DailyTable from './DailyTable.vue'
import IncidentTable from './IncidentTable.vue'

const props = defineProps<{
  flowCode: string
  data: FlowDetailResponse | null
  rules: Rules | null
  intro: string
  error?: string | null
}>()

const indexTypeLabel: Record<string, string> = {
  'MAP-CUST': 'Customer',
  'MAP-ITEM': 'Item / SKU',
  'MAP-SHIP': 'Ship-to address',
  'MAP-LOC': 'Location / store',
}

function errorThreshold(): number | undefined {
  return props.rules?.thresholds?.[`${props.flowCode}.errors`]
}

function rerunThreshold(): number {
  return props.rules?.thresholds?.['S2N.rerun'] || 10
}

function idxFailedThreshold(): number {
  return props.rules?.thresholds?.['IDX.failed'] || 3
}
</script>

<template>
  <section class="panel on">
    <div v-if="error" class="empty">Error loading {{ flowCode }} data: {{ error }}</div>
    <template v-else-if="data">
      <div class="section-title">
        {{ FLOWS[flowCode]?.name || flowCode }}
        <span class="pill" :class="pillClass(data.severity)">{{ SEV_NAMES[data.severity] }}</span>
        <span class="hint">{{ intro }}</span>
      </div>

      <div class="row kpi">
        <KpiCard label="Processed" :value="data.kpi.total || 0" detail="in selected range" />
        <KpiCard label="Succeeded" :value="data.kpi.succeeded || 0" :detail="`${data.kpi.successRate || '\u2014'} success rate`" />
        <KpiCard
          label="Errored"
          :value="data.kpi.errored || 0"
          :detail="errorThreshold() ? `threshold ${errorThreshold()}/day` : ''"
          :value-class="errorThreshold() && (data.kpi.errored || 0) > errorThreshold()! ? 'bad' : ''"
        />
        <KpiCard label="Pending" :value="data.kpi.pending || 0" detail="awaiting target system" />
        <KpiCard
          v-if="flowCode === 'IDX'"
          label="Index failures"
          :value="data.kpi.errored || 0"
          :detail="`threshold ${idxFailedThreshold()}/day`"
          :value-class="(data.kpi.errored || 0) > idxFailedThreshold() ? 'warnv' : ''"
        />
        <KpiCard
          v-else
          label="SO re-runs"
          :value="data.kpi.reruns || 0"
          :detail="`${data.kpi.reruns_succeeded || 0} succeeded · threshold ${rerunThreshold()}/day`"
          :value-class="(data.kpi.reruns || 0) > rerunThreshold() ? 'warnv' : ''"
        />
      </div>

      <div class="row two">
        <div class="card">
          <h3>Error categories <span class="hint">in range</span></h3>
          <CategoryTable :categories="data.categories || []" />
        </div>
        <div class="card">
          <h3>Daily breakdown</h3>
          <DailyTable :daily="data.daily || []" />
        </div>
      </div>

      <!-- Indexing needs: MAP-* errors across all flows showing what needs to be indexed -->
      <template v-if="flowCode === 'IDX' && data.indexingNeeds">
        <div class="section-title" style="margin-top: 8px;">
          Objects needing indexing
          <span class="hint">MAP-* errors from integration flows — a missing index is the root cause of blocked orders</span>
        </div>

        <div class="row kpi" v-if="data.indexingNeeds.summary.length">
          <KpiCard
            label="Total orders blocked"
            :value="data.indexingNeeds.totalOrders"
            :detail="`${data.indexingNeeds.totalErrors} errors in range`"
            value-class="bad"
          />
          <KpiCard
            v-for="s in data.indexingNeeds.summary"
            :key="s.error_code"
            :label="`${indexTypeLabel[s.error_code] || s.error_code} indexing`"
            :value="s.order_count"
            :detail="`${s.error_count} errors · needs mapping`"
            value-class="warnv"
          />
        </div>
        <div v-else class="card"><div class="empty">No indexing gaps found in this range.</div></div>

        <div class="card" v-if="data.indexingNeeds.openOrders.length">
          <h3>Open orders needing indexing <span class="hint">unresolved — these orders are blocked until the object is indexed</span></h3>
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Type</th>
                  <th>Needs</th>
                  <th>Error message</th>
                  <th>Opened</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(o, i) in data.indexingNeeds.openOrders" :key="i">
                  <td class="mono">{{ o.entity_identifier }}</td>
                  <td>{{ o.transaction_type }}</td>
                  <td><span class="cat block">{{ indexTypeLabel[o.error_code] || o.error_code }}</span></td>
                  <td>{{ o.error_message }}</td>
                  <td class="muted">{{ formatTime(o.occurred_at) }}</td>
                  <td class="age">{{ formatAge(o.age_minutes) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <div class="card">
        <h3>Open / needs follow-up <span class="hint">regardless of range</span></h3>
        <div class="tablewrap">
          <IncidentTable :incidents="data.openIncidents || []" :show-flow="false" :rules="rules" />
        </div>
      </div>
    </template>
    <div v-else class="empty">Loading...</div>
  </section>
</template>
