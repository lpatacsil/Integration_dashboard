<script setup lang="ts">
import type { Incident, Alert } from '../types'

const props = defineProps<{
  activeTab: string
  incidents: Incident[]
  alerts: Alert[]
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', tab: string): void
}>()

interface TabDef {
  key: string
  label: string
  flowCode?: string
  countId?: string
}

const tabs: TabDef[] = [
  { key: 'overview', label: 'Overview' },
  { key: 's2n', label: 'Shopify \u2192 NetSuite', flowCode: 'S2N' },
  { key: 'n2s', label: 'NetSuite \u2192 Shopify', flowCode: 'N2S' },
  { key: 'idx', label: 'Indexing', flowCode: 'IDX' },
  { key: 'nsint', label: 'NetSuite internal log', flowCode: 'NS' },
  { key: 'alerts', label: 'Alerts & escalations', countId: 'alerts' },
  { key: 'rules', label: 'Rules & logic' },
]

function getCount(tab: TabDef): number | null {
  if (tab.flowCode) {
    return props.incidents.filter(i => i.flow_code === tab.flowCode).length
  }
  if (tab.countId === 'alerts') {
    return props.alerts.length
  }
  return null
}

function isBad(tab: TabDef): boolean {
  if (tab.flowCode) {
    return props.incidents.filter(i => i.flow_code === tab.flowCode).length > 0
  }
  if (tab.countId === 'alerts') {
    return props.alerts.filter(a => a.level >= 1).length > 0
  }
  return false
}
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      role="tab"
      :aria-selected="activeTab === tab.key ? 'true' : 'false'"
      @click="emit('update:activeTab', tab.key)"
    >
      {{ tab.label }}
      <span
        v-if="getCount(tab) !== null"
        class="count"
        :class="{ bad: isBad(tab) }"
      >{{ getCount(tab) }}</span>
    </button>
  </div>
</template>
