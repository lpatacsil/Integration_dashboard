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
    <div class="phase">
      <div class="phase-title">Phase 1 · Draft order → Sales order <span>Shopify → NetSuite</span></div>
      <div class="stages">
        <div title="Shopify draft orders created in the selected range">Drafts<b>{{ stats?.drafts ?? 0 }}</b></div>
        <div title="Drafts with a NetSuite sales order (memo = draft #)">SO created<b class="resolved">{{ stats?.so_created ?? 0 }}</b></div>
        <div title="Drafts with no NetSuite sales order after 15 minutes">Errors<b :class="{ err: stats?.errors_no_so }">{{ stats?.errors_no_so ?? 0 }}</b></div>
      </div>
    </div>
    <div class="phase">
      <div class="phase-title">Phase 2 · Ready for billing → Shopify order <span>NetSuite → Shopify</span></div>
      <div class="stages">
        <div title="Sales orders with Integration Ready checked: customer will be billed / invoiced">Ready<b>{{ stats?.ready ?? 0 }}</b></div>
        <div title="Ready sales orders whose Shopify SO # matches an order in Shopify">Ordered<b class="resolved">{{ stats?.resolved ?? 0 }}</b></div>
        <div title="Ready sales orders whose Shopify SO # is missing or not in Shopify">Errors<b :class="{ err: stats?.errors_no_order }">{{ stats?.errors_no_order ?? 0 }}</b></div>
      </div>
    </div>
    <div class="tally">
      <span title="SO not marked Integration Ready yet, or draft created in the last 15 minutes">Pending <b>{{ stats?.pending ?? 0 }}</b></span>
    </div>
  </div>
</template>
