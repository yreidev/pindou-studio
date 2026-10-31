ALTER TABLE venue_sessions DROP CONSTRAINT IF EXISTS venue_sessions_duration_minutes_check;
ALTER TABLE venue_sessions ADD CONSTRAINT venue_sessions_duration_minutes_check CHECK (duration_minutes >= 0);
ALTER TABLE venue_sessions ADD COLUMN timing_mode text NOT NULL DEFAULT 'timed' CHECK (timing_mode IN ('timed','free'));
ALTER TABLE venue_sessions ADD COLUMN paused_at timestamptz;
ALTER TABLE venue_sessions ADD COLUMN paused_seconds bigint NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0);
ALTER TABLE sales_orders ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE stock_receipts ADD COLUMN items jsonb NOT NULL DEFAULT '[]';
ALTER TABLE sales_order_lines ADD COLUMN line_index bigint;
CREATE UNIQUE INDEX sales_order_lines_position ON sales_order_lines(sales_order_id,line_index);
ALTER TABLE staff_role_assignments ADD COLUMN revoked_at timestamptz;
DROP INDEX IF EXISTS staff_role_assignments_one_active_account;
CREATE UNIQUE INDEX staff_role_assignments_one_active_account ON staff_role_assignments(account_id) WHERE revoked_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['accounts','staff_role_assignments','floor_areas','service_tables','service_table_splits','venue_sessions','sales_orders','stock_items','stock_receipts','stock_ledger_entries','audit_events','system_backups','payment_records','refund_records','sales_order_discounts'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN state jsonb NOT NULL DEFAULT ''{}''::jsonb', table_name);
  END LOOP;
END $$;

CREATE TABLE application_state (id boolean PRIMARY KEY DEFAULT true CHECK (id), revision bigint NOT NULL DEFAULT 0, initialized boolean NOT NULL DEFAULT false, runtime jsonb NOT NULL DEFAULT '{}');
INSERT INTO application_state(id) VALUES(true);

CREATE FUNCTION protect_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable record cannot be deleted'; END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable record cannot be overwritten'; END IF;
  RETURN OLD;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payment_records','refund_records','stock_ledger_entries','audit_events','stock_receipts','stock_adjustments','sales_order_discounts'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_append_only()', table_name);
  END LOOP;
END $$;

CREATE FUNCTION protect_paid_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('paid','refunded') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'paid order cannot be deleted'; END IF;
    IF NEW.status NOT IN ('paid','refunded') OR
      (NEW.receivable_cents,NEW.paid_cents,NEW.account_id,NEW.venue_session_id,NEW.created_at) IS DISTINCT FROM (OLD.receivable_cents,OLD.paid_cents,OLD.account_id,OLD.venue_session_id,OLD.created_at) OR
      NOT COALESCE(NEW.state->'refunds','[]') @> COALESCE(OLD.state->'refunds','[]') OR
      (NEW.state - 'refunds' - 'status') IS DISTINCT FROM (OLD.state - 'refunds' - 'status') THEN
      RAISE EXCEPTION 'paid order can only receive refund records';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_paid_order BEFORE UPDATE OR DELETE ON sales_orders FOR EACH ROW EXECUTE FUNCTION protect_paid_order();

CREATE FUNCTION protect_paid_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sales_orders WHERE id=OLD.sales_order_id AND status IN ('paid','refunded')) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'paid order line cannot be deleted'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'paid order line cannot be updated'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_paid_line BEFORE UPDATE OR DELETE ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION protect_paid_line();
