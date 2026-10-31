-- +goose Up

ALTER TABLE catalog_items ADD COLUMN barcode text;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_barcode_format CHECK (barcode ~ '^[!-~]{1,64}$');
CREATE UNIQUE INDEX catalog_items_barcode ON catalog_items (barcode) WHERE barcode IS NOT NULL;
