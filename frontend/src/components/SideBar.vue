<script setup lang="ts">
import { ref } from 'vue'
import type { Incident, Alert } from '../types'

const props = defineProps<{
  activeView: string
  incidents: Incident[]
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

const dashboardItems: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: '⊞' },
  {
    key: 's2n', label: 'S2N', icon: '→',
    countFn: () => props.incidents.filter(i => i.flow_code === 'S2N').length,
    isBad: () => props.incidents.some(i => i.flow_code === 'S2N'),
  },
  {
    key: 'n2s', label: 'N2S', icon: '←',
    countFn: () => props.incidents.filter(i => i.flow_code === 'N2S').length,
    isBad: () => props.incidents.some(i => i.flow_code === 'N2S'),
  },
  {
    key: 'idx', label: 'IDX', icon: '⊟',
    countFn: () => props.incidents.filter(i => i.flow_code === 'IDX').length,
    isBad: () => props.incidents.some(i => i.flow_code === 'IDX'),
  },
  {
    key: 'nsint', label: 'NS', icon: '⊡',
    countFn: () => props.incidents.filter(i => i.flow_code === 'NS').length,
    isBad: () => props.incidents.some(i => i.flow_code === 'NS'),
  },
]

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

function toggle() {
  collapsed.value = !collapsed.value
}
</script>

<template>
  <nav class="sidebar" :class="{ collapsed }">
    <button class="sidebar-toggle" @click="toggle" :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'">
      <span class="hamburger">☰</span>
    </button>

    <div class="sidebar-section">
      <div class="sidebar-heading" v-show="!collapsed">Dashboard</div>
      <button
        v-for="item in dashboardItems"
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
