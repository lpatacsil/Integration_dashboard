<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettings } from '../../composables/useSettings'
import type { NotificationChannels } from '../../types'

const { settings, loading, error, load, saveSection } = useSettings()

const channels = ref<NotificationChannels>({
  email: { enabled: false, smtp: { host: '', port: 587, user: '', password: '', from: '' } },
  teams: { enabled: false, webhookUrl: '' },
})
const saved = ref(false)

onMounted(async () => {
  await load()
  if (settings.value?.notificationChannels) {
    channels.value = JSON.parse(JSON.stringify(settings.value.notificationChannels))
  }
})

async function save() {
  saved.value = false
  await saveSection('notificationChannels', channels.value)
  saved.value = true
  setTimeout(() => { saved.value = false }, 3000)
}
</script>

<template>
  <section class="panel on">
    <div class="section-title">
      Notification Channels
      <span class="hint">configure how alert notifications are delivered</span>
    </div>

    <div v-if="error" class="card" style="color:var(--crit-ink);margin-bottom:12px">{{ error }}</div>

    <div class="rulegrid">
      <!-- Email -->
      <div class="card">
        <h3>
          Email (SMTP)
          <label class="toggle-label">
            <input type="checkbox" v-model="channels.email.enabled" />
            {{ channels.email.enabled ? 'Enabled' : 'Disabled' }}
          </label>
        </h3>
        <div v-if="channels.email.enabled" class="settings-form">
          <label>SMTP Host
            <input v-model="channels.email.smtp.host" class="settings-input" placeholder="smtp.office365.com" />
          </label>
          <label>Port
            <input v-model.number="channels.email.smtp.port" class="settings-input" type="number" />
          </label>
          <label>Username
            <input v-model="channels.email.smtp.user" class="settings-input" placeholder="user@example.com" />
          </label>
          <label>Password
            <input v-model="channels.email.smtp.password" class="settings-input" type="password" placeholder="********" />
          </label>
          <label>From address
            <input v-model="channels.email.smtp.from" class="settings-input" placeholder="alerts@example.com" />
          </label>
        </div>
      </div>

      <!-- Teams -->
      <div class="card">
        <h3>
          Microsoft Teams
          <label class="toggle-label">
            <input type="checkbox" v-model="channels.teams.enabled" />
            {{ channels.teams.enabled ? 'Enabled' : 'Disabled' }}
          </label>
        </h3>
        <div v-if="channels.teams.enabled" class="settings-form">
          <label>Webhook URL
            <input v-model="channels.teams.webhookUrl" class="settings-input" placeholder="https://outlook.office.com/webhook/..." />
          </label>
        </div>
      </div>
    </div>

    <div class="settings-actions" style="margin-top:14px">
      <button class="btn-primary" @click="save" :disabled="loading">
        {{ loading ? 'Saving...' : 'Save' }}
      </button>
      <span v-if="saved" class="save-ok">Saved</span>
    </div>
  </section>
</template>
