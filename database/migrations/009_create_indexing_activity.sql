-- Migration 009: Indexing activity
-- Separate from integration_transactions because indexing is a different business process
-- (cross-reference maintenance between Shopify and NetSuite objects).
-- A failed index today causes a MAP-* error on an order tomorrow.

CREATE TABLE indexing_activity (
    id                  BIGSERIAL PRIMARY KEY,
    external_id         VARCHAR(255),              -- Team Central index record ID
    index_type          VARCHAR(100) NOT NULL,     -- 'Customer', 'Item', 'Ship-to', 'Location'
    record_id           VARCHAR(255),              -- internal record identifier
    sales_order_id      VARCHAR(255),              -- related SO if applicable
    data_model          VARCHAR(100),              -- data model name in TC
    value               TEXT,                      -- the value being indexed (e.g. customer name, SKU)
    system_source       VARCHAR(100),              -- originating system code
    source_id           VARCHAR(255),              -- ID in the source system
    status              normalized_status NOT NULL DEFAULT 'PENDING',
    error               TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    duration_ms         INT,
    raw_payload         JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_indexing_external UNIQUE (external_id)
);

CREATE INDEX idx_indexing_type          ON indexing_activity(index_type);
CREATE INDEX idx_indexing_status        ON indexing_activity(status);
CREATE INDEX idx_indexing_created       ON indexing_activity(created_at);
CREATE INDEX idx_indexing_sales_order   ON indexing_activity(sales_order_id);
CREATE INDEX idx_indexing_status_created ON indexing_activity(status, created_at);
