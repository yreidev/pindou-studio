-- +goose Up

CREATE TABLE miniprogram_code_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  env_version text NOT NULL CHECK (env_version IN ('release', 'trial', 'develop')),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL
);
