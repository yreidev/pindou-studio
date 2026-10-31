ALTER TABLE service_tables ADD COLUMN IF NOT EXISTS code text;

ALTER TABLE service_tables ALTER COLUMN grid_x SET DEFAULT 0;
ALTER TABLE service_tables ALTER COLUMN grid_y SET DEFAULT 0;
ALTER TABLE floor_areas ALTER COLUMN grid_columns SET DEFAULT 4;
ALTER TABLE floor_areas ALTER COLUMN grid_rows SET DEFAULT 4;

UPDATE service_tables t SET code = z.key || t.number
FROM floor_areas a
JOIN (VALUES ('A 区','A'), ('B 区','B'), ('C 区','C'), ('E 区','E')) AS z(name, key) ON z.name = a.name
WHERE t.floor_area_id = a.id
  AND t.code IS NULL
  AND NOT (a.name = 'A 区' AND t.number IN (3, 4));

CREATE TEMP TABLE legacy_tables ON COMMIT DROP AS
SELECT t.id FROM service_tables t JOIN floor_areas a ON a.id = t.floor_area_id
WHERE a.name IN ('1', '包间') OR (a.name = 'A 区' AND t.number IN (3, 4));

CREATE TEMP TABLE rebind_target ON COMMIT DROP AS
SELECT t.id FROM service_tables t JOIN floor_areas a ON a.id = t.floor_area_id
WHERE a.name = 'A 区' AND t.number = 1;

UPDATE venue_sessions SET
  service_table_id = (SELECT id FROM rebind_target),
  state = jsonb_set(state, '{serviceTableId}', to_jsonb((SELECT id::text FROM rebind_target)))
WHERE service_table_id IN (SELECT id FROM legacy_tables);

DELETE FROM reservations         WHERE service_table_id IN (SELECT id FROM legacy_tables);
DELETE FROM service_table_seats  WHERE service_table_id IN (SELECT id FROM legacy_tables);
DELETE FROM service_table_splits WHERE service_table_id IN (SELECT id FROM legacy_tables);
DELETE FROM service_tables       WHERE id IN (SELECT id FROM legacy_tables);
DELETE FROM floor_areas          WHERE name IN ('1', '包间');

UPDATE service_tables SET state = jsonb_set(state, '{Code}', to_jsonb(code)) WHERE code IS NOT NULL;

ALTER TABLE service_tables ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS service_tables_code_key ON service_tables (code);
