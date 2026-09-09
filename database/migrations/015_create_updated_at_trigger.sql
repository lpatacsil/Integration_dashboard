-- Migration 015: Auto-update updated_at trigger
-- Applied to all tables with an updated_at column.

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_systems_updated
    BEFORE UPDATE ON systems FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_endpoints_updated
    BEFORE UPDATE ON integration_endpoints FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_error_categories_updated
    BEFORE UPDATE ON error_categories FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_transactions_updated
    BEFORE UPDATE ON integration_transactions FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_reruns_updated
    BEFORE UPDATE ON integration_reruns FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_indexing_updated
    BEFORE UPDATE ON indexing_activity FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_sla_rules_updated
    BEFORE UPDATE ON sla_rules FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TRIGGER trg_raw_events_updated
    BEFORE UPDATE ON team_central_raw_events FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
