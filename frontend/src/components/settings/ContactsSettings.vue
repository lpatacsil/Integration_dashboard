<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettings } from '../../composables/useSettings'
import type { Contact } from '../../types'

const { settings, loading, error, load, saveSection } = useSettings()

interface ContactRow {
  key: string
  name: string
  email: string
}

const rows = ref<ContactRow[]>([])
const saved = ref(false)

onMounted(async () => {
  await load()
  syncFromSettings()
})

function syncFromSettings() {
  if (!settings.value) return
  rows.value = Object.entries(settings.value.contacts).map(([key, c]) => ({
    key, name: c.name, email: c.email,
  }))
}

function addRow() {
  const key = `Contact${rows.value.length + 1}`
  rows.value.push({ key, name: '', email: '' })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

async function save() {
  saved.value = false
  const contacts: Record<string, Contact> = {}
  for (const row of rows.value) {
    if (row.key.trim() && row.name.trim()) {
      contacts[row.key.trim()] = { name: row.name.trim(), email: row.email.trim() }
    }
  }
  await saveSection('contacts', contacts)
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}
</script>

<template>
  <section class="panel on">
    <div class="section-title">
      Contacts
      <span class="hint">people referenced by the escalation matrix and alert notifications</span>
    </div>

    <div v-if="error" class="card" style="color:var(--crit-ink);margin-bottom:12px">{{ error }}</div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Email</th>
            <th style="width:60px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td><input v-model="row.key" class="settings-input" placeholder="Key" /></td>
            <td><input v-model="row.name" class="settings-input" placeholder="Full name" /></td>
            <td><input v-model="row.email" class="settings-input" type="email" placeholder="email@example.com" /></td>
            <td><button class="btn-remove" @click="removeRow(i)" title="Remove">&times;</button></td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="empty">No contacts configured.</td>
          </tr>
        </tbody>
      </table>

      <div class="settings-actions">
        <button class="btn-secondary" @click="addRow">+ Add contact</button>
        <button class="btn-primary" @click="save" :disabled="loading">
          {{ loading ? 'Saving...' : 'Save' }}
        </button>
        <span v-if="saved" class="save-ok">Saved</span>
      </div>
    </div>
  </section>
</template>
