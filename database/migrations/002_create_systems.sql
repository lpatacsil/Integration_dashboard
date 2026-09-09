-- Migration 002: Systems table
-- Stores source and destination systems (NetSuite, Shopify, Team Central, etc.)

CREATE TABLE systems (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(50)  NOT NULL UNIQUE,  -- e.g. 'NETSUITE', 'SHOPIFY', 'TEAM_CENTRAL'
    name            VARCHAR(150) NOT NULL,         -- e.g. 'NetSuite', 'Shopify'
    description     TEXT,
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the known systems from the spec
INSERT INTO systems (code, name, description) VALUES
    ('NETSUITE',      'NetSuite',      'ERP system — sales orders, fulfillments, inventory'),
    ('SHOPIFY',       'Shopify',       'E-commerce platform — orders, draft orders, customers'),
    ('TEAM_CENTRAL',  'Team Central',  'Integration middleware / connector between NetSuite and Shopify');
