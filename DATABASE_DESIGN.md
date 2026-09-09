# Integration Monitor — Database Design

## 1. Architecture

```
Team Central API
       │
       ▼
┌──────────────────┐
│  Raw Event Store │  team_central_raw_events (JSONB + metadata)
└────────┬─────────┘
         │  Ingestion / Normalization (future phase)
         ▼
┌──────────────────────────────────────────────────────────┐
│                 Normalized Tables                        │
│                                                          │
│  systems ──► integration_endpoints                       │
│                     │                                    │
│                     ▼                                    │
│            integration_transactions                      │
│              ├── integration_transaction_events           │
│              ├── integration_errors                       │
│              ├── integration_reruns                       │
│              └── sla_breaches ◄── sla_rules              │
│                                                          │
│  indexing_activity  (independent process)                 │
│  connector_heartbeats  (Sev 4 detection)                 │
│  severity_snapshots  (audit trail)                        │
│  error_categories  (reference data)                       │
└──────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│   Dashboard API  │  REST endpoints → React UI
└──────────────────┘
```

**Database:** PostgreSQL 16
**Development:** Docker Desktop
**Production target:** Azure Database for PostgreSQL

---

## 2. Entity-Relationship Diagram

```
┌─────────────┐       ┌────────────────────────┐
│   systems    │───┐   │  error_categories       │
│              │   │   │                          │
│  id (PK)     │   │   │  id (PK)                │
│  code (UQ)   │   │   │  code (UQ)              │
│  name        │   │   │  label                   │
│  description │   │   │  error_group             │
│  active      │   │   │  match_pattern           │
└──────┬───────┘   │   │  is_blocking             │
       │           │   └────────────┬─────────────┘
       │           │                │
       ▼           │                │
┌──────────────────────┐            │
│integration_endpoints │            │
│                      │            │
│  id (PK)             │            │
│  system_id (FK)──────┘            │
│  endpoint_external_id│            │
│  endpoint_name       │            │
│  endpoint_type       │            │
│  direction           │            │
└──────────┬───────────┘            │
           │                        │
           ▼                        │
┌──────────────────────────────┐    │
│  integration_transactions     │    │
│                               │    │
│  id (PK)                      │    │
│  external_id (UQ)             │    │
│  source_system_id (FK)────────┤    │
│  destination_system_id (FK)───┤    │
│  endpoint_id (FK)─────────────┘    │
│  flow_code                    │    │
│  transaction_type             │    │
│  entity_identifier            │    │
│  sales_order_id               │    │
│  normalized_status            │    │
│  ...                          │    │
└──┬───────┬───────┬────────────┘    │
   │       │       │                 │
   │       │       │    ┌────────────┘
   │       │       │    │
   ▼       │       ▼    ▼
┌────────┐ │  ┌──────────────────┐
│ events │ │  │integration_errors│
│        │ │  │                  │
│ id(PK) │ │  │ id (PK)          │
│ txn(FK)│ │  │ txn_id (FK)──────┤
│ type   │ │  │ error_cat_id(FK)─┘
│ prev   │ │  │ error_code       │
│ new    │ │  │ error_group      │
│ error  │ │  │ is_blocking      │
│ (FK)───┼─┤  │ resolved_at      │
└────────┘ │  └──────────────────┘
           │
           ▼
   ┌─────────────────────┐
   │ integration_reruns   │
   │                      │
   │ id (PK)              │
   │ transaction_id (FK)  │
   │ sales_order_id       │
   │ external_rerun_id(UQ)│
   │ status               │
   └──────────────────────┘

┌───────────────────┐    ┌───────────────────────────┐
│  sla_rules        │    │  indexing_activity         │
│                   │    │                             │
│  id (PK)          │    │  id (PK)                    │
│  name             │    │  external_id (UQ)           │
│  process          │    │  index_type                 │
│  threshold        │    │  record_id                  │
│  sla_minutes      │    │  status                     │
│  severity         │    │  started_at / completed_at  │
└────────┬──────────┘    └─────────────────────────────┘
         │
         ▼
┌───────────────────┐    ┌───────────────────────────┐
│  sla_breaches     │    │  connector_heartbeats      │
│                   │    │                             │
│  id (PK)          │    │  id (PK)                    │
│  sla_rule_id (FK) │    │  endpoint_id (FK)           │
│  transaction_id   │    │  system_code                │
│  (FK)             │    │  heartbeat_at               │
│  severity         │    │  status                     │
│  status           │    └─────────────────────────────┘
└───────────────────┘
                         ┌───────────────────────────┐
                         │team_central_raw_events     │
                         │                             │
                         │  id (PK)                    │
                         │  tc_event_id (UQ)           │
                         │  raw_payload (JSONB)        │
                         │  processing_status          │
                         └─────────────────────────────┘

┌───────────────────┐
│severity_snapshots │
│                   │
│  id (PK)          │
│  overall_severity │
│  flow_severities  │
│  (JSONB)          │
└───────────────────┘
```

---

## 3. Tables

### 3.1 `systems`
Reference table for source/destination systems.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | SERIAL | PK | |
| code | VARCHAR(50) | UNIQUE, NOT NULL | Lookup key: NETSUITE, SHOPIFY, TEAM_CENTRAL |
| name | VARCHAR(150) | NOT NULL | Display name |
| description | TEXT | | |
| active | BOOLEAN | DEFAULT TRUE | Soft-delete |
| created_at | TIMESTAMPTZ | DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ | DEFAULT NOW() | Auto-updated by trigger |

### 3.2 `integration_endpoints`
Configured connectors/endpoints in Team Central.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | SERIAL | PK | |
| system_id | INT | FK → systems(id), NOT NULL | Which system this endpoint belongs to |
| endpoint_external_id | VARCHAR(255) | UNIQUE with system_id | Team Central endpoint ID |
| endpoint_name | VARCHAR(255) | NOT NULL | Human-readable name |
| endpoint_type | VARCHAR(100) | | e.g. ORDER_SYNC, FULFILLMENT, INDEX |
| direction | flow_direction | NOT NULL, DEFAULT INBOUND | INBOUND, OUTBOUND, BIDIRECTIONAL |
| active | BOOLEAN | DEFAULT TRUE | |
| created_at / updated_at | TIMESTAMPTZ | | |

### 3.3 `error_categories`
The 12 error classification codes from the spec.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | SERIAL | PK | |
| code | VARCHAR(30) | UNIQUE, NOT NULL | MAP-CUST, MAP-ITEM, etc. |
| label | VARCHAR(255) | NOT NULL | Human-readable description |
| error_group | error_group enum | NOT NULL | MAPPING, INDEXING, NETSUITE, TRANSIENT, OUTAGE |
| match_pattern | TEXT | NOT NULL | Regex for classification |
| is_blocking | BOOLEAN | DEFAULT FALSE | TRUE for MAPPING and INDEXING groups |
| display_order | INT | DEFAULT 0 | UI sort order |

### 3.4 `integration_transactions`
Core table — one row per integration transaction.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| external_id | VARCHAR(255) | UNIQUE | Team Central transaction ID (idempotency) |
| team_central_id | VARCHAR(255) | | Alternate TC identifier |
| batch_id | VARCHAR(255) | | Batch/run grouping |
| source_system_id | INT | FK → systems(id), NOT NULL | |
| destination_system_id | INT | FK → systems(id), NOT NULL | |
| endpoint_id | INT | FK → integration_endpoints(id) | |
| flow_code | VARCHAR(20) | NOT NULL | S2N, N2S, IDX, NS |
| transaction_type | VARCHAR(100) | NOT NULL | Order, Draft Order, Fulfillment, Sales Order |
| entity_type | VARCHAR(100) | | Customer, Item, Ship-to, Location (indexing) |
| entity_id | VARCHAR(255) | | Internal entity ID |
| entity_identifier | VARCHAR(255) | | Human-readable ref (SH-58213, SO-41003) |
| netsuite_record_type | VARCHAR(100) | | salesorder, customer, etc. |
| netsuite_record_id | VARCHAR(255) | | NetSuite internal ID |
| sales_order_id | VARCHAR(255) | | Primary search field |
| external_order_id | VARCHAR(255) | | Shopify order ID |
| original_status | VARCHAR(100) | | Raw status from Team Central |
| normalized_status | normalized_status | NOT NULL, DEFAULT PENDING | Dashboard status |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Auto-updated |
| processed_at | TIMESTAMPTZ | | When processing completed |
| last_attempt_at | TIMESTAMPTZ | | Most recent attempt |
| last_error_at | TIMESTAMPTZ | | Most recent error |
| processing_duration_ms | INT | | |
| retry_count | INT | DEFAULT 0 | |
| rerun_count | INT | DEFAULT 0 | |
| is_rerun | BOOLEAN | DEFAULT FALSE | Whether this is a rerun transaction |
| raw_payload | JSONB | | Original TC payload |
| raw_response | JSONB | | Response from target system |

### 3.5 `integration_transaction_events`
Status change and processing event history per transaction.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| transaction_id | BIGINT | FK → integration_transactions(id) CASCADE | |
| event_type | VARCHAR(50) | NOT NULL | STATUS_CHANGE, RETRY, RERUN, ERROR, RESOLVED, CREATED |
| previous_status | normalized_status | | |
| new_status | normalized_status | | |
| event_timestamp | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | |
| error_id | BIGINT | FK → integration_errors(id) | |
| retry_number | INT | | |
| message | TEXT | | |
| metadata | JSONB | | |

### 3.6 `integration_errors`
Full error history. Multiple errors can exist per transaction.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| transaction_id | BIGINT | FK → integration_transactions(id) CASCADE | |
| endpoint_id | INT | FK → integration_endpoints(id) | |
| error_category_id | INT | FK → error_categories(id) | |
| error_code | VARCHAR(30) | | Denormalized for query speed |
| error_group | error_group | | Denormalized group |
| error_message | TEXT | NOT NULL | Classified message |
| raw_error | TEXT | | Full original error text |
| occurred_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | |
| resolved_at | TIMESTAMPTZ | | NULL = still open |
| retry_count | INT | DEFAULT 0 | |
| is_blocking | BOOLEAN | DEFAULT FALSE | Drives severity ladder |
| is_current | BOOLEAN | DEFAULT TRUE | Latest unresolved error for this txn |

### 3.7 `integration_reruns`
SO re-run attempts, linked to original transaction.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| transaction_id | BIGINT | FK → integration_transactions(id) CASCADE | |
| sales_order_id | VARCHAR(255) | | Denormalized for direct lookup |
| external_rerun_id | VARCHAR(255) | UNIQUE | TC rerun identifier |
| started_at | TIMESTAMPTZ | DEFAULT NOW() | |
| completed_at | TIMESTAMPTZ | | |
| status | normalized_status | DEFAULT PROCESSING | |
| retry_count | INT | DEFAULT 0 | |
| triggered_by | VARCHAR(150) | | AUTO, MANUAL, user name |
| result | VARCHAR(100) | | |
| error_message | TEXT | | |
| raw_response | JSONB | | |

### 3.8 `indexing_activity`
Cross-reference index maintenance (Customer, Item, Ship-to, Location).

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| external_id | VARCHAR(255) | UNIQUE | TC index record ID |
| index_type | VARCHAR(100) | NOT NULL | Customer, Item, Ship-to, Location |
| record_id | VARCHAR(255) | | Internal record identifier |
| sales_order_id | VARCHAR(255) | | Related SO if applicable |
| data_model | VARCHAR(100) | | TC data model name |
| value | TEXT | | The value being indexed (customer name, SKU) |
| system_source | VARCHAR(100) | | Originating system code |
| source_id | VARCHAR(255) | | ID in source system |
| status | normalized_status | DEFAULT PENDING | |
| error | TEXT | | |
| started_at / completed_at | TIMESTAMPTZ | | |
| duration_ms | INT | | |
| raw_payload | JSONB | | |

### 3.9 `sla_rules`
Threshold and SLA configuration read by the dashboard.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | SERIAL | PK | |
| name | VARCHAR(255) | NOT NULL | Rule display name |
| process | VARCHAR(100) | NOT NULL | S2N, N2S, IDX, NS, ALL |
| category | VARCHAR(100) | | Error category code, or NULL for all |
| direction | flow_direction | | |
| threshold | NUMERIC(12,2) | NOT NULL | Numeric threshold |
| sla_minutes | INT | | Time-based SLA in minutes |
| severity | severity_level | DEFAULT SEV_1 | |
| enabled | BOOLEAN | DEFAULT TRUE | |
| description | TEXT | | |

### 3.10 `sla_breaches`
Records when a transaction violates an SLA rule.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| sla_rule_id | INT | FK → sla_rules(id) | |
| transaction_id | BIGINT | FK → integration_transactions(id) | |
| triggered_at | TIMESTAMPTZ | DEFAULT NOW() | |
| actual_value | NUMERIC(12,2) | | |
| threshold_value | NUMERIC(12,2) | | |
| severity | severity_level | NOT NULL | |
| status | VARCHAR(50) | DEFAULT 'OPEN' | OPEN, RESOLVED, ACKNOWLEDGED |
| resolved_at | TIMESTAMPTZ | | |

### 3.11 `team_central_raw_events`
Raw API responses preserved before normalization.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| team_central_event_id | VARCHAR(255) | UNIQUE, NOT NULL | Idempotency key |
| event_type | VARCHAR(100) | | transaction, index, heartbeat |
| endpoint_id | INT | FK → integration_endpoints(id) | |
| external_entity_id | VARCHAR(255) | | |
| entity_identifier | VARCHAR(255) | | |
| entity_type | VARCHAR(100) | | |
| transaction_type | VARCHAR(100) | | |
| has_errors | BOOLEAN | DEFAULT FALSE | |
| raw_payload | JSONB | NOT NULL | Full original response |
| processing_status | ingestion_status | DEFAULT RECEIVED | |
| processed_at | TIMESTAMPTZ | | |
| processing_error | TEXT | | |

### 3.12 `connector_heartbeats`
Heartbeat tracking for Sev 4 detection.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| endpoint_id | INT | FK → integration_endpoints(id) | |
| system_code | VARCHAR(50) | NOT NULL | |
| heartbeat_at | TIMESTAMPTZ | NOT NULL | |
| status | VARCHAR(50) | DEFAULT 'OK' | OK, DEGRADED, DOWN |
| metadata | JSONB | | |

### 3.13 `severity_snapshots`
Historical severity evaluations for audit and the Alerts tab.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | BIGSERIAL | PK | |
| evaluated_at | TIMESTAMPTZ | DEFAULT NOW() | |
| overall_severity | severity_level | NOT NULL | |
| flow_severities | JSONB | DEFAULT '{}' | Per-flow severity map |
| open_blocking_count | INT | DEFAULT 0 | |
| heartbeat_age_min | INT | | |
| tx_last_60 | INT | | Transactions in last 60 min |
| baseline_last_60 | INT | | 4-week baseline |
| details | JSONB | | Full evaluation context |

---

## 4. Enum Types

| Enum | Values | Purpose |
|------|--------|---------|
| normalized_status | SUCCESS, FAILED, PENDING, PROCESSING, RETRY, MANUAL_INTERVENTION, CANCELLED | Dashboard status model |
| flow_direction | INBOUND, OUTBOUND, BIDIRECTIONAL | Endpoint direction |
| error_group | MAPPING, INDEXING, NETSUITE, TRANSIENT, OUTAGE | Error classification groups |
| severity_level | SEV_0 through SEV_4 | Severity ladder |
| ingestion_status | RECEIVED, PROCESSING, PROCESSED, FAILED, SKIPPED | Raw event processing |

---

## 5. Status Model

Original Team Central status is stored in `original_status` (VARCHAR).
The dashboard uses `normalized_status` (enum) for all filtering and display.

```
PENDING ──► PROCESSING ──► SUCCESS
                │
                ├──► FAILED ──► RETRY ──► PROCESSING (loop)
                │                  │
                │                  └──► MANUAL_INTERVENTION
                │
                └──► CANCELLED
```

---

## 6. Unique Constraints (Idempotency)

| Table | Constraint | Columns |
|-------|-----------|---------|
| integration_transactions | uq_transaction_external | external_id |
| team_central_raw_events | uq_tc_event | team_central_event_id |
| integration_endpoints | uq_endpoint_external | system_id + endpoint_external_id |
| integration_reruns | uq_rerun_external | external_rerun_id |
| indexing_activity | uq_indexing_external | external_id |

---

## 7. Index Strategy

### Primary query patterns and their indexes

| Dashboard Query | Index |
|----------------|-------|
| Filter by status | idx_txn_normalized_status |
| Filter by date range | idx_txn_created_at |
| Filter by status + date | idx_txn_status_created (composite) |
| Filter by flow + status + date | idx_txn_flow_status_created (composite) |
| Filter by flow + date | idx_txn_flow_created (composite) |
| Search by Sales Order | idx_txn_sales_order |
| Search by external ID | idx_txn_external_order |
| Search by entity ref | idx_txn_entity_identifier |
| Open blocking errors | idx_errors_open_blocking (partial: blocking=TRUE, resolved IS NULL) |
| Open incidents | idx_errors_is_current (partial: is_current=TRUE) |
| Error by category | idx_errors_code, idx_errors_category |
| Unprocessed raw events | idx_raw_event_unprocessed (partial) |
| Latest heartbeat | idx_heartbeat_latest (DESC) |
| Open SLA breaches | idx_breach_open (partial: status='OPEN') |

**Total indexes: 72** (including PKs and unique constraints)

---

## 8. Raw Data Strategy

```
Team Central API Response
       │
       ▼
team_central_raw_events  ← raw_payload (JSONB), idempotent on tc_event_id
       │
       │  Ingestion process (future phase):
       │  1. Parse raw_payload
       │  2. Classify errors via error_categories regex
       │  3. Normalize status
       │  4. Insert into integration_transactions / errors / reruns / indexing
       │  5. Update processing_status to PROCESSED
       │
       ▼
Normalized tables (integration_transactions, etc.)
```

Preserving raw events enables:
- Troubleshooting normalization issues
- Reprocessing failed ingestion
- Auditing original data vs normalized

---

## 9. JSONB Usage

| Table | Column | Contains | Why JSONB |
|-------|--------|----------|-----------|
| integration_transactions | raw_payload | Original TC request | Variable structure per flow |
| integration_transactions | raw_response | Target system response | Variable structure |
| integration_reruns | raw_response | Rerun result payload | Variable structure |
| indexing_activity | raw_payload | TC indexing payload | Variable structure |
| team_central_raw_events | raw_payload | Full TC API response | Must preserve exactly |
| connector_heartbeats | metadata | Extra heartbeat info | Variable |
| severity_snapshots | flow_severities | Per-flow severity map | Small fixed structure |
| severity_snapshots | details | Full evaluation context | Audit/debug |
| transaction_events | metadata | Event-specific data | Variable per event type |

All searchable/filterable fields (sales_order_id, status, error_code, etc.) are normal relational columns with indexes.

---

## 10. Views

| View | Purpose | Used by |
|------|---------|---------|
| v_transaction_summary | Counts by flow + status + day | Overview tab |
| v_flow_health | Per-flow totals and success rate | Flow cards |
| v_open_blocking_errors | Unresolved blocking errors | Severity engine |
| v_open_incidents | All unresolved errors with age | Incident table |
| v_error_category_summary | Error counts by category + day | Error breakdown chart |
| v_daily_trend | Daily succeeded/errored/pending by flow | Stacked bar chart |
| v_indexing_summary | Index counts by type + status + day | Indexing tab |
| v_rerun_summary | Rerun totals per sales order | Reruns panel |

---

## 11. API Requirements

Based on the dashboard UI, the following API endpoints are needed:

| Endpoint | Purpose | Primary table(s) |
|----------|---------|-------------------|
| GET /api/integration-monitor/overview | Health strip + severity + KPI summary | v_flow_health, v_open_blocking_errors, connector_heartbeats |
| GET /api/integration-monitor/transactions | Paginated, filtered transaction list | integration_transactions |
| GET /api/integration-monitor/transactions/:id | Transaction detail + timeline | integration_transactions, integration_transaction_events |
| GET /api/integration-monitor/errors | Error list with category breakdown | integration_errors, error_categories |
| GET /api/integration-monitor/reruns | Rerun list | integration_reruns |
| GET /api/integration-monitor/indexing | Indexing activity | indexing_activity |
| GET /api/integration-monitor/sla | SLA rules + active breaches | sla_rules, sla_breaches |
| GET /api/integration-monitor/trends | Daily trend data | v_daily_trend |
| GET /api/integration-monitor/severity | Current severity + snapshots | severity_snapshots, v_open_blocking_errors |

### Filter parameters (all list endpoints)

| Parameter | Type | Maps to |
|-----------|------|---------|
| startDate | ISO date | created_at >= |
| endDate | ISO date | created_at <= |
| status | string | normalized_status |
| direction | string | flow_code or direction |
| transactionType | string | transaction_type |
| salesOrder | string | sales_order_id |
| externalId | string | external_id |
| sourceSystem | string | source_system_id |
| destinationSystem | string | destination_system_id |
| endpoint | string | endpoint_id |
| errorCode | string | error_code |
| errorCategory | string | error_category_id |
| page | int | OFFSET calculation |
| pageSize | int | LIMIT |
| sort | string | ORDER BY column |
| sortDirection | string | ASC / DESC |

### Pagination response

```json
{
  "data": [...],
  "page": 1,
  "pageSize": 25,
  "totalRecords": 1482,
  "totalPages": 60
}
```

---

## 12. Azure PostgreSQL Migration Strategy

### Version
PostgreSQL 16 (supported by Azure Database for PostgreSQL Flexible Server).

### Required extensions
None. The schema uses only standard PostgreSQL features.

### Migration process
1. Create Azure Database for PostgreSQL Flexible Server (General Purpose tier).
2. Set environment variables (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD).
3. Enable SSL: set `sslmode=require` in connection string.
4. Run migration files in order (001 through 015).
5. Verify with acceptance tests.

### Connection configuration
```
jdbc:postgresql://<server>.postgres.database.azure.com:5432/integration_monitor?sslmode=require
```

### Backup
Azure provides automated backups with configurable retention (7–35 days). No schema changes needed.

### Compatibility notes
- No PostgreSQL-specific extensions used (no PostGIS, pg_trgm, etc.).
- All enum types are standard `CREATE TYPE ... AS ENUM`.
- All triggers use `plpgsql`, which is available on Azure.
- No tablespaces or custom storage parameters.
- JSONB is fully supported on Azure PostgreSQL.
