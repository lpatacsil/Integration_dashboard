<script setup lang="ts">
import type { OverviewResponse, OpenBlockingError } from '../types'

const props = defineProps<{
  severity: number
  overview: OverviewResponse | null
}>()

const sevName = ['All flows healthy', 'Severity 1', 'Severity 2', 'Severity 3', 'Severity 4']

function buildWhy(): string {
  const o = props.overview
  if (!o) return ''
  const sev = o.severity
  const ob = o.openBlocking || []
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  if (sev === 4)
    return `<strong>Connector is down.</strong> Last heartbeat ${o.heartbeatAgeMin} min ago; ${o.txLast60} transactions in the last 60 min against a baseline of ~${o.baselineLast60}. Nothing is moving between Shopify and NetSuite.`
  if (sev === 3) {
    const old = ob.filter(e => new Date(e.occurred_at) < startOfToday)
    return `<strong>${ob.length} transactions blocked by mapping gaps</strong>, ${old.length} of them open since yesterday (${old.map(e => e.entity_identifier).join(', ')}). Unresolved into day 2 — management is now copied.`
  }
  if (sev === 2)
    return `<strong>${ob.length} transactions blocked</strong> by unmapped data objects (${[...new Set(ob.map(e => e.error_code))].join(', ')}), all opened today. Everything else is flowing.`
  if (sev === 1 && ob[0])
    return `<strong>One transaction blocked:</strong> ${ob[0].entity_identifier} — ${ob[0].error_message}. All other traffic flowing normally.`
  return `No blocking errors open. Heartbeat ${o.heartbeatAgeMin} min ago, ${o.txLast60} transactions in the last hour. Non-blocking NetSuite errors, if any, are on the internal log tab.`
}

function buildOncall(): string {
  const o = props.overview
  if (!o) return ''
  const esc = o.escalation
  if (esc) {
    const renotify = esc.renotifyMinutes >= 60 ? `${esc.renotifyMinutes / 60} h` : `${esc.renotifyMinutes} min`
    return `<b>Escalated to</b> <span class="who">${esc.notify.map(c => c.name).join(', ')}</span><br><b>Copied</b> <span class="who">${esc.cc.map(c => c.name).join(', ')}</span><br>Re-notify every ${renotify} while open`
  }
  return `<b>Hotline on standby</b> <span class="who">Larry, Quennie</span><br>Nobody has been paged.`
}
</script>

<template>
  <div class="health" :data-sev="severity">
    <div class="big">
      <small>Integration status</small>
      <span>{{ severity ? `Severity ${severity}` : 'All flows healthy' }}</span>
    </div>
    <div class="why" v-html="buildWhy()"></div>
    <div class="oncall" v-html="buildOncall()"></div>
  </div>
</template>
