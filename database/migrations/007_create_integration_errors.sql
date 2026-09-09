-- Migration 007: Integration errors
-- Full error history per transaction. Multiple errors can exist per transaction.
-- is_current marks the latest unresolved error for dashboard "open incidents" queries.

CREATE TABLE integration_errors (
    id                  BIGSERIAL PRIMARY KEY,
    transaction_id      BIGINT       NOT NULL REFERENCES integration_transactions(id) ON DELETE CASCADE,
    endpoint_id         INT          REFERENCES integration_endpoints(id),
    error_category_id   INT          REFERENCES error_categories(id),
    error_code          VARCHAR(30),               -- denormalized from error_categories for query convenience
    error_group         error_group,               -- denormalized group for severity filtering
    error_message       TEXT         NOT NULL,      -- classified/short message
    raw_error           TEXT,                       -- full original error text from Team Central / NetSuite
    occurred_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    resolved_at         TIMESTAMPTZ,               -- NULL = still open
    retry_count         INT          NOT NULL DEFAULT 0,
    is_blocking         BOOLEAN      NOT NULL DEFAULT FALSE, -- drives severity (MAPPING/INDEXING)
    is_current          BOOLEAN      NOT NULL DEFAULT TRUE,  -- most recent unresolved error for this txn
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_errors_transaction        ON integration_errors(transaction_id);
CREATE INDEX idx_errors_category           ON integration_errors(error_category_id);
CREATE INDEX idx_errors_code               ON integration_errors(error_code);
CREATE INDEX idx_errors_group              ON integration_errors(error_group);
CREATE INDEX idx_errors_occurred           ON integration_errors(occurred_at);
CREATE INDEX idx_errors_is_current         ON integration_errors(is_current) WHERE is_current = TRUE;
CREATE INDEX idx_errors_open_blocking      ON integration_errors(is_blocking, resolved_at)
    WHERE is_blocking = TRUE AND resolved_at IS NULL;

-- Add the FK from transaction_events back to errors
ALTER TABLE integration_transaction_events
    ADD CONSTRAINT fk_txn_event_error
    FOREIGN KEY (error_id) REFERENCES integration_errors(id);
