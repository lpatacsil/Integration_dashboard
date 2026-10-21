<script setup lang="ts">
import type { RelatedCase } from '../types'

defineProps<{
  cases: RelatedCase[]
  showReason?: boolean
}>()
</script>

<template>
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>Case #</th>
          <th v-if="showReason">Issue</th>
          <th>Details</th>
          <th>Status</th>
          <th>Owner / assigned to</th>
          <th>Related order</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in cases" :key="c.id">
          <td class="mono"><a :href="c.url" target="_blank" rel="noopener">{{ c.issue_id }}</a></td>
          <td v-if="showReason"><span class="cat block">{{ c.integration_reason }}</span></td>
          <td>
            <div v-if="c.issue_type || c.customer" class="muted">{{ [c.issue_type, c.customer].filter(Boolean).join(' · ') }}</div>
            {{ c.detail || '—' }}
          </td>
          <td><span class="pill" :class="c.is_open ? 'warnp' : 'neutral'">{{ c.status }}</span></td>
          <td>
            {{ c.owner || '—' }}
            <div v-if="c.assigned_to && c.assigned_to !== c.owner" class="muted">→ {{ c.assigned_to }}</div>
          </td>
          <td class="mono">
            <div v-if="c.sales_order">{{ c.sales_order }}</div>
            <div v-if="c.draft_number" class="muted">{{ c.draft_number }}</div>
          </td>
          <td class="muted">{{ c.created_date }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
