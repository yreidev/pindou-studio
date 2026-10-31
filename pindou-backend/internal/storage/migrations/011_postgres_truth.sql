CREATE TABLE web_logins (
  id uuid PRIMARY KEY,
  poll_hash text NOT NULL CHECK (poll_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'used')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  approved_by_account_id uuid REFERENCES accounts(id)
);
CREATE INDEX web_logins_expires_at ON web_logins (expires_at);

CREATE UNLOGGED TABLE rate_limit_windows (
  key text PRIMARY KEY,
  reset_at timestamptz NOT NULL,
  count integer NOT NULL
);

ALTER TABLE audit_events ADD COLUMN seq bigserial;

CREATE INDEX venue_sessions_live ON venue_sessions (service_table_id) WHERE status IN ('active', 'paused', 'companion');
CREATE INDEX venue_sessions_account ON venue_sessions (account_id);
CREATE INDEX sales_orders_session ON sales_orders (venue_session_id);
CREATE INDEX sales_orders_account ON sales_orders (account_id);
CREATE INDEX sales_orders_created ON sales_orders (created_at DESC, id);
CREATE INDEX stock_items_catalog ON stock_items (catalog_item_id);
CREATE INDEX stock_ledger_entries_created ON stock_ledger_entries (created_at DESC, id DESC);
CREATE INDEX stock_ledger_entries_item ON stock_ledger_entries (stock_item_id);
CREATE INDEX audit_events_created ON audit_events (created_at DESC, seq);
CREATE INDEX reservations_account ON reservations (account_id);
CREATE INDEX reservations_start ON reservations (start_at);
CREATE INDEX membership_entries_source ON membership_entries ((state->>'sourceId'));
CREATE INDEX membership_admissions_account ON membership_admissions (account_id);
CREATE INDEX auth_sessions_account ON auth_sessions (account_id);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

UPDATE application_state SET initialized = true WHERE id = true;
