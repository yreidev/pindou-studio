-- +goose Up
CREATE TABLE miniapp_version_observation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  version text NOT NULL CHECK (length(version) <= 32 AND version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  reported_at timestamptz NOT NULL
);
