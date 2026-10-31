-- +goose Up

CREATE TABLE billing_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL
);

ALTER TABLE venue_sessions DROP CONSTRAINT IF EXISTS venue_sessions_status_check;
ALTER TABLE venue_sessions ADD CONSTRAINT venue_sessions_status_check CHECK (status IN ('active','paused','companion','cancelled','settled','ended'));

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION protect_partially_paid_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled','ended') AND OLD.status IS DISTINCT FROM NEW.status AND
    EXISTS(SELECT 1 FROM sales_orders WHERE venue_session_id = NEW.id AND status = 'partially_paid') THEN
    RAISE EXCEPTION 'session with a partially paid order cannot be cancelled or ended';
  END IF;
  IF OLD.status = 'ended' AND NEW.status IS DISTINCT FROM 'ended' THEN
    RAISE EXCEPTION 'ended session cannot change status';
  END IF;
  RETURN NEW;
END $$;
-- +goose StatementEnd
