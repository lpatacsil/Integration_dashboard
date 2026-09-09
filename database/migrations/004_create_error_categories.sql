-- Migration 004: Error category reference table
-- The 12 error codes from the spec, each with a group and regex pattern.
-- Used to classify raw error text and determine whether an error is blocking.

CREATE TABLE error_categories (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(30)   NOT NULL UNIQUE,   -- e.g. 'MAP-CUST'
    label           VARCHAR(255)  NOT NULL,           -- human-readable label
    error_group     error_group   NOT NULL,           -- MAPPING, INDEXING, NETSUITE, TRANSIENT, OUTAGE
    match_pattern   TEXT          NOT NULL,           -- regex (case-insensitive) used to classify
    is_blocking     BOOLEAN       NOT NULL DEFAULT FALSE,  -- drives severity ladder
    display_order   INT           NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed from the spec's CATEGORY_RULES
INSERT INTO error_categories (code, label, error_group, match_pattern, is_blocking, display_order) VALUES
    ('MAP-CUST',   'Customer not mapped / indexed',           'MAPPING',   'customer.*(not (found|mapped)|missing)',                TRUE,  1),
    ('MAP-ITEM',   'Item / SKU not mapped',                   'MAPPING',   '(item|sku).*(not (found|mapped)|invalid)',              TRUE,  2),
    ('MAP-SHIP',   'Ship-to address not mapped',              'MAPPING',   '(ship.?to|address).*(not (found|mapped)|invalid)',      TRUE,  3),
    ('MAP-LOC',    'Location / store not mapped',             'MAPPING',   '(location|store|shop).*(not (found|mapped))',           TRUE,  4),
    ('IDX-SKIP',   'Record skipped by indexing',              'INDEXING',  'skipped|no index|not indexed',                          TRUE,  5),
    ('TAX-VERTEX', 'Vertex tax calculation failed',           'NETSUITE',  'vertex|tax (calc|service)',                             FALSE, 6),
    ('INV-ITEM',   'Inventory item not recognized / short',   'NETSUITE',  'inventory|insufficient|not recognized',                 FALSE, 7),
    ('NS-PERM',    'Permission / role error',                 'NETSUITE',  'permission|role|insufficient privilege',                FALSE, 8),
    ('VAL-DATA',   'Validation / missing required field',     'NETSUITE',  'required|invalid value|validation',                    FALSE, 9),
    ('API-RATE',   'Rate limit / timeout (auto-retry)',       'TRANSIENT', 'rate limit|429|timeout|timed out',                      FALSE, 10),
    ('DUP',        'Duplicate record suppressed',             'TRANSIENT', 'duplicate|already exists',                              FALSE, 11),
    ('CONN-DOWN',  'Connector heartbeat missing',             'OUTAGE',    'heartbeat|connector offline',                           FALSE, 12);
