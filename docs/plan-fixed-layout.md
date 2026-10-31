# 计划：桌位布局固定化

> 2026-09-19 由 Fable 5.1 制定，**只是计划，尚未执行**。执行者照本文动手，每步做完回来勾。
> 业主已定：历史残留**完全删除**；**停用/启用保留**；布局文件放仓库根、前后端共用。

## 0. 为什么

店只有一家、平面图只有一张、桌就是那 20 张。现在布局却有两份真相：

| 真相 A（前端写死） | 真相 B（后端动态数据） |
|---|---|
| `pindou-miniapp/src/services/seatmap.ts`：20 个位置、像素坐标、`seatBinding`、`areaNames` | `floor_areas` / `service_tables`：店员可增删改 |

为让 A、B 对得上，多出整套对账机器：员工端「布局管理」（创建区域、保存区域网格、加桌、拖格子 `gridX/gridY`、改座位数、锁定、「按平面图同步」）、前端 `plannedAreas / planSyncSteps / syncPending`、`mapSeats` 里五个「对不上就整张图拒绝」的分支、后端建/改区域与桌位的端点。三个文件 1579 行，约一半只为对账服务。

2026-09-19 的卡死（顾客端拒绝、员工端无事可做、按钮不渲染）、拼桌漏洞、上传丢图，都是对账失败的不同表现。这套动态能力**从没被用来做过布局管理**，只被用来修对不上的账。

固定之后：一份文件是唯一真相，后端启动时按它校正数据库，对账机器整个消失，删的比加的多。

## 1. 布局文件（唯一真相）

**位置**：仓库根 `layout/store-layout.json`。

```jsonc
{
  "plan": { "image": "plan.jpg", "width": 1045, "height": 878 },
  "zones": [
    { "key": "A", "name": "A 区", "desc": "双人位",     "color": "#fbd8d6", "seatsPerUnit": 2 },
    { "key": "B", "name": "B 区", "desc": "靠窗长桌",   "color": "#dff0fd", "seatsPerUnit": 1 },
    { "key": "C", "name": "C 区", "desc": "中岛工位",   "color": "#e4f7da", "seatsPerUnit": 1 },
    { "key": "E", "name": "E 区", "desc": "单人工位间", "color": "#eee1fd", "seatsPerUnit": 1 }
  ],
  "facilities": [
    { "name": "配件打孔区", "color": "#f0c48a" },
    { "name": "烫豆区",     "color": "#f4bdbd" }
  ],
  "tables": [
    { "code": "A1", "zone": "A", "number": 1, "seatCount": 2, "wholeTable": true,  "hotspot": { "x": 0, "y": 0, "w": 0, "h": 0 } },
    { "code": "A2", "zone": "A", "number": 2, "seatCount": 2, "wholeTable": true,  "hotspot": { "x": 0, "y": 0, "w": 0, "h": 0 } },
    { "code": "B1", "zone": "B", "number": 1, "seatCount": 1, "wholeTable": false, "hotspot": { "x": 0, "y": 0, "w": 0, "h": 0 } }
    // … 共 20 条：A1–A2、B1–B8、C1–C4、E1–E6。hotspot 从现有 seatmap.ts 的 planSeats 原样搬过来。
  ]
}
```

规则（写进门禁，见 §6）：
- `tables` 恰好 20 条，`code` 唯一，`code === zone + number`。
- `wholeTable === (seatCount > 1)`；`seatCount === zone.seatsPerUnit`（A 区 2，其余 1）。
- 每条 `hotspot` 落在 `plan` 尺寸之内。
- 顾客订的永远是这张桌的 **1 号座**（整桌单位由后端 `wholeTable` 锁全桌），所以文件里不再有 `seat` 字段。

**后端副本**：`pindou-backend/internal/layout/store-layout.json`。`go:embed` 出不了模块目录、也不认符号链接，只能放一份副本；`layout_test.go` 断言它与仓库根那份**字节相同**（不是内容相同）。改布局 = 改根文件 + 复制到后端 + 两边测试，漏一步就红。

后端只用 `zones` 和 `tables` 的结构字段，`hotspot`/`plan`/`facilities` 忽略。

## 2. 后端

### 2.1 数据模型

- `service_tables` 加列 `code text UNIQUE NOT NULL`（迁移 006，见 §4）。`Table` 结构体加 `Code string`。
- `floor_areas` 保留（有外键指向它），行数固定为 4 个区。`grid_columns/grid_rows/locked` 三列**留在库里不再读写**，`FloorArea` 结构体里删掉对应字段与 JSON 暴露。
- `service_tables.grid_x/grid_y` 同理留列不用；`Table` 里删 `GridX/GridY`。

### 2.2 启动校正 `internal/app/layout.go`（新）

`func (s *Server) reconcileLayout() error`，在 `NewPostgresServer` 加载快照之后、监听之前调用；`NewServer()`（内存模式）也调用。

按 `layout.Tables` 逐条：
1. 找 `store.areas` 中 `Name == zone.name` 的区域，没有则创建（`ID: id()`）。
2. 找 `store.tables` 中 `Code == table.code` 的桌，没有则创建（`Enabled: true`）。
3. 有则把 `AreaID / Number / SeatCount / WholeTable` **校正成布局值**；`Enabled` 不动（这是唯一的运营状态）。
4. 校正前检查：若有进行中会话（`liveSession`）的 `SeatNumber > 新 SeatCount`，**拒绝启动**并报出桌位——不能让运行中的客人坐在一个不存在的座号上。

遍历完毕后：
5. `store.tables` 里任何 `Code` 不在布局里的桌、`store.areas` 里任何名字不在布局里的区域 → **拒绝启动**，错误信息列出它们。（迁移 006 之后不该再有；出现即配置错误，按本仓库「启动期配置校验」惯例 fail-fast。）
6. 有改动则 `Save`。日志一行：`layout reconciled: created N tables, corrected M, areas created K`。

幂等：跑两遍第二遍 0 改动（测试钉住）。

### 2.3 API 收窄 `internal/app/tables.go`

| 端点 | 现在 | 之后 |
|---|---|---|
| `GET /floor-areas` | 列表 | 保留；视图去掉 `gridColumns/gridRows/locked` |
| `POST /floor-areas` | 创建 | **删除** → 405 |
| `PATCH /floor-areas/{id}` | 改名/网格/锁定 | **删除** → 405 |
| `GET /service-tables` | 列表 | 保留；视图加 `code`、`zone`，去掉 `gridX/gridY` |
| `POST /service-tables` | 创建 | **删除** → 405 |
| `PATCH /service-tables/{id}` | number/seatCount/wholeTable/gridX/gridY/enabled | **只接受 `{ "enabled": bool }`**，带其他字段 → 400 `layout_fixed`「桌位布局是固定的，只能停用或启用」 |
| `POST /venue-sessions` 等 | — | 不变 |

`loyaltyTables()`（顾客端读的那份）加 `code`、`zone`。

`docs/api.yaml` 同步：删掉的端点删掉，PATCH 的 schema 收窄，新增字段登记。契约以它为准。

### 2.4 错误文案

新增的都是中文（`error_copy_test.go` 会查）。`layout_fixed` 那条是面向店员的。

## 3. 前端（`pindou-miniapp`）

### 3.1 `src/services/seatmap.ts`

- `import layout from '../../../layout/store-layout.json'`（`tsconfig` 开 `resolveJsonModule`；Taro/Vite 原生支持 JSON）。
- **保留**：`planSize`、`zones`、`facilityLegends`、`zoneSeatCount`、`planSeats`（改为从 `layout.tables` 派生：`{ id: code, zone, ...hotspot }`）、`zoneOf`。
- **重写** `mapSeats(tables)`：对每条 `layout.tables`，按 `code` 在后端列表里找；找到 → `MappedSeat{ serviceTableId, tableNumber, seatNumber: 1, people: zone.seatsPerUnit, enabled }`；找不到 → 整体 `blocked: CUSTOMER_BLOCKED`（理论上不会发生，后端启动校正保证；留这一个分支是兜底）。**删掉**另外四个分支与 `wrongSeats/unresolved/ambiguous/missing/duplicated` 全部逻辑。
- **删除**：`areaNames`、`seatBinding`、`PlannedTable`、`PlannedArea`、`plannedAreas`、`SyncTable`、`SyncStep`、`planSyncSteps`、`syncPending`、`placeFree`。

### 3.2 员工端 `src/pages/staff/tables/index.tsx`

**删掉整个「布局管理」模式**：`management` 状态、「布局管理 / 返回营业模式」切换、创建区域、保存区域、加桌、保存桌位、取消编辑、拖格子（`movable-view`、`gridX/gridY/seats` 表单）、「按平面图同步」按钮、`syncSteps/pendingSteps/syncCounts/applyPlan/confirmPlan`。

**保留**：实时连接横幅、区域筛选（改为按 `zone`）、状态筛选（全部/空闲/使用中/需关注）、「桌位列表 / 平面图」切换、开台入口。

**改**：「平面图」标签页改成渲染 `plan.jpg` + 20 个热区，按状态着色（与顾客端同一套底图与坐标，不再是网格）。每张桌的卡片上加**「停用 / 启用」**开关，调 `staffApi.updateTable(id, { enabled })`；后端会拒绝停用正在使用或有未到店预约的桌（现有 409 `table_occupied` / `table_reserved`），错误原样展示。

历史残留桌迁移后已不存在，无需「隐藏」逻辑。

### 3.3 `src/services/staff.ts`

删 `createArea / updateArea / createTable`；`updateTable` 的入参类型收窄为 `{ enabled: boolean }`；`ServiceTable` 加 `code / zone`，删 `gridX / gridY`；`FloorArea` 删 `gridColumns / gridRows / locked`。

### 3.4 顾客端 `src/pages/customer/reservations/index.tsx`

- `offPlan`（图不可用时「按桌号选座」的兜底列表）**删除**——它存在的唯一理由是平面图可能与门店对不上，固定之后不再有这种状态。`mapping.blocked` 时只显示 `SectionEmpty` + 重试。
- 顾客点热区订的是 `seatNumber: 1`；`people` 来自 `zone.seatsPerUnit`；文案「双人位 · 可坐 2 人 · 整桌预约」不变。
- 停用的桌在图上画成不可点（灰），与「当天已约满」区分开（用不同标签，例如「暂停使用」）。

### 3.5 顾客端 `src/pages/customer/experience/index.tsx`（扫码入座）

顺带修一个 2026-09-19 遗留的小口子：列座位时若 `table.wholeTable` 只列 1 号座。后端已会拒 2 号座，但空桌时界面仍会摆两个按钮让人选。

### 3.6 `src/services/membership.ts`

`Table` 加 `code / zone`，删 `gridX / gridY`。

## 4. 一次性迁移 `pindou-backend/internal/storage/migrations/006_fixed_layout.sql`

服务启动自动跑，但**必须停服后再部署新二进制**（`records.go` 只在启动时 Load 一次，且 Save 拒绝删行——所以删除只能发生在它加载之前）。

```sql
-- 006 桌位布局固定化：加稳定编码；删除不在布局里的历史残留（业主决定：完全删）。
BEGIN;

ALTER TABLE service_tables ADD COLUMN code text;

-- ① 给 20 张真桌回填编码：区域名 + 桌号。
UPDATE service_tables t SET code = z.key || t.number
FROM floor_areas a
JOIN (VALUES ('A 区','A'),('B 区','B'),('C 区','C'),('E 区','E')) AS z(name,key) ON z.name = a.name
WHERE t.floor_area_id = a.id
  AND t.enabled
  AND NOT (a.name = 'A 区' AND t.number IN (3,4));

-- ② 历史残留（2026-09-19 线上核对）：
--    区域「1」两张桌（各挂 1 个 2026-09-07 已结算会话，无订单无预约）、
--    区域「包间」一张桌、A 区 3/4 号桌（图上只有两个位置，早已停用）。
--    外键顺序：seats/splits/sessions → tables → areas。
WITH legacy AS (
  SELECT t.id FROM service_tables t JOIN floor_areas a ON a.id = t.floor_area_id
  WHERE a.name IN ('1','包间') OR (a.name = 'A 区' AND t.number IN (3,4))
)
DELETE FROM service_table_seats  WHERE service_table_id IN (SELECT id FROM legacy);
WITH legacy AS ( /* 同上 */ ) DELETE FROM service_table_splits WHERE service_table_id IN (SELECT id FROM legacy);
WITH legacy AS ( /* 同上 */ ) DELETE FROM venue_sessions       WHERE service_table_id IN (SELECT id FROM legacy);
WITH legacy AS ( /* 同上 */ ) DELETE FROM service_tables       WHERE id IN (SELECT id FROM legacy);
DELETE FROM floor_areas WHERE name IN ('1','包间');

-- ③ 收口：编码必填唯一。此时若还有 code 为空的行，迁移失败，说明线上状态与本文核对时不同，停下来人工看。
ALTER TABLE service_tables ALTER COLUMN code SET NOT NULL;
ALTER TABLE service_tables ADD CONSTRAINT service_tables_code_key UNIQUE (code);

COMMIT;
```

`WITH legacy` 要在每条 DELETE 前重复写（Postgres 的 CTE 只作用于紧随的一条语句）。

**这一步会删掉 2 条已结算会话**，是业主「完全删」决定的直接后果，已核对无订单、无预约、无资产流水挂在上面。删之前的 `pg_dump` 是唯一的回退路径。

## 5. 部署顺序

1. 本地：`make verify` 全绿（含新门禁）。
2. 服务器：`pg_dump -Fc` 到 `/var/backups/pindou/postgres/predeploy_<stamp>.dump`，`pg_restore -l` 确认可读。
3. `systemctl stop pindou-api`；`cp -a` 旧二进制为 `.prev-<stamp>`。
4. 部署新二进制，`systemctl start`。启动即跑迁移 006 + 启动校正。
5. 验：`/healthz` `/readyz` 200；日志有 `layout reconciled`；`psql` 查 `service_tables` 恰好 20 行、`code` 全非空、`floor_areas` 恰好 4 行。
6. 旧版小程序此时仍能用（GET 不变；它的「布局管理」按钮会收到 405，短窗口可接受）。
7. 小程序：`cli preview --info-output` **先看体积表**（`/pages/customer/` 应约 450 KB，否则是图片没进包，见 `tests/upload-packing.test.cjs` 的注释），再 `cli upload`。体验版自动跟最新上传。

**回退**：换回 `.prev` 二进制即可运行（旧代码不认识 `code` 列但也不会碰它）。但残留数据已删——要连数据一起回退只能 `pg_restore` 第 2 步的备份。

## 6. 门禁（都要按「变异会红」验过再算完成）

### 后端 `internal/app/layout_test.go`
- 嵌入副本与仓库根 `layout/store-layout.json` **字节相同**。
- 20 张桌、`code` 唯一、`code == zone+number`、`wholeTable == (seatCount>1)`、`seatCount == zone.seatsPerUnit`。
- `reconcileLayout` 在空库上建出 4 区 20 桌；再跑一遍 0 改动。
- 库里多一张布局外的桌 → 拒绝启动，错误里带它的编号。
- 有进行中会话坐在将被缩掉的座号上 → 拒绝启动。
- `PATCH /service-tables/{id}` 带 `seatCount` → 400 `layout_fixed`；只带 `enabled` → 200。
- `POST /service-tables`、`POST /floor-areas`、`PATCH /floor-areas` → 405。

### 前端
- `tests/layout.test.cjs`（新）：热区数 == 桌数 == 20；每个热区在 `plan` 尺寸内；`code` 唯一。
- `tests/seatmap.test.cjs`：**删**同步系列（the sync plan creates…、created layout accepted…、already matching…、disables tables…、never shrinks…、area the plan does not know…、locked area…、cells taken…）、五分支禁用词测试改成单分支、**删**「不许矛盾」一致性门禁（单一真相之下没有两个函数可矛盾）。**留**：every plan seat resolves…、same table number in different areas…、shuffled order…、a two-person unit is a two-seat whole-table…（改成核对 `code`）、blocked 文案禁用词。
- `tests/reservations.test.cjs`：**删**「fallback table list never splits a whole-table unit」和「seats the floor plan does not draw are not offered」（兜底列表已删）；其余夹具从 `planSyncSteps` 改成直接按布局造 20 张桌。
- `tests/staff.test.cjs` / `ui-workflows.test.cjs`：删布局管理相关断言；加「停用/启用开关调用 `updateTable(id,{enabled})`」一条。
- `tests/e2e/nav.mjs`：不变（路由没动）。
- `tests/upload-packing.test.cjs`：不变。

## 7. 验收（真机口径）

1. 员工端「桌位」页：20 张桌、按区筛选、无「布局管理」入口；「平面图」标签画出底图与热区。
2. 停用 B3 → 顾客端平面图上 B3 变灰「暂停使用」、不可点；启用 → 恢复。
3. 顾客端预约页：平面图直接可用，无「平面图暂不可用」；A1 显示「双人位 · 可坐 2 人 · 整桌预约」。
4. 12 条真点击跳转（`npm run e2e:nav`）全绿。
5. `psql`：`service_tables` 20 行、`floor_areas` 4 行、区域「1」「包间」不存在。

## 8. 预估

约一天。新增：布局文件 1 个、`layout.go` 约 120 行、`layout_test.go` 约 150 行、前端 `layout.test.cjs` 约 40 行、迁移 1 个。删除：前端约 500 行、后端约 200 行、测试十余条。

## 9. 执行时不要做的事

- 不要为了「以后可能换布局」保留任何动态编辑入口。业主明确要固定；要换布局就改文件重新部署。
- 不要用 API 或应用代码去删残留——`records.go` 的保存守卫会拒绝，绕过它等于拆掉数据一致性的最后一道锁。只能走迁移 006。
- 不要在启动校正里「顺手」修 `Enabled`。它是唯一的运营状态，归店员。
- 不要跳过第 5 步第 7 条的 `preview` 直接 `upload`。体验版自动跟最新上传，传上去就是对外的。
