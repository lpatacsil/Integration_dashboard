<script setup lang="ts">
import { ref } from 'vue'
import type { Alert } from '../types'

const props = defineProps<{
  activeView: string
  alerts: Alert[]
}>()

const emit = defineEmits<{
  (e: 'update:activeView', view: string): void
}>()

const collapsed = ref(false)

interface NavItem {
  key: string
  label: string
  icon: string
  countFn?: () => number
  isBad?: () => boolean
}

const settingsItems: NavItem[] = [
  {
    key: 'settings-alerts', label: 'Alerts & Escalations', icon: '⚠',
    countFn: () => props.alerts.length,
    isBad: () => props.alerts.some(a => a.level >= 1),
  },
  { key: 'settings-rules', label: 'Rules & Logic', icon: '⚙' },
  { key: 'settings-channels', label: 'Notification Channels', icon: '✉' },
  { key: 'settings-contacts', label: 'Contacts', icon: '⊕' },
]

const isSettingsView = (view: string) => view.startsWith('settings-')

function toggle() {
  collapsed.value = !collapsed.value
}

function goBack() {
  emit('update:activeView', 'overview')
}
</script>

<template>
  <nav class="sidebar" :class="{ collapsed }" v-if="isSettingsView(activeView)">
    <div class="sidebar-header">
      <button class="sidebar-back" @click="goBack" title="Back to dashboard">
        <span class="sidebar-icon">&larr;</span>
        <span class="sidebar-label" v-show="!collapsed">Dashboard</span>
      </button>
      <button class="sidebar-toggle" @click="toggle" :title="collapsed ? 'Expand' : 'Collapse'">
        <span class="hamburger">☰</span>
      </button>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-heading" v-show="!collapsed">Settings</div>
      <button
        v-for="item in settingsItems"
        :key="item.key"
        class="sidebar-item"
        :class="{ active: activeView === item.key }"
        @click="emit('update:activeView', item.key)"
        :title="item.label"
      >
        <span class="sidebar-icon">{{ item.icon }}</span>
        <span class="sidebar-label" v-show="!collapsed">{{ item.label }}</span>
        <span
          v-if="!collapsed && item.countFn && item.countFn() > 0"
          class="sidebar-badge"
          :class="{ bad: item.isBad?.() }"
        >{{ item.countFn() }}</span>
      </button>
    </div>
  </nav>
</template>
