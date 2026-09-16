<script setup lang="ts">
import { useDateRange } from '../composables/useDateRange'

defineProps<{
  connectionStatus: 'connecting' | 'ok' | 'error'
}>()

const { rangeKey, customFrom, customTo, setRange, setCustom } = useDateRange()

const rangeOptions = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom' },
]

function onRangeClick(key: string) {
  setRange(key)
}

function onCustomChange(e: Event, field: 'from' | 'to') {
  const val = (e.target as HTMLInputElement).value
  if (field === 'from') {
    setCustom(val, customTo.value)
  } else {
    setCustom(customFrom.value, val)
  }
}
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <h1>NetSuite–Shopify Flow Monitor</h1>
      <div class="sub">TeamCentral integration · NetSuite internal log · escalation status</div>
    </div>
    <span
      class="sample-tag"
      :style="{
        background: connectionStatus === 'ok' ? 'var(--good-soft)' : connectionStatus === 'error' ? 'var(--crit-soft)' : 'var(--warn-soft)',
        color: connectionStatus === 'ok' ? 'var(--good-ink)' : connectionStatus === 'error' ? 'var(--crit-ink)' : 'var(--warn-ink)',
      }"
    >
      {{ connectionStatus === 'ok' ? 'Live · API connected' : connectionStatus === 'error' ? 'API error – check console' : 'Connecting to API...' }}
    </span>
    <div class="control">
      <label>Range</label>
      <div class="seg">
        <button
          v-for="opt in rangeOptions"
          :key="opt.key"
          :aria-pressed="rangeKey === opt.key ? 'true' : 'false'"
          @click="onRangeClick(opt.key)"
        >{{ opt.label }}</button>
      </div>
      <div class="custom-range" :class="{ on: rangeKey === 'custom' }">
        <input type="date" :value="customFrom" @change="onCustomChange($event, 'from')">
        <span class="muted">to</span>
        <input type="date" :value="customTo" @change="onCustomChange($event, 'to')">
      </div>
    </div>
  </div>
</template>
