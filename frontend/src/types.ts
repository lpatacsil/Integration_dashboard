/* ── Flow configuration ── */
export interface FlowConfig {
  name: string
  dir: string
}

export const FLOWS: Record<string, FlowConfig> = {
  S2N: { name: 'Shopify \u2192 NetSuite', dir: 'Orders \u00b7 customers \u00b7 payments' },
  N2S: { name: 'NetSuite \u2192 Shopify', dir: 'Draft orders \u00b7 fulfillments \u00b7 inventory' },
  IDX: { name: 'Indexing', dir: 'Customer \u00b7 item \u00b7 ship-to \u00b7 location' },
  NS:  { name: 'NetSuite internal', dir: 'Vertex \u00b7 inventory \u00b7 validation' },
}

/* ── /api/health ── */
export interface HealthResponse {
  status: 'ok' | 'error'
  db: 'connected' | 'disconnected'
  serverTime: string
  message?: string
}

/* ── /api/overview ── */
export interface OpenBlockingError {
  error_id: number
  transaction_id: number
  flow_code: string
  entity_identifier: string
  error_code: string
  error_message: string
  occurred_at: string
}

export interface FlowStats {
  name: string
  dir: string
  severity: number
  total: number
  succeeded: number
  errored: number
  pending_rerun: number
  reruns: number
}

export interface EscalationInfo {
  notify: string[]
  cc: string[]
  renotifyMinutes: number
}

export interface OverviewResponse {
  severity: number
  heartbeatAgeMin: number
  txLast60: number
  baselineLast60: number
  openBlockingCount: number
  openBlocking: OpenBlockingError[]
  perFlowSeverity: Record<string, number>
  flowStats: Record<string, FlowStats>
  sparklines: Record<string, number[]>
  escalation: EscalationInfo | null
  startDate: string
  endDate: string
}

/* ── /api/trends ── */
export interface TrendBucket {
  label: string
  ok: number
  er: number
  pe: number
}

export interface TrendsResponse {
  granularity: 'hour' | 'day'
  buckets: TrendBucket[]
}

/* ── /api/errors/categories ── */
export interface ErrorCategory {
  error_code: string
  category_label: string
  error_group: string
  is_blocking: boolean
  count: number
}

export interface ErrorCategoriesResponse {
  categories: ErrorCategory[]
}

/* ── /api/errors/open-incidents ── */
export interface Incident {
  error_id: number
  flow_code: string
  entity_identifier: string
  transaction_type: string
  error_code: string
  category_label: string
  error_group: string
  is_blocking: boolean
  error_message: string
  raw_error?: string
  occurred_at: string
  age_minutes: number
}

export interface OpenIncidentsResponse {
  incidents: Incident[]
}

/* ── /api/flows/:code ── */
export interface FlowKpi {
  total: number
  succeeded: number
  errored: number
  pending: number
  reruns: number
  reruns_succeeded: number
  successRate: string
}

export interface DailyRow {
  day: string
  ok: number
  errors: number
  reruns: number
}

export interface IndexingNeedSummary {
  error_code: string
  category_label: string
  error_count: number
  order_count: number
}

export interface IndexingNeedOrder {
  entity_identifier: string
  transaction_type: string
  error_code: string
  category_label: string
  error_message: string
  occurred_at: string
  age_minutes: number
}

export interface IndexingNeeds {
  summary: IndexingNeedSummary[]
  totalErrors: number
  totalOrders: number
  openOrders: IndexingNeedOrder[]
}

export interface FlowDetailResponse {
  flowCode: string
  name: string
  dir: string
  severity: number
  kpi: FlowKpi
  categories: ErrorCategory[]
  daily: DailyRow[]
  openIncidents: Incident[]
  sparkline: number[]
  indexingNeeds?: IndexingNeeds
}

/* ── /api/alerts ── */
export interface Alert {
  level: number
  title: string
  detail: string
  notify: string[]
  cc: string[]
  when: string
  renotifyMinutes: number
  ids: string[]
}

export interface AlertsResponse {
  alerts: Alert[]
  severity: number
}

/* ── /api/rules ── */
export interface CategoryRule {
  code: string
  group: string
  label: string
  match: string
}

export interface Rules {
  severity: {
    blockingGroups: string[]
    sev4: { heartbeatMaxMinutes: number; zeroTrafficWindowMinutes: number; useBaseline: boolean }
    sev3: { minBlocked: number; olderThan: string }
    sev2: { minBlocked: number }
    sev1: { minBlocked: number }
  }
  thresholds: Record<string, number>
  escalation: Record<number, EscalationInfo>
}

export interface RulesResponse {
  categories: CategoryRule[]
  rules: Rules
}

/* ── /api/settings ── */
export interface Contact {
  name: string
  email: string
}

export interface SmtpConfig {
  host: string
  port: number
  user: string
  password: string
  from: string
}

export interface NotificationChannels {
  email: {
    enabled: boolean
    smtp: SmtpConfig
  }
  teams: {
    enabled: boolean
    webhookUrl: string
  }
}

export interface SettingsData {
  contacts: Record<string, Contact>
  categoryRules: CategoryRule[]
  rules: Rules
  notificationChannels: NotificationChannels
}

/* ── Helpers ── */
export const SEV_NAMES = ['Healthy', 'Sev 1', 'Sev 2', 'Sev 3', 'Sev 4'] as const

export function pillClass(level: number): string {
  return level === 0 ? 'ok' : `s${level}`
}

export function formatAge(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.floor(minutes % 60)
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`
}

export function formatTime(d: string): string {
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
