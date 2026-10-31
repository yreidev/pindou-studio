-- +goose Up

CREATE TABLE account_passwords (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+?[0-9]{6,15}$'),
  password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  must_change boolean NOT NULL,
  temporary_expires_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_passwords_temporary CHECK (must_change = (temporary_expires_at IS NOT NULL))
);

ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_client_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_client_check CHECK (client IN ('miniapp', 'web', 'h5'));
