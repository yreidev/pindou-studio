CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION pindou_masked_phone(phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN phone IS NULL THEN ''
  WHEN length(phone) <= 4 THEN repeat('*', length(phone))
  WHEN length(phone) < 7 THEN left(phone, 1) || repeat('*', length(phone) - 3) || right(phone, 2)
  ELSE left(phone, 3) || repeat('*', length(phone) - 7) || right(phone, 4) END;

CREATE FUNCTION pindou_account_search(state jsonb, phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN lower(COALESCE(state->>'nickname', '') || E'\n' || pindou_masked_phone(phone));
CREATE INDEX accounts_search ON accounts USING gin (pindou_account_search(state, phone) gin_trgm_ops);

CREATE FUNCTION pindou_order_search(id uuid, state jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT lower(id::text || E'\n' || CASE WHEN jsonb_typeof(state->'lines') = 'array'
  THEN COALESCE((SELECT string_agg(COALESCE(l->>'name', ''), E'\n') FROM jsonb_array_elements(state->'lines') l), '') ELSE '' END) $$;
CREATE INDEX sales_orders_search ON sales_orders USING gin (pindou_order_search(id, state) gin_trgm_ops);

CREATE FUNCTION pindou_audit_search(state jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN lower(COALESCE(state->>'Action', '') || E'\n' || COALESCE(state->>'ObjectID', '') || E'\n' || COALESCE(state->>'RequestID', '') || E'\n' ||
  COALESCE(state->>'Reason', '') || E'\n' || COALESCE(state->>'ActorID', ''));
CREATE INDEX audit_events_search ON audit_events USING gin (pindou_audit_search(state) gin_trgm_ops);
CREATE INDEX audit_events_actor ON audit_events (actor_account_id);
CREATE INDEX audit_events_action ON audit_events (action);
