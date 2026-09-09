-- Migration 010: SLA rules and breaches
-- Rules define thresholds; breaches record when a transaction violates them.

CREATE TABLE sla_rules (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    process         VARCHAR(100) NOT NULL,          -- 'S2N', 'N2S', 'IDX', 'NS', 'ALL'
    category        VARCHAR(100),                   -- error category code, or NULL for all
    direction       flow_direction,
    threshold       NUMERIC(12,2) NOT NULL,         -- numeric threshold value
    sla_minutes     INT,                            -- time-based SLA in minutes
    severity        severity_level NOT NULL DEFAULT 'SEV_1',
    enabled         BOOLEAN       NOT NULL DEFAULT TRUE,
    description     TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed SLA rules from the spec's threshold configuration
INSERT INTO sla_rules (name, process, category, threshold, sla_minutes, severity, description) VALUES
    ('S2N error threshold',         'S2N',  NULL,          5,   NULL, 'SEV_1', 'Max Shopify→NetSuite errors per day before alert'),
    ('N2S error threshold',         'N2S',  NULL,          5,   NULL, 'SEV_1', 'Max NetSuite→Shopify errors per day before alert'),
    ('S2N rerun threshold',         'S2N',  NULL,         10,   NULL, 'SEV_1', 'Max SO re-runs per day before alert'),
    ('IDX failure threshold',       'IDX',  NULL,          3,   NULL, 'SEV_1', 'Max indexing failures per day before alert'),
    ('Vertex tax threshold',        'NS',   'TAX-VERTEX',  3,   NULL, 'SEV_1', 'Max Vertex tax failures per day'),
    ('Inventory item threshold',    'NS',   'INV-ITEM',    5,   NULL, 'SEV_1', 'Max inventory item failures per day'),
    ('Validation data threshold',   'NS',   'VAL-DATA',   10,   NULL, 'SEV_1', 'Max validation failures per day'),
    ('Pending transaction SLA',     'ALL',  NULL,          1,   240,  'SEV_2', 'Transaction pending longer than 4 hours');


CREATE TABLE sla_breaches (
    id                  BIGSERIAL PRIMARY KEY,
    sla_rule_id         INT          NOT NULL REFERENCES sla_rules(id),
    transaction_id      BIGINT       REFERENCES integration_transactions(id),
    triggered_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    actual_value        NUMERIC(12,2),
    threshold_value     NUMERIC(12,2),
    severity            severity_level NOT NULL,
    status              VARCHAR(50)  NOT NULL DEFAULT 'OPEN',   -- 'OPEN', 'RESOLVED', 'ACKNOWLEDGED'
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_breach_rule         ON sla_breaches(sla_rule_id);
CREATE INDEX idx_breach_transaction  ON sla_breaches(transaction_id);
CREATE INDEX idx_breach_status       ON sla_breaches(status);
CREATE INDEX idx_breach_triggered    ON sla_breaches(triggered_at);
CREATE INDEX idx_breach_open         ON sla_breaches(status, triggered_at) WHERE status = 'OPEN';
