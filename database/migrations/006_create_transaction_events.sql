-- Migration 006: Transaction event history
-- Each status change or processing attempt is recorded here.
-- Keeps the main transaction table lean; enables timeline display in the UI.

CREATE TABLE integration_transaction_events (
    id                  BIGSERIAL PRIMARY KEY,
    transaction_id      BIGINT       NOT NULL REFERENCES integration_transactions(id) ON DELETE CASCADE,
    event_type          VARCHAR(50)  NOT NULL,     -- 'STATUS_CHANGE', 'RETRY', 'RERUN', 'ERROR', 'RESOLVED', 'CREATED'
    previous_status     normalized_status,
    new_status          normalized_status,
    event_timestamp     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    error_id            BIGINT,                    -- FK added after integration_errors is created
    retry_number        INT,
    message             TEXT,
    metadata            JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_txn_events_transaction    ON integration_transaction_events(transaction_id);
CREATE INDEX idx_txn_events_timestamp      ON integration_transaction_events(event_timestamp);
CREATE INDEX idx_txn_events_type           ON integration_transaction_events(event_type);
CREATE INDEX idx_txn_events_txn_timestamp  ON integration_transaction_events(transaction_id, event_timestamp);
