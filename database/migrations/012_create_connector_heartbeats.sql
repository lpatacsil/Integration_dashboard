-- Migration 012: Connector heartbeats
-- Tracks the last-known heartbeat from the Team Central connector.
-- Required for Sev 4 detection: heartbeat > 30 min = tool down.

CREATE TABLE connector_heartbeats (
    id              BIGSERIAL PRIMARY KEY,
    endpoint_id     INT          REFERENCES integration_endpoints(id),
    system_code     VARCHAR(50)  NOT NULL,          -- 'TEAM_CENTRAL'
    heartbeat_at    TIMESTAMPTZ  NOT NULL,          -- when the heartbeat was received
    status          VARCHAR(50)  NOT NULL DEFAULT 'OK',  -- 'OK', 'DEGRADED', 'DOWN'
    metadata        JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_heartbeat_system   ON connector_heartbeats(system_code);
CREATE INDEX idx_heartbeat_time     ON connector_heartbeats(heartbeat_at);
CREATE INDEX idx_heartbeat_latest   ON connector_heartbeats(system_code, heartbeat_at DESC);
