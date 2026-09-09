-- Migration 003: Integration endpoints
-- Represents a configured connector/endpoint in Team Central.

CREATE TABLE integration_endpoints (
    id                   SERIAL PRIMARY KEY,
    system_id            INT          NOT NULL REFERENCES systems(id),
    endpoint_external_id VARCHAR(255),                               -- ID from Team Central
    endpoint_name        VARCHAR(255) NOT NULL,                      -- human-readable name
    endpoint_type        VARCHAR(100),                               -- e.g. 'ORDER_SYNC', 'FULFILLMENT', 'INDEX'
    direction            flow_direction NOT NULL DEFAULT 'INBOUND',
    active               BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_endpoint_external UNIQUE (system_id, endpoint_external_id)
);

CREATE INDEX idx_endpoints_system ON integration_endpoints(system_id);
CREATE INDEX idx_endpoints_direction ON integration_endpoints(direction);
