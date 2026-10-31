-- +goose Up

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_status_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_status_check CHECK (status IN ('draft','partially_paid','paid','refunded','voided'));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION protect_paid_order() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status = 'partially_paid' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'partially paid order cannot be deleted'; END IF;
    IF NEW.status NOT IN ('partially_paid','paid') OR
      (NEW.receivable_cents,NEW.account_id,NEW.venue_session_id,NEW.created_at) IS DISTINCT FROM (OLD.receivable_cents,OLD.account_id,OLD.venue_session_id,OLD.created_at) OR
      NEW.paid_cents < OLD.paid_cents OR
      NOT COALESCE(NEW.state->'payments','[]') @> COALESCE(OLD.state->'payments','[]') OR
      (NEW.state - 'payments' - 'paidCents' - 'status') IS DISTINCT FROM (OLD.state - 'payments' - 'paidCents' - 'status') THEN
      RAISE EXCEPTION 'partially paid order can only receive payment records';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION protect_paid_line() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sales_orders WHERE id=OLD.sales_order_id AND status IN ('partially_paid','paid','refunded')) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'paid order line cannot be deleted'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'paid order line cannot be updated'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION protect_partially_paid_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND
    EXISTS(SELECT 1 FROM sales_orders WHERE venue_session_id = NEW.id AND status = 'partially_paid') THEN
    RAISE EXCEPTION 'session with a partially paid order cannot be cancelled';
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd
CREATE TRIGGER no_cancel_partially_paid BEFORE UPDATE ON venue_sessions FOR EACH ROW EXECUTE FUNCTION protect_partially_paid_session();
