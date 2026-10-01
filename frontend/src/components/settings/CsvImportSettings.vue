<script setup lang="ts">
import { ref, onUnmounted } from 'vue'

const messagesFile = ref<File | null>(null)
const errorsFile = ref<File | null>(null)

type ImportState = 'idle' | 'reading' | 'uploading' | 'importing' | 'success' | 'error'
const state = ref<ImportState>('idle')
const resultMessage = ref('')
const progressLabel = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

function onFileChange(type: 'messages' | 'errors', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (type === 'messages') messagesFile.value = file
  else errorsFile.value = file
  if (state.value === 'success' || state.value === 'error') {
    state.value = 'idle'
    resultMessage.value = ''
  }
}

function onDrop(type: 'messages' | 'errors', event: DragEvent) {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0] ?? null
  if (file && file.name.endsWith('.csv')) {
    if (type === 'messages') messagesFile.value = file
    else errorsFile.value = file
    if (state.value === 'success' || state.value === 'error') {
      state.value = 'idle'
      resultMessage.value = ''
    }
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/csv-import/status')
      const data = await res.json()
      if (!data.running) {
        stopPolling()
        if (data.result) {
          state.value = 'success'
          resultMessage.value = data.result
        } else if (data.error) {
          state.value = 'error'
          resultMessage.value = data.error
        }
      }
    } catch {
      // keep polling
    }
  }, 2000)
}

async function doImport() {
  if (!messagesFile.value || !errorsFile.value) return

  state.value = 'reading'
  progressLabel.value = 'Reading files...'
  resultMessage.value = ''

  try {
    const body: { messages?: string; errors?: string } = {}
    body.messages = await readFileAsText(messagesFile.value)
    body.errors = await readFileAsText(errorsFile.value)

    state.value = 'uploading'
    progressLabel.value = 'Uploading to server...'

    const res = await fetch('/api/csv-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()

    if (res.ok && (data.status === 'started' || data.status === 'already_running')) {
      state.value = 'importing'
      progressLabel.value = 'Importing data — this may take a few minutes...'
      startPolling()
    } else if (res.ok && data.status === 'ok') {
      state.value = 'success'
      resultMessage.value = data.message || 'Import completed successfully.'
    } else {
      state.value = 'error'
      resultMessage.value = data.message || `Import failed (HTTP ${res.status}).`
    }
  } catch (err: any) {
    state.value = 'error'
    resultMessage.value = err.message || 'Import failed.'
  }
}

function clearFile(type: 'messages' | 'errors') {
  if (type === 'messages') messagesFile.value = null
  else errorsFile.value = null
}

const isWorking = () => state.value === 'reading' || state.value === 'uploading' || state.value === 'importing'

onUnmounted(() => stopPolling())
</script>

<template>
  <section class="panel on">
    <div class="section-title">
      CSV Import
      <span class="hint">upload CSV exports to populate the dashboard</span>
    </div>

    <div class="rulegrid">
      <!-- Messages CSV -->
      <div class="card">
        <h3>Message Logs CSV</h3>
        <p class="csv-desc">The "Message logs from team central" export containing transactions, systems, and identifiers.</p>
        <div
          class="drop-zone"
          :class="{ 'has-file': messagesFile }"
          @drop="onDrop('messages', $event)"
          @dragover="onDragOver"
        >
          <template v-if="messagesFile">
            <span class="file-name">{{ messagesFile.name }}</span>
            <button class="btn-remove" @click="clearFile('messages')" title="Remove">&times;</button>
          </template>
          <template v-else>
            <span class="drop-label">Drag &amp; drop a CSV here, or</span>
            <label class="btn-secondary pick-btn">
              Browse
              <input type="file" accept=".csv" @change="onFileChange('messages', $event)" hidden />
            </label>
          </template>
        </div>
      </div>

      <!-- Errors CSV -->
      <div class="card">
        <h3>Error Logs CSV</h3>
        <p class="csv-desc">The "Error logs in team central" export containing endpoint errors and error text.</p>
        <div
          class="drop-zone"
          :class="{ 'has-file': errorsFile }"
          @drop="onDrop('errors', $event)"
          @dragover="onDragOver"
        >
          <template v-if="errorsFile">
            <span class="file-name">{{ errorsFile.name }}</span>
            <button class="btn-remove" @click="clearFile('errors')" title="Remove">&times;</button>
          </template>
          <template v-else>
            <span class="drop-label">Drag &amp; drop a CSV here, or</span>
            <label class="btn-secondary pick-btn">
              Browse
              <input type="file" accept=".csv" @change="onFileChange('errors', $event)" hidden />
            </label>
          </template>
        </div>
      </div>
    </div>

    <!-- Progress bar -->
    <div v-if="isWorking()" class="progress-section">
      <div class="progress-bar-track">
        <div class="progress-bar-fill" :class="{ indeterminate: state === 'importing' }"></div>
      </div>
      <span class="progress-label">{{ progressLabel }}</span>
    </div>

    <div class="settings-actions">
      <button
        class="btn-primary"
        @click="doImport"
        :disabled="isWorking() || !messagesFile || !errorsFile"
      >
        {{ isWorking() ? 'Importing...' : 'Import' }}
      </button>

      <span v-if="state === 'success'" class="save-ok">{{ resultMessage }}</span>
      <span v-if="state === 'error'" class="import-error">{{ resultMessage }}</span>
    </div>
  </section>
</template>

<style scoped>
.csv-desc {
  font-size: 12px;
  color: var(--ink-3);
  margin: 4px 0 10px;
}

.drop-zone {
  border: 2px dashed var(--line-2);
  border-radius: 8px;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 64px;
  transition: border-color 0.15s, background 0.15s;
}

.drop-zone:not(.has-file) {
  cursor: default;
}

.drop-zone.has-file {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-soft);
}

.drop-label {
  font-size: 13px;
  color: var(--ink-3);
}

.pick-btn {
  cursor: pointer;
}

.file-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  word-break: break-all;
}

.import-error {
  font-size: 13px;
  color: var(--crit-ink, var(--crit));
  font-weight: 500;
}

.progress-section {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.progress-bar-track {
  width: 100%;
  height: 6px;
  background: var(--line);
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  width: 100%;
  transform-origin: left;
  animation: none;
}

.progress-bar-fill.indeterminate {
  width: 40%;
  animation: slide 1.5s ease-in-out infinite;
}

@keyframes slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(150%); }
  100% { transform: translateX(-100%); }
}

.progress-label {
  font-size: 12px;
  color: var(--ink-3);
  font-weight: 500;
}
</style>
