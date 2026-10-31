-- +goose Up

ALTER TABLE payment_records ADD COLUMN cash_received_cents bigint;
ALTER TABLE payment_records ADD COLUMN change_cents bigint;
ALTER TABLE payment_records ADD CONSTRAINT payment_records_cash_tender CHECK (
  (cash_received_cents IS NULL AND change_cents IS NULL)
  OR (cash_received_cents IS NOT NULL AND change_cents IS NOT NULL AND method = 'cash'
      AND cash_received_cents >= amount_cents AND change_cents = cash_received_cents - amount_cents)
);
