-- 收货入库的预填（GET /stock-receipts/prefill）用这两条，各扫一遍采购单，不按商品逐件查。
-- 最近一次入库用的供应商；还没入过库时没有行。
-- name: LatestPurchaseSupplier :many
SELECT supplier_name FROM stock_receipts ORDER BY created_at DESC, id DESC LIMIT 1;

-- 每件商品最近一次入库的进价（分）。同一张单里同一商品出现两行时取靠后的一行。
-- 采购单整条存在 state 里（Load 读的也是它）；items 列是迁移 003 加的副本，003 之前的老单这一列是空数组，
-- 所以明细从 state->'Items' 取。商品编号进门时校验过是 UUID（可能是大写），转成 uuid 再分组，
-- 和商品资料的编号写法一致。
-- name: LatestPurchaseUnitCosts :many
SELECT DISTINCT ON ((line.value->>'productId')::uuid)
  (line.value->>'productId')::uuid AS product_id,
  (line.value->>'unitCostCents')::bigint AS unit_cost_cents
FROM stock_receipts r
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.state->'Items') = 'array' THEN r.state->'Items' ELSE '[]'::jsonb END) WITH ORDINALITY AS line(value, position)
WHERE line.value->>'productId' IS NOT NULL AND line.value->>'unitCostCents' IS NOT NULL
ORDER BY (line.value->>'productId')::uuid, r.created_at DESC, r.id DESC, line.position DESC;
