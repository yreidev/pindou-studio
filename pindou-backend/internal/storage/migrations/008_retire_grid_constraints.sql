ALTER TABLE floor_areas ALTER COLUMN grid_columns SET DEFAULT 4;
ALTER TABLE floor_areas ALTER COLUMN grid_rows SET DEFAULT 4;
ALTER TABLE floor_areas DROP CONSTRAINT IF EXISTS areas_grid_columns_check;
ALTER TABLE floor_areas DROP CONSTRAINT IF EXISTS areas_grid_rows_check;
ALTER TABLE floor_areas DROP CONSTRAINT IF EXISTS floor_areas_grid_columns_check;
ALTER TABLE floor_areas DROP CONSTRAINT IF EXISTS floor_areas_grid_rows_check;

ALTER TABLE service_tables DROP CONSTRAINT IF EXISTS table_layouts_area_id_grid_x_grid_y_key;
ALTER TABLE service_tables DROP CONSTRAINT IF EXISTS service_tables_area_id_grid_x_grid_y_key;

UPDATE floor_areas SET grid_columns = 4 WHERE grid_columns < 4;
UPDATE floor_areas SET grid_rows = 4 WHERE grid_rows < 4;
