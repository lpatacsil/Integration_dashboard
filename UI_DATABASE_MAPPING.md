# Integration Monitor — UI to Database Mapping

Maps every dashboard component from the HTML prototype to its database source.

---

## Top Bar

| UI Component | Data | Table | Field(s) |
|---|---|---|---|
| Brand title | Static | — | — |
| Date range selector | Filter parameter | integration_transactions | created_at |
| Scenario selector | Removed in production | — | Severity computed in real time |

---

## Health Strip

| UI Element | Data | Source |
|---|---|---|
| Integration status label | Severity level (Sev 0–4) | Computed from v_open_blocking_errors + connector_heartbeats |
| Status description | Plain-language reason | Computed: count of open blocking errors, heartbeat age, traffic count |
| Escalated to / Copied | Escalation contacts | sla_rules (severity) → application-level escalation config |
| Re-notify cadence | Per-level schedule | Application config (from spec's escalation matrix) |

### Severity computation inputs

| Input | Source | Query |
|---|---|---|
| Open blocking errors | integration_errors | `WHERE is_blocking = TRUE AND resolved_at IS NULL AND is_current = TRUE` |
| Heartbeat age (minutes) | connector_heartbeats | `SELECT heartbeat_at FROM connector_heartbeats ORDER BY heartbeat_at DESC LIMIT 1` |
| Transactions in last 60 min | integration_transactions | `WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '60 min'` |
| 4-week baseline | integration_transactions | `COUNT WHERE same hour and weekday, last 4 weeks` |

---

## Overview Tab

### Severity Tiles (Sev 0–4)

| UI Element | Source |
|---|---|
| Current severity level | Computed from v_open_blocking_errors + connector_heartbeats |
| Count of blocking errors | `SELECT COUNT(*) FROM v_open_blocking_errors` |
| Sev 0 check mark | No open blocking + fresh heartbeat |
| Sev 4 "DOWN" | Heartbeat > 30 min or zero traffic vs baseline |

### Flow Cards (S2N, N2S, IDX, NS)

| UI Column | Table | Field | Query |
|---|---|---|---|
| Flow name | Static | — | Mapped from flow_code |
| Direction label | Static | — | |
| Severity pill | Computed | — | Per-flow severity from blocking errors |
| Processed count | integration_transactions | COUNT(*) | `WHERE flow_code = ? AND created_at BETWEEN ? AND ?` |
| Error count | integration_transactions | COUNT(*) | `WHERE flow_code = ? AND normalized_status = 'FAILED'` |
| Pending/re-run count | integration_transactions | COUNT(*) | `WHERE normalized_status IN ('PENDING','RETRY','PROCESSING')` |
| 14-day error sparkline | integration_transactions | COUNT per day | `WHERE flow_code = ? AND normalized_status = 'FAILED' GROUP BY DATE(created_at)` for last 14 days |
| Today's errors | integration_transactions | COUNT(*) | Last point of sparkline |

### Daily Volume by Outcome (Stacked Bar Chart)

| UI Element | Source |
|---|---|
| X-axis: day or hour | v_daily_trend.day |
| Succeeded bar | v_daily_trend.succeeded |
| Errored bar | v_daily_trend.errored |
| Pending/re-run bar | v_daily_trend.pending_rerun |
| Tooltip totals | Sum of above |

### Errors by Category

| UI Column | Table | Field |
|---|---|---|
| Category code (pill) | error_categories | code |
| Category label | error_categories | label |
| Error count | v_error_category_summary | error_count |
| Blocking indicator | error_categories | is_blocking |
| Inline bar width | Calculated | count / max_count * 100% |

### Open Incidents Table

| UI Column | Table | Field |
|---|---|---|
| Flow | integration_transactions | flow_code → display name |
| Transaction | integration_transactions | entity_identifier |
| Type | integration_transactions | transaction_type |
| Category (pill) | integration_errors → error_categories | code, is_blocking |
| Message | integration_errors | error_message |
| Opened | integration_errors | occurred_at |
| Age | Calculated | NOW() - occurred_at |
| Level | Determined by | is_blocking + occurred_at vs start of today |
| Owner | Application logic | Blocking → Larry/Quennie; Pending → Auto-retry; NS → NS admin |

**Query:** `SELECT * FROM v_open_incidents ORDER BY occurred_at DESC`

---

## Shopify → NetSuite Tab (S2N)

### KPI Cards

| UI Metric | Table | Query |
|---|---|---|
| Processed | integration_transactions | `COUNT(*) WHERE flow_code = 'S2N'` |
| Succeeded | integration_transactions | `COUNT(*) WHERE flow_code = 'S2N' AND normalized_status = 'SUCCESS'` |
| Errored | integration_transactions | `COUNT(*) WHERE flow_code = 'S2N' AND normalized_status = 'FAILED'` |
| Pending | integration_transactions | `COUNT(*) WHERE flow_code = 'S2N' AND normalized_status = 'PENDING'` |
| Success rate | Calculated | succeeded / processed * 100 |
| SO re-runs | integration_reruns | `COUNT(*) WHERE sales_order_id IN (S2N transactions)` |
| Re-run succeeded | integration_reruns | `COUNT(*) WHERE status = 'SUCCESS'` |
| Threshold comparison | sla_rules | `WHERE process = 'S2N'` → threshold value |

### Error Categories Table

| UI Column | Table | Field |
|---|---|---|
| Code | error_categories | code |
| Meaning | error_categories | label |
| Count | integration_errors | COUNT GROUP BY error_code |
| Group | error_categories | error_group / is_blocking |

### Daily Breakdown Table

| UI Column | Source |
|---|---|
| Day | DATE(created_at) |
| OK | COUNT WHERE normalized_status = 'SUCCESS' |
| Errors | COUNT WHERE normalized_status = 'FAILED' |
| Re-runs | COUNT WHERE is_rerun = TRUE |

### Open/Needs Follow-up Table

Same structure as Open Incidents, filtered to `flow_code = 'S2N'`.

---

## NetSuite → Shopify Tab (N2S)

Same structure as S2N tab, filtered to `flow_code = 'N2S'`.

---

## Indexing Tab

### KPI Cards

| UI Metric | Table | Query |
|---|---|---|
| Index runs | indexing_activity | COUNT(*) |
| New index records | indexing_activity | `COUNT(*) WHERE status = 'SUCCESS'` |
| Index failures | indexing_activity | `COUNT(*) WHERE status = 'FAILED'` |
| Threshold | sla_rules | `WHERE process = 'IDX'` |

### Breakdown

| UI Column | Table | Field |
|---|---|---|
| Index type | indexing_activity | index_type |
| Status | indexing_activity | status |
| Count per type | indexing_activity | COUNT GROUP BY index_type, status |
| Activity date | indexing_activity | DATE(created_at) |

---

## NetSuite Internal Log Tab

### KPI Cards

| UI Metric | Table | Query |
|---|---|---|
| Transactions posted | integration_transactions | `COUNT(*) WHERE flow_code = 'NS'` |
| Passed | integration_transactions | `COUNT(*) WHERE flow_code = 'NS' AND normalized_status = 'SUCCESS'` |
| Failed in NetSuite | integration_transactions | `COUNT(*) WHERE flow_code = 'NS' AND normalized_status = 'FAILED'` |
| Vertex failures | integration_errors | `COUNT(*) WHERE error_code = 'TAX-VERTEX'` |
| Inventory failures | integration_errors | `COUNT(*) WHERE error_code = 'INV-ITEM'` |
| Validation failures | integration_errors | `COUNT(*) WHERE error_code = 'VAL-DATA'` |
| Threshold per category | sla_rules | `WHERE process = 'NS' AND category = ?` |
| Over/Within threshold | Calculated | count vs threshold |

### Failures by Category Table

| UI Column | Table | Field |
|---|---|---|
| Code | integration_errors | error_code |
| Meaning | error_categories | label |
| Count | integration_errors | COUNT |
| Threshold | sla_rules | threshold |
| State (over/within) | Calculated | count > threshold |

### Open NetSuite Errors Table

Same incident table structure, filtered to `flow_code = 'NS'`.

---

## Alerts & Escalations Tab

| UI Column | Source |
|---|---|
| Level (pill) | severity_snapshots.overall_severity OR sla_breaches.severity |
| Alert title | Computed from severity + flow + category |
| Detail | Open blocking count or threshold breach description |
| Notify | Application escalation config by severity level |
| Cc | Application escalation config |
| Triggered | severity_snapshots.evaluated_at or sla_breaches.triggered_at |
| Re-notify | Application config: Sev 1–2 = 240 min, Sev 3 = 120 min, Sev 4 = 30 min |
| Transactions | integration_transactions.entity_identifier via v_open_blocking_errors |

---

## Rules & Logic Tab

All content is reference data, sourced from:

| Section | Source |
|---|---|
| Severity ladder | Static documentation + sla_rules configuration |
| Escalation matrix | Application configuration (spec section 5) |
| Alert de-duplication | Static documentation |
| Error category codes table | error_categories table |
| Rule JSON | sla_rules + application severity config |
| Classifier pseudo-code | Static documentation |
| NetSuite saved-search formula | Static documentation |

---

## Filters (All Tabs)

| Filter | Table | Field | Index |
|---|---|---|---|
| Date range (Today, Yesterday, 7d, 30d, Custom) | integration_transactions | created_at | idx_txn_created_at |
| Status | integration_transactions | normalized_status | idx_txn_normalized_status |
| Flow / Direction | integration_transactions | flow_code | idx_txn_flow_code |
| Sales Order search | integration_transactions | sales_order_id | idx_txn_sales_order |
| Transaction type | integration_transactions | transaction_type | idx_txn_transaction_type |
| Error code | integration_errors | error_code | idx_errors_code |
| Error category | integration_errors | error_category_id | idx_errors_category |
| Source system | integration_transactions | source_system_id | idx_txn_source_dest |
| Destination system | integration_transactions | destination_system_id | idx_txn_source_dest |
| Endpoint | integration_transactions | endpoint_id | idx_txn_endpoint |

---

## Pagination

All list endpoints use server-side pagination.

| Parameter | Type | Default |
|---|---|---|
| page | int | 1 |
| pageSize | int | 25 |

Response includes `totalRecords` and `totalPages` from `COUNT(*)` query.

---

## Dashboard Metrics (Dynamic Calculation)

No metrics are stored as manually maintained values. All are computed:

| Metric | SQL Pattern |
|---|---|
| Total transactions | `COUNT(*) FROM integration_transactions WHERE ...date range...` |
| Successful | `COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')` |
| Failed | `COUNT(*) FILTER (WHERE normalized_status = 'FAILED')` |
| Pending | `COUNT(*) FILTER (WHERE normalized_status = 'PENDING')` |
| Processing | `COUNT(*) FILTER (WHERE normalized_status = 'PROCESSING')` |
| Retry | `COUNT(*) FILTER (WHERE normalized_status = 'RETRY')` |
| Success rate | `100.0 * success / NULLIF(total, 0)` |
| Error count | `COUNT(*) FROM integration_errors WHERE ...` |
| Rerun count | `COUNT(*) FROM integration_reruns WHERE ...` |
| Indexing count | `COUNT(*) FROM indexing_activity WHERE ...` |
| SLA breaches | `COUNT(*) FROM sla_breaches WHERE status = 'OPEN'` |
