<script setup lang="ts">
import type { ErrorCategory } from '../types'

defineProps<{
  categories: ErrorCategory[]
  showThreshold?: boolean
  thresholds?: Record<string, number>
  flowCode?: string
}>()

function getGroupLabel(c: ErrorCategory): string {
  if (c.is_blocking) return 'Drives severity'
  if (c.error_group === 'TRANSIENT') return 'Auto-retried'
  return 'Threshold only'
}
</script>

<template>
  <div v-if="!categories.length" class="empty">No errors in range.</div>
  <table v-else>
    <thead>
      <tr>
        <th>Code</th>
        <th>Meaning</th>
        <th class="num">Count</th>
        <template v-if="showThreshold">
          <th class="num">Threshold</th>
          <th>State</th>
        </template>
        <template v-else>
          <th>Group</th>
        </template>
      </tr>
    </thead>
    <tbody>
      <tr v-for="c in categories" :key="c.error_code">
        <td><span class="cat" :class="{ block: c.is_blocking }">{{ c.error_code }}</span></td>
        <td>{{ c.category_label || '' }}</td>
        <td class="num">{{ c.count }}</td>
        <template v-if="showThreshold && thresholds">
          <td class="num muted">{{ thresholds[`NS.${c.error_code}`] || '\u2014' }}</td>
          <td>
            <span v-if="thresholds[`NS.${c.error_code}`] && c.count > thresholds[`NS.${c.error_code}`]" class="pill warnp">Over threshold</span>
            <span v-else class="pill ok">Within</span>
          </td>
        </template>
        <template v-else>
          <td class="muted">{{ getGroupLabel(c) }}</td>
        </template>
      </tr>
    </tbody>
  </table>
</template>
