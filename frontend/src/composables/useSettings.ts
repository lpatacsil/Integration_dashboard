import { ref } from 'vue'
import { fetchJSON, putJSON, patchJSON } from './useApi'
import type { SettingsData } from '../types'

const settings = ref<SettingsData | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

export function useSettings() {
  async function load() {
    loading.value = true
    error.value = null
    try {
      settings.value = await fetchJSON<SettingsData>('/settings')
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function save(data: SettingsData) {
    loading.value = true
    error.value = null
    try {
      settings.value = await putJSON<SettingsData>('/settings', data)
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function saveSection(section: string, data: unknown) {
    loading.value = true
    error.value = null
    try {
      settings.value = await patchJSON<SettingsData>(`/settings/${section}`, data)
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  return { settings, loading, error, load, save, saveSection }
}
