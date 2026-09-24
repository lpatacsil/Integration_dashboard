<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useSettings } from '../../composables/useSettings'
import { pillClass, formatTime } from '../../types'
import type { Alert, SettingsData } from '../../types'

const props = defineProps<{
  alerts: Alert[]
}>()

const { settings, loading, error, load, saveSection } = useSettings()

const escalation = ref<Record<number, { notify: string[]; cc: string[]; renotifyMinutes: number }>>({})
const thresholds = ref<Record<string, number>>({})
const saved = ref(false)

onMounted(async () => {
  await load()
  if (settings.value) {
    escalation.value = JSON.parse(JSON.stringify(settings.value.rules.escalation))
    thresholds.value = { ...settings.value.rules.thresholds }
  }
})

const contactKeys = computed(() => {
  if (!settings.value) return []
  return Object.keys(settings.value.contacts)
})

function escNotifyStr(level: number): string {
  return escalation.value[level]?.notify?.join(', ') ?? ''
}

function escCcStr(level: number): string {
  return escalation.value[level]?.cc?.join(', ') ?? ''
}

function setEscNotify(level: number, val: string) {
  if (!escalation.value[level]) return
  escalation.value[level].notify = val.split(',').map(s => s.trim()).filter(Boolean)
}

function setEscCc(level: number, val: string) {
  if (!escalation.value[level]) return
  escalation.value[level].cc = val.split(',').map(s => s.trim()).filter(Boolean)
}

function renotifyLabel(minutes: number): string {
  return minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`
}

async function save() {
  if (!settings.value) return
  saved.value = false
  const updatedRules = {
    ...settings.value.rules,
    escalation: escalation.value,
    thresholds: thresholds.value,
  }
  await saveSection('rules', updatedRules)
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}
</script>

<template>
  <section class="panel on">
    <!-- Live alerts (read-only) -->
    <div class="section-title">
      Live alerts
      <span class="hint">current incidents under the active rules — read-only</span>
    </div>

    <div class="card tablewrap" style="margin-bottom:18px">
      <div v-if="!alerts.length" class="empty">
        No alerts. Nothing has crossed a severity rule or a threshold.
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>Level</th>
            <th>Alert</th>
            <th>Detail</th>
            <th>Triggered</th>
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
            <td class="muted">{{ formatTime(a.when) }}</td>
            <td class="mono muted">
              {{ (a.ids || []).slice(0, 4).join(', ') }}{{ (a.ids || []).length > 4 ? ` +${a.ids.length - 4}` : '' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="error" class="card" style="color:var(--crit-ink);margin-bottom:12px">{{ error }}</div>

    <!-- Editable escalation matrix -->
    <div class="section-title">
      Escalation matrix
      <span class="hint">who gets notified at each severity level</span>
    </div>

    <div class="card tablewrap" style="margin-bottom:18px">
      <table class="matrix">
        <thead>
          <tr>
            <th>Level</th>
            <th>Notify (comma-separated)</th>
            <th>Cc (comma-separated)</th>
            <th>Re-notify (min)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="level in [1, 2, 3, 4]" :key="level">
            <td><strong>Sev {{ level }}</strong></td>
            <td>
              <input
                class="settings-input"
                :value="escNotifyStr(level)"
                @input="setEscNotify(level, ($event.target as HTMLInputElement).value)"
                placeholder="Larry, Quennie"
              />
            </td>
            <td>
              <input
                class="settings-input"
                :value="escCcStr(level)"
                @input="setEscCc(level, ($event.target as HTMLInputElement).value)"
                placeholder="Estevan"
              />
            </td>
            <td>
              <input
                class="settings-input"
                type="number"
                v-model.number="escalation[level]!.renotifyMinutes"
                style="width:80px"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Editable thresholds -->
    <div class="section-title">
      Thresholds
      <span class="hint">per-flow and per-category error limits that trigger alerts</span>
    </div>

    <div class="card tablewrap" style="margin-bottom:18px">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Threshold</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(val, key) in thresholds" :key="key">
            <td><code>{{ key }}</code></td>
            <td>
              <input class="settings-input" type="number" v-model.number="thresholds[key]" style="width:100px" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="settings-actions">
      <button class="btn-primary" @click="save" :disabled="loading">
        {{ loading ? 'Saving...' : 'Save escalation & thresholds' }}
      </button>
      <span v-if="saved" class="save-ok">Saved</span>
    </div>
  </section>
</template>
