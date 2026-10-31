-- 库的指纹：每张业务表的行数与内容摘要、迁移登记、扩展、排序规则与时区。
-- 恢复、导入前后各跑一次，逐行对比（docs/deployment.md「数据库（CloudNativePG）」、deploy/cnpg-rehearsal.sh）。
-- 只读，不改任何数据：kubectl -n pindou exec -i <Pod> -- psql -d pindou -X -q < deploy/cnpg-fingerprint.sql
\pset footer off
\pset tuples_only on
SELECT 'locale ' || datcollate || ' / ' || datctype || ' / provider ' || datlocprovider::text FROM pg_database WHERE datname = current_database();
SELECT 'timezone ' || current_setting('TimeZone');
SELECT 'server ' || current_setting('server_version');
SELECT 'superuser(pindou) ' || rolsuper FROM pg_roles WHERE rolname = 'pindou';
SELECT 'extensions ' || string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension;
SELECT 'zh-x-icu ' || count(*) FROM pg_collation WHERE collname = 'zh-x-icu';
SELECT 'migrations ' || count(*) || ' last=' || max(version_id) FROM goose_db_version WHERE is_applied AND version_id > 0;
CREATE TEMP TABLE fp(t text, n bigint, h text);
DO $$
DECLARE r record; n bigint; h text;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    EXECUTE format('SELECT count(*), md5(coalesce(string_agg(x::text, %L ORDER BY x::text), %L)) FROM %I.%I x', '|', '', r.schemaname, r.tablename) INTO n, h;
    INSERT INTO fp VALUES (r.tablename, n, h);
  END LOOP;
END $$;
SELECT rpad(t, 28) || lpad(n::text, 6) || '  ' || left(h, 12) FROM fp ORDER BY t;
SELECT 'ALL ' || sum(n) || ' rows, ' || left(md5(string_agg(t || n || h, ',' ORDER BY t)), 12) FROM fp;
