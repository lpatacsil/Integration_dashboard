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
</script>

<template>
  <div v-if="!categories.length" class="empty">No errors in this range.</div>
  <div v-else>
    <div v-for="c in categories" :key="c.error_code" style="margin:8px 0">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <span>
          <span class="cat" :class="{ block: c.is_blocking }">{{ c.error_code || '?' }}</span>
          <span class="muted"> {{ c.category_label || '' }}</span>
        </span>
        <b style="font-variant-numeric:tabular-nums">{{ c.count }}</b>
      </div>
      <div class="bar-inline">
        <i :style="{
          width: `${(c.count / maxCount) * 100}%`,
          background: c.is_blocking ? 'var(--warn)' : 'var(--s2)',
        }"></i>
      </div>
    </div>
  </div>
</template>
