-- Migration 014: Dashboard views
-- Materialized or regular views for common dashboard queries.
-- These calculate metrics dynamically from normalized data.

-- Overview: transaction counts by status for a given date range
-- (used as a query pattern; actual API will add WHERE for date range)
CREATE VIEW v_transaction_summary AS
SELECT
    flow_code,
    normalized_status,
    COUNT(*)                                          AS transaction_count,
    DATE(created_at AT TIME ZONE 'UTC')               AS transaction_date
FROM integration_transactions
GROUP BY flow_code, normalized_status, DATE(created_at AT TIME ZONE 'UTC');

-- Overview: success rate per flow
CREATE VIEW v_flow_health AS
SELECT
    flow_code,
    COUNT(*)                                                              AS total,
    COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')                 AS succeeded,
    COUNT(*) FILTER (WHERE normalized_status = 'FAILED')                  AS failed,
    COUNT(*) FILTER (WHERE normalized_status = 'PENDING')                 AS pending,
    COUNT(*) FILTER (WHERE normalized_status = 'PROCESSING')              AS processing,
    COUNT(*) FILTER (WHERE normalized_status = 'RETRY')                   AS retry,
    COUNT(*) FILTER (WHERE normalized_status = 'MANUAL_INTERVENTION')     AS manual_intervention,
    COUNT(*) FILTER (WHERE normalized_status = 'CANCELLED')               AS cancelled,
    COUNT(*) FILTER (WHERE is_rerun = TRUE)                               AS rerun_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS') / NULLIF(COUNT(*), 0),
        1
    )                                                                     AS success_rate
FROM integration_transactions
GROUP BY flow_code;

-- Open blocking errors driving the severity ladder
CREATE VIEW v_open_blocking_errors AS
SELECT
    e.id AS error_id,
    e.transaction_id,
    t.flow_code,
    t.entity_identifier,
    t.sales_order_id,
    t.transaction_type,
    e.error_code,
    e.error_group,
    e.error_message,
    e.occurred_at,
    e.is_blocking,
    ec.label AS category_label
FROM integration_errors e
JOIN integration_transactions t ON t.id = e.transaction_id
LEFT JOIN error_categories ec ON ec.id = e.error_category_id
WHERE e.is_blocking = TRUE
  AND e.resolved_at IS NULL
  AND e.is_current = TRUE;

-- Open incidents: all unresolved errors (blocking and non-blocking)
CREATE VIEW v_open_incidents AS
SELECT
    e.id AS error_id,
    e.transaction_id,
    t.flow_code,
    t.entity_identifier,
    t.sales_order_id,
    t.transaction_type,
    e.error_code,
    e.error_group,
    e.error_message,
    e.raw_error,
    e.occurred_at,
    e.is_blocking,
    e.retry_count,
    ec.label AS category_label,
    EXTRACT(EPOCH FROM (NOW() - e.occurred_at)) / 60 AS age_minutes
FROM integration_errors e
JOIN integration_transactions t ON t.id = e.transaction_id
LEFT JOIN error_categories ec ON ec.id = e.error_category_id
WHERE e.resolved_at IS NULL
  AND e.is_current = TRUE
ORDER BY e.occurred_at DESC;

-- Error category breakdown for the "Errors by category" chart
CREATE VIEW v_error_category_summary AS
SELECT
    e.error_code,
    ec.label AS category_label,
    ec.error_group,
    ec.is_blocking,
    COUNT(*) AS error_count,
    DATE(e.occurred_at AT TIME ZONE 'UTC') AS error_date
FROM integration_errors e
LEFT JOIN error_categories ec ON ec.id = e.error_category_id
GROUP BY e.error_code, ec.label, ec.error_group, ec.is_blocking,
         DATE(e.occurred_at AT TIME ZONE 'UTC');

-- Daily trend: transaction counts by day and outcome (for the stacked bar chart)
CREATE VIEW v_daily_trend AS
SELECT
    DATE(created_at AT TIME ZONE 'UTC') AS day,
    flow_code,
    COUNT(*) FILTER (WHERE normalized_status = 'SUCCESS')                                    AS succeeded,
    COUNT(*) FILTER (WHERE normalized_status = 'FAILED')                                     AS errored,
    COUNT(*) FILTER (WHERE normalized_status IN ('PENDING', 'RETRY', 'PROCESSING'))          AS pending_rerun,
    COUNT(*)                                                                                  AS total
FROM integration_transactions
GROUP BY DATE(created_at AT TIME ZONE 'UTC'), flow_code
ORDER BY day;

-- Indexing summary
CREATE VIEW v_indexing_summary AS
SELECT
    index_type,
    status,
    COUNT(*)                              AS record_count,
    DATE(created_at AT TIME ZONE 'UTC')   AS activity_date
FROM indexing_activity
GROUP BY index_type, status, DATE(created_at AT TIME ZONE 'UTC');

-- Rerun summary
CREATE VIEW v_rerun_summary AS
SELECT
    r.sales_order_id,
    COUNT(*)                                                   AS total_reruns,
    COUNT(*) FILTER (WHERE r.status = 'SUCCESS')               AS succeeded,
    COUNT(*) FILTER (WHERE r.status = 'FAILED')                AS failed,
    MIN(r.started_at)                                          AS first_rerun,
    MAX(r.started_at)                                          AS last_rerun
FROM integration_reruns r
GROUP BY r.sales_order_id;
