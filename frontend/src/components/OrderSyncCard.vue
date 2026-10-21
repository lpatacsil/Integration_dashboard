<script setup lang="ts">
import { computed } from 'vue'
import type { OrderSyncStats } from '../types'

const props = defineProps<{
  stats: OrderSyncStats | null
}>()

const pillLabel = computed(() => {
  if (!props.stats) return 'Not connected'
  return props.stats.errors > 0 ? `${props.stats.errors} error${props.stats.errors === 1 ? '' : 's'}` : 'Healthy'
})

const pillCls = computed(() => {
  if (!props.stats) return 'neutral'
  return props.stats.errors > 0 ? 's4' : 'ok'
})
</script>

<template>
  <div class="card flow order">
    <div class="head">
      <div>
        <div class="name">Order Sync · Shopify ⇄ NetSuite</div>
        <div class="dir">Draft → sales order → integration ready → Shopify order</div>
      </div>
      <span class="pill" :class="pillCls">{{ pillLabel }}</span>
    </div>
    <div class="stages">
      <div title="Shopify draft orders created in the selected range">Drafts<b>{{ stats?.drafts ?? 0 }}</b></div>
      <div title="Drafts with a NetSuite sales order (memo = draft #)">SO created<b>{{ stats?.so_created ?? 0 }}</b></div>
      <div title="Sales orders with Integration Ready checked">Ready<b>{{ stats?.ready ?? 0 }}</b></div>
      <div title="Ready sales orders whose Shopify order exists">Resolved<b class="resolved">{{ stats?.resolved ?? 0 }}</b></div>
    </div>
    <div class="tally">
      <span title="No NetSuite SO after 15 minutes, or ready SO with no Shopify order">
        Errors <b :class="{ err: stats?.errors }">{{ stats?.errors ?? 0 }}</b>
        <template v-if="stats?.errors">
          ({{ stats.errors_no_so }} no SO · {{ stats.errors_no_order }} no Shopify order)
        </template>
      </span>
      <span title="SO not ready yet, or draft created in the last 15 minutes">Pending <b>{{ stats?.pending ?? 0 }}</b></span>
    </div>
  </div>
</template>
