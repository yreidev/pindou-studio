-- +goose Up

ALTER TABLE account_wechat_identities ADD COLUMN openid_sealed bytea;

CREATE TABLE reservation_notices (
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  kind text NOT NULL CHECK (kind IN ('confirmed', 'reminder', 'cancelled')),
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'void')),
  failure text CHECK (char_length(failure) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (reservation_id, kind),
  CHECK ((status = 'failed') = (failure IS NOT NULL))
);
CREATE INDEX reservation_notices_pending ON reservation_notices (kind) WHERE status = 'pending';
