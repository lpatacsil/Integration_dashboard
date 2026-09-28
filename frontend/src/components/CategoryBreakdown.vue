<script setup lang="ts">
import { computed } from 'vue'
import type { ErrorCategory } from '../types'

const props = defineProps<{
  categories: ErrorCategory[]
}>()

const maxCount = computed(() => {
  if (!props.categories.length) return 1
  return props.categories[0].count
})

const totals = computed(() => {
  let count = 0, open = 0, resolved = 0
  for (const c of props.categories) {
    count += c.count
    open += c.open ?? 0
    resolved += c.resolved ?? 0
  }
  return { count, open, resolved }
})
</script>

<template>
  <div v-if="!categories.length" class="empty">No errors in this range.</div>
  <div v-else>
    <!-- Summary row -->
    <div class="cat-summary">
      <span>{{ totals.count }} total</span>
      <span class="cat-open">{{ totals.open }} open</span>
      <span class="cat-resolved">{{ totals.resolved }} resolved</span>
    </div>

    <div v-for="c in categories" :key="c.error_code" class="cat-row">
      <div class="cat-header">
        <span>
          <span class="cat" :class="{ block: c.is_blocking }">{{ c.error_code || '?' }}</span>
          <span class="muted"> {{ c.category_label || '' }}</span>
        </span>
        <span class="cat-counts">
          <b>{{ c.count }}</b>
          <span class="cat-open-sm" v-if="c.open">{{ c.open }} open</span>
          <span class="cat-resolved-sm" v-if="c.resolved">{{ c.resolved }} solved</span>
        </span>
      </div>
      <div class="bar-stacked">
        <i class="bar-resolved" :style="{
          width: `${(c.resolved / maxCount) * 100}%`,
        }"></i>
        <i class="bar-open" :style="{
          width: `${(c.open / maxCount) * 100}%`,
          background: c.is_blocking ? 'var(--warn)' : 'var(--s3)',
        }"></i>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cat-summary {
  display: flex;
  gap: 16px;
  font-size: 13px;
  padding: 6px 0 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 8px;
}
.cat-summary span { font-variant-numeric: tabular-nums; }
.cat-open { color: var(--s3); font-weight: 600; }
.cat-resolved { color: var(--s1); font-weight: 600; }

.cat-row { margin: 8px 0; }

.cat-header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}

.cat-counts {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}
.cat-counts b { min-width: 32px; text-align: right; }
.cat-open-sm { font-size: 11px; color: var(--s3); }
.cat-resolved-sm { font-size: 11px; color: var(--s1); }

.bar-stacked {
  height: 6px;
  display: flex;
  border-radius: 3px;
  overflow: hidden;
  background: var(--surface);
  margin-top: 3px;
}
.bar-resolved {
  height: 100%;
  background: var(--s1);
  transition: width .3s;
}
.bar-open {
  height: 100%;
  background: var(--s3);
  transition: width .3s;
}
</style>
