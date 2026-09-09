-- Migration 005: Core integration transactions table
-- One row per integration transaction (order, fulfillment, draft order, etc.)

CREATE TABLE integration_transactions (
    id                      BIGSERIAL PRIMARY KEY,

    -- External identifiers
    external_id             VARCHAR(255),              -- Team Central transaction ID
    team_central_id         VARCHAR(255),              -- alternate TC identifier if different
    batch_id                VARCHAR(255),              -- batch/run this transaction belongs to

    -- Systems involved
    source_system_id        INT          NOT NULL REFERENCES systems(id),
    destination_system_id   INT          NOT NULL REFERENCES systems(id),
    endpoint_id             INT          REFERENCES integration_endpoints(id),

    -- Flow classification (matches prototype: S2N, N2S, IDX, NS)
    flow_code               VARCHAR(20)  NOT NULL,     -- 'S2N', 'N2S', 'IDX', 'NS'

    -- Transaction details
    transaction_type        VARCHAR(100) NOT NULL,     -- 'Order', 'Draft Order', 'Fulfillment', 'Sales Order'
    entity_type             VARCHAR(100),              -- 'Customer', 'Item', 'Ship-to', 'Location' (for indexing)
    entity_id               VARCHAR(255),              -- internal entity ID
    entity_identifier       VARCHAR(255),              -- human-readable ref (e.g. 'SH-58213', 'SO-41003')

    -- Cross-system references
    netsuite_record_type    VARCHAR(100),              -- e.g. 'salesorder', 'customer'
    netsuite_record_id      VARCHAR(255),              -- NetSuite internal ID
    sales_order_id          VARCHAR(255),              -- Sales Order number (primary search field)
    external_order_id       VARCHAR(255),              -- Shopify order ID or external ref

    -- Status
    original_status         VARCHAR(100),              -- raw status from Team Central
    normalized_status       normalized_status NOT NULL DEFAULT 'PENDING',

    -- Timestamps
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    processed_at            TIMESTAMPTZ,               -- when processing completed
    last_attempt_at         TIMESTAMPTZ,               -- timestamp of most recent attempt
    last_error_at           TIMESTAMPTZ,               -- timestamp of most recent error

    -- Processing metrics
    processing_duration_ms  INT,
    retry_count             INT          NOT NULL DEFAULT 0,
    rerun_count             INT          NOT NULL DEFAULT 0,
    is_rerun                BOOLEAN      NOT NULL DEFAULT FALSE,

    -- Payloads (JSONB for raw data; searchable fields are columns above)
    raw_payload             JSONB,
    raw_response            JSONB,

    -- Idempotency: prevent duplicate ingestion of the same TC event
    CONSTRAINT uq_transaction_external UNIQUE (external_id)
);

-- Dashboard query indexes
CREATE INDEX idx_txn_normalized_status     ON integration_transactions(normalized_status);
CREATE INDEX idx_txn_flow_code             ON integration_transactions(flow_code);
CREATE INDEX idx_txn_created_at            ON integration_transactions(created_at);
CREATE INDEX idx_txn_sales_order           ON integration_transactions(sales_order_id);
CREATE INDEX idx_txn_external_order        ON integration_transactions(external_order_id);
CREATE INDEX idx_txn_entity_identifier     ON integration_transactions(entity_identifier);
CREATE INDEX idx_txn_team_central_id       ON integration_transactions(team_central_id);
CREATE INDEX idx_txn_source_dest           ON integration_transactions(source_system_id, destination_system_id);
CREATE INDEX idx_txn_endpoint              ON integration_transactions(endpoint_id);
CREATE INDEX idx_txn_transaction_type      ON integration_transactions(transaction_type);

-- Composite indexes for common dashboard queries
CREATE INDEX idx_txn_status_created        ON integration_transactions(normalized_status, created_at);
CREATE INDEX idx_txn_flow_status_created   ON integration_transactions(flow_code, normalized_status, created_at);
CREATE INDEX idx_txn_flow_created          ON integration_transactions(flow_code, created_at);

-- Open incidents: errors without resolution
CREATE INDEX idx_txn_open_errors           ON integration_transactions(normalized_status, created_at)
    WHERE normalized_status IN ('FAILED', 'MANUAL_INTERVENTION');
