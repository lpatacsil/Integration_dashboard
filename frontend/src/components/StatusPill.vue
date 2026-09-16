<script setup lang="ts">
import { pillClass } from '../types'

const props = defineProps<{
  level: number
  label: string
  variant?: 'severity' | 'warn' | 'neutral'
}>()

const cls = props.variant === 'warn'
  ? 'warnp'
  : props.variant === 'neutral'
    ? 'neutral'
    : pillClass(props.level)
</script>

<template>
  <span class="pill" :class="cls">{{ label }}</span>
</template>
