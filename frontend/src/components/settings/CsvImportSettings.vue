<script setup lang="ts">
import { ref } from 'vue'

const messagesFile = ref<File | null>(null)
const errorsFile = ref<File | null>(null)

type ImportState = 'idle' | 'importing' | 'success' | 'error'
const state = ref<ImportState>('idle')
const resultMessage = ref('')

function onFileChange(type: 'messages' | 'errors', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  if (type === 'messages') messagesFile.value = file
  else errorsFile.value = file
  // Reset state when user picks new files
  if (state.value !== 'idle') {
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
    if (state.value !== 'idle') {
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

async function doImport() {
  if (!messagesFile.value || !errorsFile.value) return

  state.value = 'importing'
  resultMessage.value = ''

  try {
    const body: { messages?: string; errors?: string } = {}

    if (messagesFile.value) {
      body.messages = await readFileAsText(messagesFile.value)
    }
    if (errorsFile.value) {
      body.errors = await readFileAsText(errorsFile.value)
    }

    const res = await fetch('/api/csv-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()

    if (res.ok && data.status === 'ok') {
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

    <div class="settings-actions">
      <button
        class="btn-primary"
        @click="doImport"
        :disabled="state === 'importing' || !messagesFile || !errorsFile"
      >
        {{ state === 'importing' ? 'Importing...' : 'Import' }}
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
</style>
