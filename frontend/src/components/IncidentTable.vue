<script setup lang="ts">
import { formatAge, formatTime, FLOWS } from '../types'
import type { Incident, Rules } from '../types'

const props = defineProps<{
  incidents: Incident[]
  showFlow: boolean
  rules?: Rules | null
}>()

const startOfToday = new Date()
startOfToday.setHours(0, 0, 0, 0)

function isOver(ageMin: number): boolean {
  const threshold = (props.rules?.thresholds?.['pending.unresolvedHours'] || 4) * 60
  return ageMin > threshold
}

function levelLabel(t: Incident): string {
  if (t.is_blocking) {
    return new Date(t.occurred_at) < startOfToday ? 'Sev 3 input' : 'Blocking'
  }
  return 'NetSuite'
}

function ownerLabel(t: Incident): string {
  return t.is_blocking ? 'Larry / Quennie' : 'NetSuite admin'
}
</script>

<template>
  <div v-if="!incidents.length" class="empty">
    Nothing open. All transactions have completed or been resolved.
  </div>
  <table v-else>
    <thead>
      <tr>
        <th v-if="showFlow">Flow</th>
        <th>Transaction</th>
        <th>Type</th>
        <th>Category</th>
        <th>Message</th>
        <th>Opened</th>
        <th>Age</th>
        <th>Level</th>
        <th>Owner</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="t in incidents" :key="t.error_id">
        <td v-if="showFlow">{{ FLOWS[t.flow_code]?.name || t.flow_code }}</td>
        <td class="mono">{{ t.entity_identifier || '' }}</td>
        <td>{{ t.transaction_type || '' }}</td>
        <td>
          <span v-if="t.error_code" class="cat" :class="{ block: t.is_blocking }">{{ t.error_code }}</span>
          <span v-else class="muted">&mdash;</span>
        </td>
        <td>{{ t.error_message || t.raw_error || '' }}</td>
        <td class="muted">{{ formatTime(t.occurred_at) }}</td>
        <td class="age" :class="{ over: isOver(t.age_minutes) }">
          {{ formatAge(t.age_minutes) }}{{ isOver(t.age_minutes) ? ' · SLA' : '' }}
        </td>
        <td>{{ levelLabel(t) }}</td>
        <td class="muted">{{ ownerLabel(t) }}</td>
      </tr>
    </tbody>
  </table>
</template>
