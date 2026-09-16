<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  points: number[]
}>()

const W = 200
const H = 44

const pathData = computed(() => {
  const pts = props.points
  if (!pts.length) return { linePath: '', areaPath: '', lastCx: 0, lastCy: 0 }
  const mx = Math.max(1, ...pts)
  const x = (i: number) => i / (pts.length - 1) * W
  const y = (v: number) => H - 4 - v / mx * (H - 10)

  const segments = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return {
    linePath: segments,
    areaPath: `${segments} L${W} ${H} L0 ${H}Z`,
    lastCx: W,
    lastCy: y(pts[pts.length - 1]),
  }
})
</script>

<template>
  <svg
    v-if="points.length"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    aria-label="errors per day, last 14 days"
  >
    <path :d="pathData.areaPath" fill="var(--s2)" opacity=".12" />
    <path :d="pathData.linePath" fill="none" stroke="var(--s2)" stroke-width="2" vector-effect="non-scaling-stroke" />
    <circle :cx="pathData.lastCx" :cy="pathData.lastCy" r="3.5" fill="var(--s2)" stroke="var(--surface)" stroke-width="2" />
  </svg>
  <div v-if="points.length" class="muted" style="font-size:11px;margin-top:-4px">
    Errors per day, last 14 days · today {{ points[points.length - 1] }}
  </div>
</template>
