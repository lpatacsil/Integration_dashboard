-- Migration 015: Alert incidents (de-duplication state table)
-- One row per open incident keyed on flow + category + entityRef.
-- Tracks current level, when last notified, and resolution.

CREATE TABLE alert_incidents (
    id                  BIGSERIAL PRIMARY KEY,
    incident_key        VARCHAR(500) NOT NULL UNIQUE,  -- flow + category + entityRef
    flow_code           VARCHAR(20)  NOT NULL,
    error_code          VARCHAR(50),
    entity_identifier   VARCHAR(255),
    severity_level      INT          NOT NULL DEFAULT 1,
    title               TEXT         NOT NULL,
    detail              TEXT,
    notify              TEXT[]       NOT NULL DEFAULT '{}',
    cc                  TEXT[]       NOT NULL DEFAULT '{}',
    renotify_minutes    INT          NOT NULL DEFAULT 240,
    transaction_ids     TEXT[]       NOT NULL DEFAULT '{}',

    -- State tracking
    status              VARCHAR(20)  NOT NULL DEFAULT 'OPEN',  -- OPEN, RESOLVED, ACKNOWLEDGED
    opened_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_notified_at    TIMESTAMPTZ,
    last_level_change   TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    notification_count  INT          NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_incident_key    ON alert_incidents(incident_key);
CREATE INDEX idx_alert_incident_status ON alert_incidents(status);
CREATE INDEX idx_alert_incident_open   ON alert_incidents(status, opened_at) WHERE status = 'OPEN';
CREATE INDEX idx_alert_incident_flow   ON alert_incidents(flow_code, status);

-- Alert notification log: every notification that would be / was sent
CREATE TABLE alert_notifications (
    id                  BIGSERIAL PRIMARY KEY,
    incident_id         BIGINT       NOT NULL REFERENCES alert_incidents(id),
    notification_type   VARCHAR(50)  NOT NULL,  -- OPENED, LEVEL_CHANGE, RENOTIFY, RESOLVED
    severity_level      INT          NOT NULL,
    recipients          TEXT[]       NOT NULL DEFAULT '{}',
    cc                  TEXT[]       NOT NULL DEFAULT '{}',
    subject             TEXT         NOT NULL,
    body                TEXT         NOT NULL,
    sent                BOOLEAN      NOT NULL DEFAULT FALSE,  -- FALSE until email transport is enabled
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_notif_incident ON alert_notifications(incident_id);
CREATE INDEX idx_alert_notif_type     ON alert_notifications(notification_type);
CREATE INDEX idx_alert_notif_unsent   ON alert_notifications(sent) WHERE sent = FALSE;
