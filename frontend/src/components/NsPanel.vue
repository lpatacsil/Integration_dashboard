<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FlowDetailResponse, Rules, CategoryRule } from '../types'
import KpiCard from './KpiCard.vue'
import CategoryTable from './CategoryTable.vue'
import DailyTable from './DailyTable.vue'
import IncidentTable from './IncidentTable.vue'

const props = defineProps<{
  data: FlowDetailResponse | null
  rules: Rules | null
  categoryRules: CategoryRule[]
  error?: string | null
}>()

const catMap = computed(() => {
  const m: Record<string, number> = {}
  const cats = props.data?.categories
  if (Array.isArray(cats)) {
    cats.forEach(c => { m[c.error_code] = c.count })
  }
  return m
})

const nsCodes = ['TAX-VERTEX', 'INV-ITEM', 'VAL-DATA'] as const

function getCatLabel(code: string): string {
  return props.categoryRules.find(x => x.code === code)?.label || code
}

// Failing sales orders pulled from NetSuite, filterable by category
const issueFilter = ref<string>('all')
const issues = computed(() => props.data?.nsIssues || [])
const filteredIssues = computed(() =>
  issueFilter.value === 'all' ? issues.value : issues.value.filter(i => i.category === issueFilter.value))
const shortLabel: Record<string, string> = { 'TAX-VERTEX': 'Vertex tax', 'INV-ITEM': 'Inventory', 'VAL-DATA': 'Validation' }
</script>

<template>
  <section class="panel on">
    <div v-if="error" class="empty">Error loading NS data: {{ error }}</div>
    <template v-else-if="data">
      <div class="section-title">
        NetSuite internal log
        <span class="hint">transactions that reached NetSuite but failed inside it — Vertex, inventory, validation, permissions. Not integration faults; tracked against per-category thresholds.</span>
      </div>

      <div class="row kpi">
        <KpiCard label="Transactions posted" :value="data.kpi.total || 0" detail="in range" />
        <KpiCard label="Passed" :value="data.kpi.succeeded || 0" detail="posted cleanly" />
        <KpiCard label="Failed in NetSuite" :value="data.kpi.errored || 0" detail="see categories" />
        <KpiCard
          v-for="code in nsCodes"
          :key="code"
          :label="getCatLabel(code)"
          :value="catMap[code] || 0"
          :detail="`threshold ${rules?.thresholds?.['NS.' + code] || 0}/day`"
          :value-class="(catMap[code] || 0) > (rules?.thresholds?.['NS.' + code] || 0) ? 'warnv' : ''"
        />
      </div>

      <div class="row two">
        <div class="card">
          <h3>Failures by category</h3>
          <CategoryTable
            :categories="data.categories || []"
            :show-threshold="true"
            :thresholds="rules?.thresholds"
          />
        </div>
        <div class="card">
          <h3>Daily breakdown</h3>
          <DailyTable :daily="data.daily || []" />
        </div>
      </div>

      <div class="card" v-if="data.nsIssues">
        <h3>
          Sales orders with errors
          <span class="hint">pulled live from NetSuite · open sales orders in range</span>
        </h3>
        <div class="seg" style="margin-bottom:10px">
          <button :aria-pressed="issueFilter === 'all'" @click="issueFilter = 'all'">All {{ issues.length }}</button>
          <button
            v-for="code in nsCodes"
            :key="code"
            :aria-pressed="issueFilter === code"
            @click="issueFilter = code"
          >{{ shortLabel[code] }} {{ issues.filter(i => i.category === code).length }}</button>
        </div>
        <div v-if="data.nsSourceErrors?.length" class="muted" style="margin-bottom:8px">
          Some checks could not run: {{ data.nsSourceErrors.join(' · ') }}
        </div>
        <div v-if="!filteredIssues.length" class="empty">No sales orders with this kind of error in range.</div>
        <div v-else class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Sales order</th>
                <th>Draft</th>
                <th>Customer</th>
                <th>Problem</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in filteredIssues" :key="i.category + i.so_id">
                <td><span class="cat block">{{ shortLabel[i.category] }}</span></td>
                <td class="mono"><a :href="i.url" target="_blank" rel="noopener">{{ i.so_number }}</a></td>
                <td class="mono muted">{{ i.draft_number || '—' }}</td>
                <td>{{ i.customer || '—' }}</td>
                <td>{{ i.detail }}</td>
                <td class="muted">{{ i.occurred_at }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3>Open NetSuite errors <span class="hint">owner: NetSuite admin, not the integration hotline</span></h3>
        <div class="tablewrap">
          <IncidentTable :incidents="data.openIncidents || []" :show-flow="false" :rules="rules" />
        </div>
      </div>
    </template>
    <div v-else class="empty">Loading...</div>
  </section>
</template>
