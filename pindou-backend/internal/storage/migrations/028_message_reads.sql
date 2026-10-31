-- +goose Up
CREATE TABLE message_reads (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  read_at timestamptz NOT NULL
);
