<script setup lang="ts">
import { pillClass, formatTime } from '../types'
import type { Alert } from '../types'

defineProps<{
  alerts: Alert[]
}>()

function renotifyLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`
}
</script>

<template>
  <section class="panel on">
    <div class="section-title">
      Alerts &amp; escalations
      <span class="hint">what would have been emailed, and to whom, under the current rules. One row per open incident — a refresh never re-sends.</span>
    </div>

    <div class="card tablewrap">
      <div v-if="!alerts.length" class="empty">
        No alerts. Nothing has crossed a severity rule or a threshold.
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>Level</th>
            <th>Alert</th>
            <th>Detail</th>
            <th>Notify</th>
            <th>Cc</th>
            <th>Triggered</th>
            <th>Re-notify</th>
            <th>Transactions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(a, i) in alerts" :key="i">
            <td>
              <span class="pill" :class="a.level ? pillClass(a.level) : 'warnp'">
                {{ a.level ? `Sev ${a.level}` : 'Threshold' }}
              </span>
            </td>
            <td><b>{{ a.title }}</b></td>
            <td>{{ a.detail }}</td>
            <td class="mono">{{ (a.notify || []).join(', ') }}</td>
            <td class="mono muted">{{ (a.cc || []).join(', ') || '\u2014' }}</td>
            <td class="muted">{{ formatTime(a.when) }}</td>
            <td class="muted">{{ renotifyLabel(a.renotifyMinutes || 0) }}</td>
            <td class="mono muted">
              {{ (a.ids || []).slice(0, 4).join(', ') }}{{ (a.ids || []).length > 4 ? ` +${a.ids.length - 4}` : '' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-title" style="margin-top:18px">
      Email template <span class="hint">fields Larry's alert job fills in</span>
    </div>
    <pre>Subject: [SEV {level}] {flow} – {category}: {count} transaction(s) blocked

Severity:        {level}  ({levelName})
Flow / process:  {flow}
Category:        {categoryCode} – {categoryLabel}
Current count:   {count}   Threshold / rule: {rule}
First seen:      {openedAt}    Age: {age}
Transactions:    {entityRefs}  ({links to TeamCentral log / NetSuite record})
Error text:      {rawMessage}
Recommended:     {playbookStep}   e.g. "Map SKU in TeamCentral index, then re-run SO"
Escalated to:    {notify}   Cc: {cc}
Next reminder:   in {renotifyMinutes} min unless resolved or level changes</pre>
  </section>
</template>
