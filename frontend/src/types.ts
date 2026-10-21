/* ── Flow configuration ── */
export interface FlowConfig {
  name: string
  dir: string
}

export const FLOWS: Record<string, FlowConfig> = {
  S2N: { name: 'Shopify \u2192 NetSuite', dir: 'Draft orders to sales orders' },
  N2S: { name: 'NetSuite \u2192 Shopify', dir: 'Orders to billed' },
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
  resolved: number
  open_errors: number
  pending_rerun: number
  reruns: number
}

export interface ResolvedContact {
  key: string
  name: string
  email: string
}

export interface EscalationInfo {
  notify: ResolvedContact[]
  cc: ResolvedContact[]
  renotifyMinutes: number
}

export interface EscalationRule {
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
  open: number
  resolved: number
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
  relatedCases?: RelatedCase[]
  nsIssues?: NsIssue[]
  nsSourceErrors?: string[]
}

export interface NsIssue {
  category: 'TAX-VERTEX' | 'INV-ITEM' | 'VAL-DATA'
  so_id: string
  so_number: string
  draft_number: string | null
  customer: string | null
  detail: string
  occurred_at: string
  url: string
}

export interface RelatedCase {
  id: string
  issue_id: string
  detail: string
  status: string
  is_open: boolean
  owner: string | null
  assigned_to: string | null
  customer: string | null
  issue_type: string | null
  sales_order: string | null
  draft_number: string | null
  created_date: string
  url: string
  integration_reason: string | null
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
    sev4: { enabled: boolean; heartbeatMaxMinutes: number; zeroTrafficWindowMinutes: number; useBaseline: boolean }
    sev3: { minBlocked: number; olderThan: string }
    sev2: { minBlocked: number }
    sev1: { minBlocked: number }
  }
  thresholds: Record<string, number>
  escalation: Record<number, EscalationRule>
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

/* ── /api/netsuite/sales-orders ── */
export interface NetsuiteSalesOrder {
  so_number: string
  memo: string | null
  customer: string | null
  total_amount: number | null
  location: string | null
  trandate: string | null
}

export interface SalesOrdersResponse {
  orders: NetsuiteSalesOrder[]
  source: string
}

/* ── /api/reconciliation ── */
export interface ReconRecord {
  netsuite_so: string | null
  netsuite_memo: string | null
  netsuite_customer: string | null
  netsuite_amount: string | null
  netsuite_date: string | null
  netsuite_location: string | null
  netsuite_shopify_so: string | null
  shopify_draft: string | null
  shopify_customer: string | null
  shopify_amount: string | null
  shopify_order: string | null
  shopify_created: string | null
  status: 'matched' | 'missing_in_netsuite' | 'missing_in_shopify' | 'no_memo'
}

export interface ReconSummary {
  total: number
  matched: number
  missing_in_netsuite: number
  missing_in_shopify: number
  no_memo: number
  netsuite_sos: number
  shopify_drafts: number
}

export interface ReconciliationResponse {
  records: ReconRecord[]
  summary: ReconSummary
}

/* ── /api/reconciliation/sync-status ── */
export interface UnmatchedDraft {
  draft_number: string
  shopify_customer: string | null
  shopify_amount: string | null
  shopify_created: string | null
  first_seen: string
  age_minutes: number
  notified_at: string | null
}

export interface ResolvedDraft {
  draft_number: string
  shopify_customer: string | null
  shopify_amount: string | null
  shopify_created: string | null
  netsuite_so: string | null
  first_seen: string
  resolved_at: string
  time_to_resolve_minutes: number
  was_alerted: boolean
}

export interface ReconSyncStatus {
  last_sync_at: string | null
  last_sync_duration_ms: number
  sync_count: number
  unmatched_drafts: UnmatchedDraft[]
  resolved_drafts: ResolvedDraft[]
  matched_count: number
  netsuite_sos: number
  shopify_drafts: number
  error: string | null
  last_notification_at: string | null
  notifications_sent: number
}

/* ── /api/shopify/orders ── */
export interface ShopifyOrder {
  order_number: string
  created_at: string
  customer: string | null
  total_price: string | null
  financial_status: string | null
  fulfillment_status: string | null
  note: string | null
}

export interface ShopifyOrdersResponse {
  orders: ShopifyOrder[]
  source: string
}

export interface ShopifyDraftOrder {
  draft_number: string
  created_at: string
  customer: string | null
  total_price: string | null
  status: string | null
  note: string | null
}

export interface ShopifyDraftOrdersResponse {
  draft_orders: ShopifyDraftOrder[]
  source: string
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
