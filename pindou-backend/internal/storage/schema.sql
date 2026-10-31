-- 迁移全部跑完之后的表结构，给 sqlc 用（见 sqlc.yaml）。由 TestSchemaSnapshotMatchesMigrations 从真库导出，
-- 不要手改：迁移变了运行 make backend-sqlc。

CREATE TABLE account_passwords (
  account_id uuid NOT NULL,
  phone text NOT NULL,
  password_hash text NOT NULL,
  must_change boolean NOT NULL,
  temporary_expires_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE account_wechat_identities (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  identity_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  openid_sealed bytea
);

CREATE TABLE accounts (
  id uuid NOT NULL,
  nickname text NOT NULL,
  phone text,
  phone_verification_status text NOT NULL,
  privacy_contract_version text,
  privacy_accepted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE audit_events (
  id uuid NOT NULL,
  actor_account_id uuid,
  action text NOT NULL,
  object_id uuid,
  reason text,
  request_id text,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL,
  seq bigint NOT NULL
);

CREATE TABLE auth_sessions (
  token_hash text NOT NULL,
  account_id uuid NOT NULL,
  developer_mode text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL,
  client text NOT NULL
);

CREATE TABLE backup_runs (
  id bigint NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  size_bytes bigint NOT NULL,
  finished_at timestamp with time zone NOT NULL
);

CREATE TABLE bead_patterns (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  palette text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  colors text[] NOT NULL,
  cells text NOT NULL,
  done text NOT NULL,
  preview text NOT NULL,
  preview_width integer NOT NULL,
  preview_height integer NOT NULL,
  beads integer NOT NULL,
  done_beads integer NOT NULL,
  revision integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE bead_settings (
  id boolean NOT NULL,
  palette text NOT NULL,
  available text[],
  boxes jsonb NOT NULL,
  board_size integer NOT NULL,
  bead_size text NOT NULL,
  revision integer NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE billing_settings (
  id boolean NOT NULL,
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE catalog_items (
  id uuid NOT NULL,
  name text NOT NULL,
  unit_price_cents bigint NOT NULL,
  barcode text
);

CREATE TABLE floor_areas (
  id uuid NOT NULL,
  name text NOT NULL,
  grid_columns integer NOT NULL,
  grid_rows integer NOT NULL,
  locked boolean NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE member_codes (
  token_hash text NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE membership_admissions (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE membership_drafts (
  id uuid NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE membership_entries (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  kind text NOT NULL,
  principal_cents bigint NOT NULL,
  gift_cents bigint NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE membership_profiles (
  account_id uuid NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE membership_publications (
  id uuid NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE message_reads (
  account_id uuid NOT NULL,
  read_at timestamp with time zone NOT NULL
);

CREATE TABLE miniapp_version_observation (
  id boolean NOT NULL,
  version text NOT NULL,
  reported_at timestamp with time zone NOT NULL
);

CREATE TABLE miniprogram_code_settings (
  id boolean NOT NULL,
  env_version text NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE pattern_categories (
  id uuid NOT NULL,
  name text NOT NULL,
  "position" integer NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE patterns (
  id uuid NOT NULL,
  name text NOT NULL,
  category_id uuid,
  published boolean NOT NULL,
  first_published_at timestamp with time zone,
  "position" integer NOT NULL,
  image bytea NOT NULL,
  image_type text NOT NULL,
  thumbnail bytea NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  image_version text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE payment_records (
  id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  method text NOT NULL,
  amount_cents bigint NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL,
  cash_received_cents bigint,
  change_cents bigint
);

CREATE TABLE rate_limit_windows (
  key text NOT NULL,
  reset_at timestamp with time zone NOT NULL,
  count integer NOT NULL
);

CREATE TABLE refund_records (
  id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE reservation_notices (
  reservation_id uuid NOT NULL,
  kind text NOT NULL,
  account_id uuid NOT NULL,
  status text NOT NULL,
  failure text,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE reservation_settings (
  id boolean NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE reservations (
  id uuid NOT NULL,
  account_id uuid,
  service_table_id uuid NOT NULL,
  seat_number integer NOT NULL,
  start_at timestamp with time zone NOT NULL,
  duration_minutes integer NOT NULL,
  status text NOT NULL,
  venue_session_id uuid,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE sales_order_discounts (
  id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  kind text NOT NULL,
  amount_cents bigint,
  rate_basis_points bigint,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE sales_order_lines (
  id uuid NOT NULL,
  sales_order_id uuid NOT NULL,
  catalog_item_id uuid,
  name text,
  quantity integer NOT NULL,
  unit_price_cents bigint NOT NULL,
  line_index bigint
);

CREATE TABLE sales_orders (
  id uuid NOT NULL,
  venue_session_id uuid,
  account_id uuid,
  status text NOT NULL,
  receivable_cents bigint NOT NULL,
  paid_cents bigint NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE service_calls (
  id uuid NOT NULL,
  venue_session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  status text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  handled_at timestamp with time zone,
  handled_by_account_id uuid,
  state jsonb NOT NULL
);

CREATE TABLE service_table_splits (
  id uuid NOT NULL,
  service_table_id uuid NOT NULL,
  new_table_count integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE service_tables (
  id uuid NOT NULL,
  floor_area_id uuid NOT NULL,
  number integer NOT NULL,
  seat_count integer NOT NULL,
  grid_x integer NOT NULL,
  grid_y integer NOT NULL,
  enabled boolean NOT NULL,
  state jsonb NOT NULL,
  code text NOT NULL
);

CREATE TABLE staff_role_assignments (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  role text NOT NULL,
  assigned_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  state jsonb NOT NULL
);

CREATE TABLE stock_adjustments (
  id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  quantity_delta bigint NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE stock_items (
  id uuid NOT NULL,
  catalog_item_id uuid NOT NULL,
  quantity bigint NOT NULL,
  alert_at bigint NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE stock_ledger_entries (
  id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  kind text NOT NULL,
  quantity_delta bigint NOT NULL,
  reason text,
  created_at timestamp with time zone NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE stock_receipts (
  id uuid NOT NULL,
  supplier_name text NOT NULL,
  note text,
  created_at timestamp with time zone NOT NULL,
  items jsonb NOT NULL,
  state jsonb NOT NULL
);

CREATE TABLE storefront_announcement (
  id boolean NOT NULL,
  body text NOT NULL,
  expires_on date,
  updated_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL
);

CREATE TABLE venue_sessions (
  id uuid NOT NULL,
  service_table_id uuid NOT NULL,
  account_id uuid,
  status text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  duration_minutes integer NOT NULL,
  timing_mode text NOT NULL,
  paused_at timestamp with time zone,
  paused_seconds bigint NOT NULL,
  state jsonb NOT NULL,
  seat_number integer NOT NULL
);

CREATE TABLE web_logins (
  id uuid NOT NULL,
  poll_hash text NOT NULL,
  status text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  user_agent text NOT NULL,
  ip text NOT NULL,
  approved_by_account_id uuid
);

CREATE TABLE web_presences (
  connection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE web_sessions (
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE OR REPLACE FUNCTION public.pindou_account_search(state jsonb, phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
RETURN lower(((COALESCE((state ->> 'nickname'::text), ''::text) || '
'::text) || pindou_masked_phone(phone)));

CREATE OR REPLACE FUNCTION public.pindou_audit_search(state jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
RETURN lower(((((((((COALESCE((state ->> 'Action'::text), ''::text) || '
'::text) || COALESCE((state ->> 'ObjectID'::text), ''::text)) || '
'::text) || COALESCE((state ->> 'RequestID'::text), ''::text)) || '
'::text) || COALESCE((state ->> 'Reason'::text), ''::text)) || '
'::text) || COALESCE((state ->> 'ActorID'::text), ''::text)));

CREATE OR REPLACE FUNCTION public.pindou_masked_phone(phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN (phone IS NULL) THEN ''::text WHEN (length(phone) <= 4) THEN repeat('*'::text, length(phone)) WHEN (length(phone) < 7) THEN (("left"(phone, 1) || repeat('*'::text, (length(phone) - 3))) || "right"(phone, 2)) ELSE (("left"(phone, 3) || repeat('*'::text, (length(phone) - 7))) || "right"(phone, 4)) END;

CREATE OR REPLACE FUNCTION public.pindou_order_search(id uuid, state jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$ SELECT lower(id::text || E'\n' || CASE WHEN jsonb_typeof(state->'lines') = 'array'
  THEN COALESCE((SELECT string_agg(COALESCE(l->>'name', ''), E'\n') FROM jsonb_array_elements(state->'lines') l), '') ELSE '' END) $function$;

CREATE OR REPLACE FUNCTION public.protect_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable record cannot be deleted'; END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable record cannot be overwritten'; END IF;
  RETURN OLD;
END $function$;

CREATE OR REPLACE FUNCTION public.protect_paid_line()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM sales_orders WHERE id=OLD.sales_order_id AND status IN ('partially_paid','paid','refunded')) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'paid order line cannot be deleted'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'paid order line cannot be updated'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.protect_paid_order()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status IN ('paid','refunded') THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'paid order cannot be deleted'; END IF;
    IF NEW.status NOT IN ('paid','refunded') OR
      (NEW.receivable_cents,NEW.paid_cents,NEW.account_id,NEW.venue_session_id,NEW.created_at) IS DISTINCT FROM (OLD.receivable_cents,OLD.paid_cents,OLD.account_id,OLD.venue_session_id,OLD.created_at) OR
      NOT COALESCE(NEW.state->'refunds','[]') @> COALESCE(OLD.state->'refunds','[]') OR
      (NEW.state - 'refunds' - 'status') IS DISTINCT FROM (OLD.state - 'refunds' - 'status') THEN
      RAISE EXCEPTION 'paid order can only receive refund records';
    END IF;
  END IF;
  IF OLD.status = 'partially_paid' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'partially paid order cannot be deleted'; END IF;
    IF NEW.status NOT IN ('partially_paid','paid') OR
      (NEW.receivable_cents,NEW.account_id,NEW.venue_session_id,NEW.created_at) IS DISTINCT FROM (OLD.receivable_cents,OLD.account_id,OLD.venue_session_id,OLD.created_at) OR
      NEW.paid_cents < OLD.paid_cents OR
      NOT COALESCE(NEW.state->'payments','[]') @> COALESCE(OLD.state->'payments','[]') OR
      (NEW.state - 'payments' - 'paidCents' - 'status') IS DISTINCT FROM (OLD.state - 'payments' - 'paidCents' - 'status') THEN
      RAISE EXCEPTION 'partially paid order can only receive payment records';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.protect_partially_paid_session()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IN ('cancelled','ended') AND OLD.status IS DISTINCT FROM NEW.status AND
    EXISTS(SELECT 1 FROM sales_orders WHERE venue_session_id = NEW.id AND status = 'partially_paid') THEN
    RAISE EXCEPTION 'session with a partially paid order cannot be cancelled or ended';
  END IF;
  IF OLD.status = 'ended' AND NEW.status IS DISTINCT FROM 'ended' THEN
    RAISE EXCEPTION 'ended session cannot change status';
  END IF;
  RETURN NEW;
END $function$;
