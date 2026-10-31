-- +goose Up

-- +goose StatementBegin
DO $$
DECLARE
  gone uuid[];
  used text;
BEGIN
  SELECT array_agg(id) INTO gone FROM service_tables WHERE code IN ('B8', 'C4', 'E4', 'E5', 'E6');
  IF gone IS NULL THEN
    RETURN; -- 新库：桌位由启动校正按新布局建
  END IF;
  SELECT string_agg(t.code, '、' ORDER BY t.code) INTO used FROM service_tables t
  WHERE t.id = ANY (gone) AND (
    EXISTS (SELECT 1 FROM venue_sessions s WHERE s.service_table_id = t.id)
    OR EXISTS (SELECT 1 FROM reservations r WHERE r.service_table_id = t.id)
    OR EXISTS (SELECT 1 FROM service_table_splits p WHERE p.service_table_id = t.id)
    OR EXISTS (SELECT 1 FROM membership_admissions m WHERE m.state->>'serviceTableId' = t.id::text)
  );
  IF used IS NOT NULL THEN
    RAISE EXCEPTION '这些桌位有营业记录，不能按新布局删除：%（人工核对后再处理）', used;
  END IF;
  DELETE FROM service_table_seats WHERE service_table_id = ANY (gone);
  DELETE FROM service_tables WHERE id = ANY (gone);
END $$;
-- +goose StatementEnd
