// Domain-level storage interface. This is the seam between routes/services and the
// storage backend — today only blob-store.ts implements it, but a future
// postgres-store.ts (wrapping the dormant SQL in ../db.ts) could implement the
// same interface without any route changes.

export interface Transaction {
  id: string;
  external_id: string | null;
  team_central_id: string | null;
  batch_id: string | null;
  flow_code: string;
  transaction_type: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_identifier: string | null;
  netsuite_record_type: string | null;
  netsuite_record_id: string | null;
  sales_order_id: string | null;
  external_order_id: string | null;
  original_status: string | null;
  normalized_status: string;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
  last_attempt_at: string | null;
  last_error_at: string | null;
  processing_duration_ms: number | null;
  retry_count: number;
  rerun_count: number;
  is_rerun: boolean;
  raw_payload: Record<string, any> | null;
  raw_response: Record<string, any> | null;
}

export interface IntegrationError {
  id: string;
  transaction_id: string;
  error_code: string | null;
  error_group: string | null;
  category_label: string | null;
  error_message: string;
  raw_error: string | null;
  occurred_at: string;
  resolved_at: string | null;
  retry_count: number;
  is_blocking: boolean;
  is_current: boolean;
  created_at: string;
}

export interface Rerun {
  id: string;
  transaction_id: string;
  sales_order_id: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

export interface IndexingActivity {
  id: string;
  index_type: string;
  status: string;
  created_at: string;
}

export interface Heartbeat {
  heartbeat_at: string;
  system_code: string;
  status: string;
  metadata: Record<string, any> | null;
}

export interface AlertIncident {
  id: string;
  incident_key: string;
  flow_code: string;
  error_code: string | null;
  entity_identifier: string | null;
  severity_level: number;
  title: string;
  detail: string | null;
  notify: string[];
  cc: string[];
  renotify_minutes: number;
  transaction_ids: string[];
  status: 'OPEN' | 'RESOLVED' | 'ACKNOWLEDGED';
  opened_at: string;
  last_notified_at: string | null;
  last_level_change: string | null;
  resolved_at: string | null;
  notification_count: number;
  created_at: string;
  updated_at: string;
}

export interface AlertNotification {
  id: string;
  incident_id: string;
  incident_key: string;
  flow_code: string;
  error_code: string | null;
  entity_identifier: string | null;
  notification_type: 'OPENED' | 'LEVEL_CHANGE' | 'RENOTIFY' | 'RESOLVED';
  severity_level: number;
  recipients: string[];
  cc: string[];
  subject: string;
  body: string;
  sent: boolean;
  sent_at: string | null;
  created_at: string;
}

export interface SeveritySnapshot {
  id: string;
  evaluated_at: string;
  overall_severity: string;
  flow_severities: Record<string, string>;
  open_blocking_count: number;
  heartbeat_age_min: number | null;
  tx_last_60: number | null;
  baseline_last_60: number | null;
  details: Record<string, any> | null;
}

export interface DateRange {
  start: Date;
  end: Date; // exclusive
}

export interface Store {
  // Transactions
  insertTransaction(tx: Omit<Transaction, 'id' | 'created_at' | 'updated_at'> & Partial<Pick<Transaction, 'created_at'>>): Promise<Transaction>;
  updateTransaction(id: string, patch: Partial<Transaction>): Promise<void>;
  getTransactionById(id: string): Promise<Transaction | null>;
  getTransactionsByIds(ids: string[]): Promise<Map<string, Transaction>>;
  getTransactionBySalesOrderId(salesOrderId: string): Promise<Transaction | null>;
  queryTransactions(range: DateRange): Promise<Transaction[]>;
  findTransactionsNeedingNetsuiteSync(limit: number): Promise<Transaction[]>;
  countNetsuiteSyncStatus(): Promise<{ pending: number; enriched: number }>;
  /** All transactions currently PENDING/PROCESSING, regardless of age — used for the SLA staleness check. */
  getPendingTransactions(): Promise<Transaction[]>;

  // Errors. category_label/error_group/is_blocking are optional on insert — if
  // omitted, they're derived from error_code via CATEGORY_RULES (see blob-store.ts).
  insertError(
    err: Omit<IntegrationError, 'id' | 'created_at' | 'category_label' | 'error_group' | 'is_blocking'>
      & Partial<Pick<IntegrationError, 'category_label' | 'error_group' | 'is_blocking'>>,
  ): Promise<IntegrationError>;
  resolveError(id: string): Promise<void>;
  getErrorsForTransaction(transactionId: string): Promise<IntegrationError[]>;
  queryErrors(range: DateRange): Promise<IntegrationError[]>;
  getOpenErrors(): Promise<IntegrationError[]>;

  // Reruns
  insertRerun(rerun: Omit<Rerun, 'id'>): Promise<Rerun>;
  queryReruns(range: DateRange): Promise<Rerun[]>;
  getRerunsForTransaction(transactionId: string): Promise<Rerun[]>;

  // Indexing activity
  insertIndexingActivity(activity: Omit<IndexingActivity, 'id'>): Promise<IndexingActivity>;
  queryIndexingActivity(range: DateRange): Promise<IndexingActivity[]>;

  // Heartbeats
  recordHeartbeat(hb: Heartbeat): Promise<void>;
  getLatestHeartbeat(): Promise<Heartbeat | null>;

  // Alert incidents / notifications
  getOpenIncidents(): Promise<AlertIncident[]>;
  upsertIncident(incident: AlertIncident): Promise<void>;
  resolveIncident(id: string): Promise<void>;
  getIncidentHistory(limit: number): Promise<AlertIncident[]>;
  insertNotification(n: Omit<AlertNotification, 'id' | 'created_at'>): Promise<AlertNotification>;
  getRecentNotifications(limit: number): Promise<AlertNotification[]>;
  getUnsentNotifications(): Promise<AlertNotification[]>;
  markNotificationsSent(ids: string[]): Promise<void>;

  // Severity snapshots
  insertSeveritySnapshot(s: Omit<SeveritySnapshot, 'id'>): Promise<void>;

  // Health
  ping(): Promise<void>;
}
