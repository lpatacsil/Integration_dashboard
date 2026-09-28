<script setup lang="ts">
import { FLOWS, SEV_NAMES, pillClass } from '../types'
import type { FlowStats, Incident } from '../types'
import SparklineSvg from './SparklineSvg.vue'

const props = defineProps<{
  code: string
  stats: FlowStats
  severity: number
  sparkline: number[]
  nsOpenCount?: number
}>()

const flow = FLOWS[props.code]

function pillLabel(): string {
  if (props.code === 'NS') {
    return (props.nsOpenCount || 0) > 0 ? `${props.nsOpenCount} open` : 'Clear'
  }
  return SEV_NAMES[props.severity]
}

function pillCls(): string {
  if (props.code === 'NS') {
    return (props.nsOpenCount || 0) > 0 ? 'warnp' : 'ok'
  }
  return pillClass(props.severity)
}
</script>

<template>
  <div class="card flow">
    <div class="head">
      <div>
        <div class="name">{{ flow?.name || code }}</div>
        <div class="dir">{{ flow?.dir || '' }}</div>
      </div>
      <span class="pill" :class="pillCls()">{{ pillLabel() }}</span>
    </div>
    <div class="nums">
      <div>Processed<b>{{ stats.total || 0 }}</b></div>
      <div>Succeeded<b>{{ stats.succeeded || 0 }}</b></div>
      <div>Errors<b :class="{ err: stats.errored }">{{ stats.errored || 0 }}</b></div>
      <div>Resolved<b class="resolved">{{ stats.resolved || 0 }}</b></div>
      <div>Reruns<b>{{ stats.reruns || 0 }}</b></div>
    </div>
    <SparklineSvg :points="sparkline" />
  </div>
</template>
