-- Migration 008: Integration reruns
-- Tracks SO re-run attempts. A rerun is always linked to the original transaction.

CREATE TABLE integration_reruns (
    id                  BIGSERIAL PRIMARY KEY,
    transaction_id      BIGINT       NOT NULL REFERENCES integration_transactions(id) ON DELETE CASCADE,
    sales_order_id      VARCHAR(255),              -- denormalized for direct lookup
    external_rerun_id   VARCHAR(255),              -- Team Central rerun identifier
    started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ,
    status              normalized_status NOT NULL DEFAULT 'PROCESSING',
    retry_count         INT          NOT NULL DEFAULT 0,
    triggered_by        VARCHAR(150),              -- 'AUTO', 'MANUAL', user name
    result              VARCHAR(100),              -- 'SUCCESS', 'FAILED', etc.
    error_message       TEXT,
    raw_response        JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_rerun_external UNIQUE (external_rerun_id)
);

CREATE INDEX idx_reruns_transaction ON integration_reruns(transaction_id);
CREATE INDEX idx_reruns_sales_order ON integration_reruns(sales_order_id);
CREATE INDEX idx_reruns_status      ON integration_reruns(status);
CREATE INDEX idx_reruns_started     ON integration_reruns(started_at);
