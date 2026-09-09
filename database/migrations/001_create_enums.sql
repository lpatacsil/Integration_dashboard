-- Migration 001: Create enum types
-- Integration Monitor — PostgreSQL schema
-- Compatible with Azure Database for PostgreSQL

-- Normalized transaction status used across the dashboard.
-- Original Team Central status is preserved as a text field on each transaction.
CREATE TYPE normalized_status AS ENUM (
    'SUCCESS',
    'FAILED',
    'PENDING',
    'PROCESSING',
    'RETRY',
    'MANUAL_INTERVENTION',
    'CANCELLED'
);

-- Direction of data flow between systems.
CREATE TYPE flow_direction AS ENUM (
    'INBOUND',   -- into NetSuite (Shopify → NetSuite)
    'OUTBOUND',  -- out of NetSuite (NetSuite → Shopify)
    'BIDIRECTIONAL'
);

-- Error category groups from the spec.
-- Drives severity (MAPPING/INDEXING are blocking) and routing.
CREATE TYPE error_group AS ENUM (
    'MAPPING',
    'INDEXING',
    'NETSUITE',
    'TRANSIENT',
    'OUTAGE'
);

-- Severity levels for integration health (Sev 0–4).
CREATE TYPE severity_level AS ENUM (
    'SEV_0',
    'SEV_1',
    'SEV_2',
    'SEV_3',
    'SEV_4'
);

-- Processing status for raw Team Central events during ingestion.
CREATE TYPE ingestion_status AS ENUM (
    'RECEIVED',
    'PROCESSING',
    'PROCESSED',
    'FAILED',
    'SKIPPED'
);
