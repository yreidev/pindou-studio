DO $$
DECLARE pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('users','accounts'), ('user_wechat_identities','account_wechat_identities'),
    ('authentication_sessions','web_sessions'), ('browser_login_sessions','web_login_challenges'),
    ('role_assignments','staff_role_assignments'), ('audit_logs','audit_events'),
    ('areas','floor_areas'), ('table_layouts','service_tables'), ('seats','service_table_seats'),
    ('table_splits','service_table_splits'), ('service_sessions','venue_sessions'),
    ('products','catalog_items'), ('service_products','catalog_services'),
    ('inventory_items','stock_items'), ('inventory_movements','stock_ledger_entries'),
    ('purchase_records','stock_receipts'), ('inventory_adjustments','stock_adjustments'),
    ('orders','sales_orders'), ('order_lines','sales_order_lines'),
    ('payment_entries','payment_records'), ('order_discounts','sales_order_discounts'),
    ('refunds','refund_records'), ('backups','system_backups'), ('restorations','system_restore_runs')
  ) AS names(old_name, new_name)
  LOOP
    IF to_regclass('public.' || pair.old_name) IS NOT NULL AND to_regclass('public.' || pair.new_name) IS NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', pair.old_name, pair.new_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('account_wechat_identities','user_id','account_id'), ('web_sessions','user_id','account_id'),
    ('staff_role_assignments','user_id','account_id'), ('service_tables','area_id','floor_area_id'),
    ('service_table_seats','table_id','service_table_id'), ('service_table_splits','table_id','service_table_id'),
    ('venue_sessions','table_id','service_table_id'), ('venue_sessions','user_id','account_id'),
    ('stock_items','product_id','catalog_item_id'), ('stock_ledger_entries','inventory_item_id','stock_item_id'),
    ('stock_adjustments','inventory_item_id','stock_item_id'), ('sales_orders','table_session_id','venue_session_id'),
    ('sales_orders','user_id','account_id'), ('sales_order_lines','order_id','sales_order_id'),
    ('sales_order_lines','product_id','catalog_item_id'), ('payment_records','order_id','sales_order_id'),
    ('sales_order_discounts','order_id','sales_order_id'), ('refund_records','order_id','sales_order_id'),
    ('web_login_challenges','approved_by','approved_by_account_id'), ('audit_events','actor_id','actor_account_id')
  ) AS names(table_name, old_name, new_name)
  LOOP
    IF to_regclass('public.' || item.table_name) IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=item.table_name AND column_name=item.old_name) AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=item.table_name AND column_name=item.new_name) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', item.table_name, item.old_name, item.new_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE pair record; item record; renamed text;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('users','accounts'), ('user_wechat_identities','account_wechat_identities'),
    ('authentication_sessions','web_sessions'), ('browser_login_sessions','web_login_challenges'),
    ('role_assignments','staff_role_assignments'), ('audit_logs','audit_events'),
    ('areas','floor_areas'), ('table_layouts','service_tables'), ('seats','service_table_seats'),
    ('table_splits','service_table_splits'), ('service_sessions','venue_sessions'),
    ('products','catalog_items'), ('service_products','catalog_services'), ('inventory_items','stock_items'),
    ('inventory_movements','stock_ledger_entries'), ('purchase_records','stock_receipts'),
    ('inventory_adjustments','stock_adjustments'), ('orders','sales_orders'),
    ('order_lines','sales_order_lines'), ('payment_entries','payment_records'),
    ('order_discounts','sales_order_discounts'), ('refunds','refund_records'),
    ('backups','system_backups'), ('restorations','system_restore_runs')
  ) AS names(old_name, new_name)
  LOOP
    FOR item IN
      SELECT n.nspname AS schema_name, c.relname AS relation_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND n.nspname = 'public' AND left(c.relname, length(pair.old_name) + 1) = pair.old_name || '_'
    LOOP
      renamed := pair.new_name || substr(item.relation_name, length(pair.old_name) + 1);
      IF to_regclass('public.' || renamed) IS NULL THEN
        EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', item.schema_name, item.relation_name, renamed);
      END IF;
    END LOOP;
    FOR item IN
      SELECT n.nspname AS schema_name, c.relname AS relation_name, con.conname
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND left(con.conname, length(pair.old_name) + 1) = pair.old_name || '_'
    LOOP
      renamed := pair.new_name || substr(item.conname, length(pair.old_name) + 1);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = renamed) THEN
        EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', item.schema_name, item.relation_name, item.conname, renamed);
      END IF;
    END LOOP;
  END LOOP;
END $$;

ALTER INDEX IF EXISTS role_assignments_one_active_role RENAME TO staff_role_assignments_one_active_account;
ALTER INDEX IF EXISTS staff_role_assignments_one_active_role RENAME TO staff_role_assignments_one_active_account;
ALTER TABLE IF EXISTS accounts ADD COLUMN IF NOT EXISTS login_name text;
ALTER TABLE IF EXISTS accounts ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE IF EXISTS accounts ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_login_name_unique ON accounts (lower(login_name)) WHERE login_name IS NOT NULL;
