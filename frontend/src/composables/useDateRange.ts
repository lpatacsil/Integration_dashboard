import { ref, computed, provide, inject, type InjectionKey, type Ref, type ComputedRef } from 'vue'

export interface DateRangeState {
  rangeKey: Ref<string>
  customFrom: Ref<string>
  customTo: Ref<string>
  startDate: ComputedRef<string>
  endDate: ComputedRef<string>
  granularity: ComputedRef<string>
  setRange: (key: string) => void
  setCustom: (from: string, to: string) => void
}

export const DateRangeKey: InjectionKey<DateRangeState> = Symbol('DateRange')

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

export function createDateRange(): DateRangeState {
  const rangeKey = ref('today')
  const customFrom = ref(daysAgo(13))
  const customTo = ref(todayStr())

  const startDate = computed(() => {
    switch (rangeKey.value) {
      case 'today': return todayStr()
      case 'yesterday': return daysAgo(1)
      case '7': return daysAgo(6)
      case '30': return daysAgo(29)
      case 'custom': return customFrom.value
      default: return todayStr()
    }
  })

  const endDate = computed(() => {
    switch (rangeKey.value) {
      case 'yesterday': return daysAgo(1)
      case 'custom': return customTo.value
      default: return todayStr()
    }
  })

  const granularity = computed(() => {
    return rangeKey.value === 'today' ? 'hour' : 'day'
  })

  function setRange(key: string) {
    rangeKey.value = key
    if (key === 'custom') {
      customFrom.value = daysAgo(13)
      customTo.value = todayStr()
    }
  }

  function setCustom(from: string, to: string) {
    customFrom.value = from
    customTo.value = to
  }

  const state: DateRangeState = { rangeKey, customFrom, customTo, startDate, endDate, granularity, setRange, setCustom }
  return state
}

export function provideDateRange(): DateRangeState {
  const state = createDateRange()
  provide(DateRangeKey, state)
  return state
}

export function useDateRange(): DateRangeState {
  const state = inject(DateRangeKey)
  if (!state) throw new Error('DateRange not provided')
  return state
}
