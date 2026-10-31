-- +goose Up

ALTER TABLE payment_records DROP CONSTRAINT IF EXISTS payment_records_method_check;
ALTER TABLE payment_records ADD CONSTRAINT payment_records_method_check CHECK (method IN ('cash','wechat','alipay','balance','comp'));
ALTER TABLE payment_records ADD CONSTRAINT payment_records_comp_amount CHECK (method <> 'comp' OR amount_cents >= 1);
