-- +goose Up

CREATE TABLE service_calls (
  id uuid PRIMARY KEY,
  venue_session_id uuid NOT NULL REFERENCES venue_sessions(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL CHECK (status IN ('pending', 'handled')),
  created_at timestamptz NOT NULL,
  handled_at timestamptz,
  handled_by_account_id uuid REFERENCES accounts(id),
  state jsonb NOT NULL,
  CONSTRAINT service_calls_handled CHECK ((status = 'handled') = (handled_at IS NOT NULL AND handled_by_account_id IS NOT NULL))
);
CREATE INDEX service_calls_session ON service_calls (venue_session_id, created_at DESC);
CREATE INDEX service_calls_pending ON service_calls (created_at) WHERE status = 'pending';
