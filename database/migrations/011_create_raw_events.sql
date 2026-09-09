-- Migration 011: Raw Team Central events
-- Preserves the original API response before normalization.
-- Enables troubleshooting and reprocessing of failed ingestion.

CREATE TABLE team_central_raw_events (
    id                      BIGSERIAL PRIMARY KEY,
    team_central_event_id   VARCHAR(255) NOT NULL,     -- original TC event identifier
    event_type              VARCHAR(100),              -- e.g. 'transaction', 'index', 'heartbeat'
    endpoint_id             INT          REFERENCES integration_endpoints(id),
    external_entity_id      VARCHAR(255),              -- entity ID from TC
    entity_identifier       VARCHAR(255),              -- human-readable ref
    entity_type             VARCHAR(100),              -- 'Order', 'Customer', 'Item', etc.
    transaction_type        VARCHAR(100),
    has_errors              BOOLEAN      NOT NULL DEFAULT FALSE,
    raw_payload             JSONB        NOT NULL,     -- full original response
    processing_status       ingestion_status NOT NULL DEFAULT 'RECEIVED',
    processed_at            TIMESTAMPTZ,
    processing_error        TEXT,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Idempotency: same TC event received multiple times is stored once
    CONSTRAINT uq_tc_event UNIQUE (team_central_event_id)
);

CREATE INDEX idx_raw_event_tc_id       ON team_central_raw_events(team_central_event_id);
CREATE INDEX idx_raw_event_status      ON team_central_raw_events(processing_status);
CREATE INDEX idx_raw_event_created     ON team_central_raw_events(created_at);
CREATE INDEX idx_raw_event_type        ON team_central_raw_events(event_type);
CREATE INDEX idx_raw_event_endpoint    ON team_central_raw_events(endpoint_id);
CREATE INDEX idx_raw_event_unprocessed ON team_central_raw_events(processing_status, created_at)
    WHERE processing_status IN ('RECEIVED', 'FAILED');
