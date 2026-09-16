<script setup lang="ts">
import { SEV_NAMES } from '../types'

const props = defineProps<{
  level: number
  currentSeverity: number
  openBlockingCount: number
}>()

const defs = [
  'No blocking errors, heartbeat fresh',
  'One transaction blocked by mapping / indexing',
  'More than one blocked, opened today',
  'More than one blocked, unresolved into day 2',
  'Tool down — nothing flowing',
]

function displayValue(): string {
  if (props.level !== props.currentSeverity) return '\u2014'
  if (props.level === 0) return '\u2713'
  if (props.level === 4) return 'DOWN'
  return String(props.openBlockingCount)
}

function isZero(): boolean {
  return props.level !== props.currentSeverity
}
</script>

<template>
  <div class="card sevtile" :data-lvl="level">
    <span class="lbl">{{ SEV_NAMES[level] }}</span>
    <span class="n" :class="{ zero: isZero() }">{{ displayValue() }}</span>
    <span class="def">{{ defs[level] }}</span>
  </div>
</template>
