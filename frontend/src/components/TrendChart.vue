<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import type { TrendBucket } from '../types'

const props = defineProps<{
  buckets: TrendBucket[]
  hint: string
}>()

const tipEl = ref<HTMLElement | null>(null)
const tipVisible = ref(false)
const tipHtml = ref('')
const tipX = ref(0)
const tipY = ref(0)

const W = 720
const H = 220
const pl = 34, pr = 8, pt = 10, pb = 26
const iw = W - pl - pr
const ih = H - pt - pb

const nice = computed(() => {
  const mx = Math.max(1, ...props.buckets.map(r => (r.ok || 0) + (r.er || 0) + (r.pe || 0)))
  return Math.ceil(mx / (mx > 200 ? 100 : mx > 50 ? 25 : 10)) * (mx > 200 ? 100 : mx > 50 ? 25 : 10)
})

const bw = computed(() => props.buckets.length ? iw / props.buckets.length : 0)

function y(v: number): number {
  return pt + ih - v / nice.value * ih
}

const gridLines = computed(() => {
  const lines: { v: number; y1: number }[] = []
  for (let i = 0; i <= 4; i++) {
    const v = nice.value * i / 4
    lines.push({ v, y1: y(v) })
  }
  return lines
})

const gap = computed(() => Math.min(6, bw.value * 0.25))
const labelEvery = computed(() => Math.ceil(props.buckets.length / 12))

interface BarSegment {
  x: number
  y: number
  w: number
  h: number
  fill: string
  rx: number
}

interface BarGroup {
  segments: BarSegment[]
  hitX: number
  hitY: number
  hitW: number
  hitH: number
  labelX: number
  label: string
  showLabel: boolean
  index: number
}

const bars = computed(() => {
  const groups: BarGroup[] = []
  const fills = [
    ['ok', 'var(--s1)'],
    ['er', 'var(--s2)'],
    ['pe', 'var(--s3)'],
  ] as const

  props.buckets.forEach((r, i) => {
    const x = pl + i * bw.value + gap.value / 2
    const w = bw.value - gap.value
    let base = 0
    const segments: BarSegment[] = []

    for (const [k, c] of fills) {
      const val = r[k as keyof TrendBucket] as number
      if (!val) { continue }
      const y0 = y(base + val)
      const y1v = y(base)
      const isTop = (k === 'pe') || (k === 'er' && !r.pe) || (k === 'ok' && !r.er && !r.pe)
      segments.push({
        x,
        y: y0 + (base ? 1 : 0),
        w,
        h: Math.max(0, y1v - y0 - (base ? 1 : 0)),
        fill: c,
        rx: isTop ? 2 : 0,
      })
      base += val
    }

    groups.push({
      segments,
      hitX: pl + i * bw.value,
      hitY: pt,
      hitW: bw.value,
      hitH: ih,
      labelX: x + w / 2,
      label: r.label,
      showLabel: i % labelEvery.value === 0,
      index: i,
    })
  })

  return groups
})

function onBarMove(e: MouseEvent, idx: number) {
  const r = props.buckets[idx]
  if (!r) return
  tipVisible.value = true
  tipHtml.value = `<b>${r.label}</b> · ${(r.ok || 0) + (r.er || 0) + (r.pe || 0)} total<br>Succeeded ${r.ok || 0} · Errored ${r.er || 0} · Pending/re-run ${r.pe || 0}`
  const wrap = (e.currentTarget as SVGElement).closest('.chart') as HTMLElement
  if (!wrap) return
  const b = wrap.getBoundingClientRect()
  nextTick(() => {
    const tipW = tipEl.value?.offsetWidth || 100
    tipX.value = Math.min(e.clientX - b.left + 12, b.width - tipW - 8)
    tipY.value = e.clientY - b.top - 40
  })
}

function onBarLeave() {
  tipVisible.value = false
}
</script>

<template>
  <div class="card chart">
    <h3>Daily volume by outcome <span class="hint">{{ hint }}</span></h3>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
      <!-- grid -->
      <template v-for="g in gridLines" :key="g.v">
        <line :x1="pl" :x2="W - pr" :y1="g.y1" :y2="g.y1" stroke="var(--grid)" />
        <text :x="pl - 6" :y="g.y1 + 4" text-anchor="end">{{ g.v }}</text>
      </template>

      <!-- bars -->
      <template v-for="group in bars" :key="group.index">
        <rect
          v-for="(seg, si) in group.segments"
          :key="si"
          :x="seg.x" :y="seg.y" :width="seg.w" :height="seg.h"
          :fill="seg.fill" :rx="seg.rx"
        />
        <rect
          class="hit"
          :x="group.hitX" :y="group.hitY" :width="group.hitW" :height="group.hitH"
          fill="transparent"
          @mousemove="onBarMove($event, group.index)"
          @mouseleave="onBarLeave"
        />
        <text
          v-if="group.showLabel"
          :x="group.labelX" :y="H - 8"
          text-anchor="middle"
        >{{ group.label }}</text>
      </template>

      <!-- axis -->
      <line :x1="pl" :x2="W - pr" :y1="pt + ih" :y2="pt + ih" stroke="var(--axis)" />
    </svg>
    <div class="legend">
      <span style="--sw:var(--s1)">Succeeded</span>
      <span style="--sw:var(--s2)">Errored</span>
      <span style="--sw:var(--s3)">Re-run / pending</span>
    </div>
    <div
      ref="tipEl"
      class="tip"
      :style="{ display: tipVisible ? 'block' : 'none', left: tipX + 'px', top: tipY + 'px' }"
      v-html="tipHtml"
    ></div>
  </div>
</template>
