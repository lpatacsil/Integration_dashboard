<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettings } from '../../composables/useSettings'
import type { Rules, CategoryRule } from '../../types'

const props = defineProps<{
  rules: Rules | null
  categoryRules: CategoryRule[]
}>()

const emit = defineEmits<{
  (e: 'updated'): void
}>()

const { settings, loading, error, load, saveSection } = useSettings()

// Editable copies
const severityRules = ref<Rules['severity'] | null>(null)
const editCategoryRules = ref<CategoryRule[]>([])
const saved = ref(false)

onMounted(async () => {
  await load()
  if (settings.value) {
    severityRules.value = JSON.parse(JSON.stringify(settings.value.rules.severity))
    editCategoryRules.value = settings.value.categoryRules.map(r => ({ ...r }))
  }
})

function catTagClass(c: CategoryRule): string {
  if (c.group === 'MAPPING' || c.group === 'INDEXING') return 'block'
  if (c.group === 'OUTAGE') return 'down'
  return ''
}

function addCategoryRule() {
  editCategoryRules.value.push({ code: '', group: '', label: '', match: '' })
}

function removeCategoryRule(index: number) {
  editCategoryRules.value.splice(index, 1)
}

async function saveSeverity() {
  if (!settings.value || !severityRules.value) return
  saved.value = false
  const updatedRules = {
    ...settings.value.rules,
    severity: severityRules.value,
  }
  await saveSection('rules', updatedRules)
  emit('updated')
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}

async function saveCategoryRules() {
  saved.value = false
  const filtered = editCategoryRules.value.filter(r => r.code.trim() && r.match.trim())
  await saveSection('categoryRules', filtered)
  emit('updated')
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}
</script>

<template>
  <section class="panel on">
    <div v-if="error" class="card" style="color:var(--crit-ink);margin-bottom:12px">{{ error }}</div>

    <div class="rulegrid">
      <div>
        <!-- Severity rules -->
        <div class="section-title">Severity ladder <span class="hint">evaluated every refresh, per flow and overall</span></div>
        <div class="card prose">
          <p>Severity is driven by <strong>integration-blocking</strong> errors only — the ones where a data object is not mapped or was skipped by indexing.</p>
          <div class="steps">
            <div class="step"><span class="k">SEV 0</span><span>No open blocking errors. Connector heartbeat fresh, transactions flowing.</span></div>
            <div class="step"><span class="k">SEV 1</span><span><strong>Exactly one</strong> transaction blocked by a mapping / indexing gap.</span></div>
            <div class="step"><span class="k">SEV 2</span><span><strong>More than one</strong> transaction blocked, all opened today.</span></div>
            <div class="step"><span class="k">SEV 3</span><span>More than one blocked <strong>and</strong> the oldest has crossed into the next business day.</span></div>
            <div class="step"><span class="k">SEV 4</span><span><strong>Tool down.</strong> Connector heartbeat older than configured max, or zero transactions during normal traffic.</span></div>
          </div>
        </div>

        <template v-if="severityRules">
          <div class="section-title" style="margin-top:18px">Severity parameters</div>
          <div class="card">
            <div class="settings-form">
              <label>Blocking groups (comma-separated)
                <input class="settings-input" :value="severityRules.blockingGroups.join(', ')"
                  @input="severityRules!.blockingGroups = ($event.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)" />
              </label>
              <label>Sev 4: Heartbeat max minutes
                <input class="settings-input" type="number" v-model.number="severityRules.sev4.heartbeatMaxMinutes" />
              </label>
              <label>Sev 4: Zero traffic window (minutes)
                <input class="settings-input" type="number" v-model.number="severityRules.sev4.zeroTrafficWindowMinutes" />
              </label>
              <label>Sev 3: Min blocked count
                <input class="settings-input" type="number" v-model.number="severityRules.sev3.minBlocked" />
              </label>
              <label>Sev 2: Min blocked count
                <input class="settings-input" type="number" v-model.number="severityRules.sev2.minBlocked" />
              </label>
            </div>
            <div class="settings-actions">
              <button class="btn-primary" @click="saveSeverity" :disabled="loading">
                {{ loading ? 'Saving...' : 'Save severity rules' }}
              </button>
              <span v-if="saved" class="save-ok">Saved</span>
            </div>
          </div>
        </template>

        <!-- Classifier pseudo-code (read-only) -->
        <div class="section-title" style="margin-top:18px">Classifier pseudo-code</div>
        <pre>function classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60) {
  if (heartbeatAgeMin > 30 || (txLast60 === 0 &amp;&amp; baselineLast60 > 0)) return 4;
  const n = openBlocking.length;
  if (n === 0) return 0;
  const crossedDay = openBlocking.some(e => e.openedAt &lt; startOfToday());
  if (n > 1 &amp;&amp; crossedDay) return 3;
  if (n > 1) return 2;
  return 1;
}</pre>
      </div>

      <div>
        <!-- Error category rules -->
        <div class="section-title">Error category codes <span class="hint">editable regex-based classifier</span></div>
        <div class="card tablewrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Group</th>
                <th>Label</th>
                <th>Match regex</th>
                <th style="width:40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in editCategoryRules" :key="i">
                <td><input v-model="c.code" class="settings-input settings-input-sm" placeholder="MAP-CUST" /></td>
                <td><input v-model="c.group" class="settings-input settings-input-sm" placeholder="MAPPING" /></td>
                <td><input v-model="c.label" class="settings-input" placeholder="Customer not mapped" /></td>
                <td><input v-model="c.match" class="settings-input mono" placeholder="customer.*(not found)" /></td>
                <td><button class="btn-remove" @click="removeCategoryRule(i)">&times;</button></td>
              </tr>
            </tbody>
          </table>

          <div class="settings-actions">
            <button class="btn-secondary" @click="addCategoryRule">+ Add rule</button>
            <button class="btn-primary" @click="saveCategoryRules" :disabled="loading">
              {{ loading ? 'Saving...' : 'Save category rules' }}
            </button>
            <span v-if="saved" class="save-ok">Saved</span>
          </div>
        </div>

        <!-- Rule JSON reference (read-only) -->
        <div class="section-title" style="margin-top:18px">Rule JSON <span class="hint">current active config</span></div>
        <pre>{{ props.rules ? JSON.stringify(props.rules, null, 2) : '' }}</pre>
      </div>
    </div>
  </section>
</template>
