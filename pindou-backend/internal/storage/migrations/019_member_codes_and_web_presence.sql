-- +goose Up

CREATE TABLE member_codes (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT member_codes_expiry CHECK (expires_at > created_at)
);
CREATE INDEX member_codes_expires_at ON member_codes (expires_at);

CREATE UNLOGGED TABLE web_presences (
  connection_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX web_presences_account ON web_presences (account_id, expires_at);
