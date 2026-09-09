-- Migration 013: Severity snapshots
-- Records severity evaluations over time.
-- The dashboard computes severity in real time, but snapshots provide historical audit trail
-- and are needed for the "Alerts & escalations" tab to show what was sent and when.

CREATE TABLE severity_snapshots (
    id                  BIGSERIAL PRIMARY KEY,
    evaluated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    overall_severity    severity_level NOT NULL,
    flow_severities     JSONB          NOT NULL DEFAULT '{}',  -- {"S2N":"SEV_0","N2S":"SEV_1",...}
    open_blocking_count INT            NOT NULL DEFAULT 0,
    heartbeat_age_min   INT,
    tx_last_60          INT,
    baseline_last_60    INT,
    details             JSONB,                  -- full evaluation context for audit
    created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_severity_evaluated ON severity_snapshots(evaluated_at);
CREATE INDEX idx_severity_level     ON severity_snapshots(overall_severity);
