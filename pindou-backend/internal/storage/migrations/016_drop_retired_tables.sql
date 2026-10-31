-- +goose Up

DROP TABLE IF EXISTS pindou_state;
DROP TABLE IF EXISTS application_state;
DROP TABLE IF EXISTS system_restore_runs;
DROP TABLE IF EXISTS system_backups;
DROP TABLE IF EXISTS catalog_services;
DROP TABLE IF EXISTS service_table_seats;
DROP TABLE IF EXISTS web_login_challenges;
DROP TABLE IF EXISTS schema_migrations;
ALTER TABLE accounts
  DROP COLUMN IF EXISTS login_name,
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS password_change_required;
