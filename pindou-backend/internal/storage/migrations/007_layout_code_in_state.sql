UPDATE service_tables
SET state = jsonb_set(state, '{Code}', to_jsonb(code))
WHERE code IS NOT NULL AND (state->>'Code') IS DISTINCT FROM code;
