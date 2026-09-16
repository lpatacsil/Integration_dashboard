<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  detail?: string
  valueClass?: string
}>()
</script>

<template>
  <div class="card kpi">
    <h3>{{ label }}</h3>
    <div class="v" :class="valueClass || ''">{{ value }}</div>
    <div v-if="detail" class="d">{{ detail }}</div>
  </div>
</template>
