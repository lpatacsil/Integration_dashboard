<script setup lang="ts">
import { formatDate } from '../types'
import type { DailyRow } from '../types'

defineProps<{
  daily: DailyRow[]
}>()
</script>

<template>
  <div v-if="!daily.length" class="empty">No data.</div>
  <div v-else class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>Day</th>
          <th class="num">OK</th>
          <th class="num">Errors</th>
          <th class="num">Re-runs</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in daily" :key="d.day">
          <td>{{ formatDate(d.day) }}</td>
          <td class="num">{{ d.ok || 0 }}</td>
          <td class="num" :class="{ muted: !d.errors }">{{ d.errors || 0 }}</td>
          <td class="num muted">{{ d.reruns || 0 }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
