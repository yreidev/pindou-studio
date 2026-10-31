---
name: billing-lookup
description: 改计费、账单行、套餐定价、超时加收、自由计时价、陪客费、免单或状态显示。当涉及 session_billing、charge.go、自动生成账单行、续时、过期状态时使用。
---

# 计费：查表，不算价

- 计价规则（纯函数、表驱动测试）：`pindou-backend/internal/modules/tables/domain/charge.go`
- 接到会话与订单上：`pindou-backend/internal/app/session_billing.go`（`sessionCharge`、`followTime`）、`tables.go` 的 `followDraft`

## 唯一规则

**价格只能从已发布的规则里查出来，永远不自己算。**

价来自老板发布的四种规则：计时套餐（价、续时方案、超时处理与宽限）、自由计时价（每 30 分钟 ¥X）、陪客费。
对不上任何已发布的价时，账单行写 `UnitPriceCents: 0` 并把时长写进名字（`计时 87 分钟`、`自由计时 · 已用 25 分钟`），让店员手填——**不要按分钟单价推算一个金额出来**。推算出来的数字看着合理，但它不是门店定的价，收错钱没人能发现。

`WholeTableCharge` 的分支顺序：陪客（陪客费，没有时 0 元）→ 自由计时（自由计时价分块，没有时 0 元占位）→ 整套餐 `packageFor` → 套餐加续时 `renewalPackageFor` → 兜底 0 元带时长。套餐命中后按它的超时处理：`renewal` 超过宽限才按续时方案整段分块加收，`free`、`manual` 不自动加。按座会话用 `SeatCharge`，按入座时的套餐快照。

边界按整分钟（业主 2026-10-06 定，`wholeMinutes`）：使用时长、超时时长先向下取整到整分钟、零头不算，再比。宽限 10 分钟时超时 10:59 不收、11:00 收 1 块；30 分钟一块时 30:59 一块、31:00 两块。说明里写的也是这个整分钟数。表驱动测试每条边界都有「差 1 秒」「刚好整分」两例。

## 按哪一版价

- 按座会话：入座申请里的套餐快照（`admission.Package`）。
- 整桌会话：开台时记在会话 state 里的整份价表 `TableSession.Tariff`（`tariffOf(当时的 Rules())`，各套餐含续时与超时、自由计时价、陪客费），`wholeTableTariff` 取它；之后改价发布不影响这一台，续时、改时长、改计时方式、标陪客都按它算。`nil` 是 2026-10-06 之前开的旧会话（或滚动发布时被旧版本改写过的），退回按此刻生效的规则。价表不进接口响应（`sessionOut`），不加列不加迁移。

## 停止计时

按座会话走 `/loyalty/actions` 的 `stop`，整桌会话走 `PATCH /venue-sessions/{id}` 的 `stop: true`（幂等键必带、单独提交，陪客不能停）。都只是记 `StoppedAt`、状态仍是 `active`；`chargeTime` 取它，计价冻结，停的那一刻读一次 `ordersOfSession` 把草稿按停止时刻存下。停了以后整桌会话的暂停、继续、续时、改计时、标陪客都 409，换桌、撤销、结账照旧。桌位视图的 `stopped` 表示桌上的会话都停了（小程序桌位页写「待结账」）。

## 草稿跟着计时走

订单的 `AutoLines` 记开头几行是系统生成的计时明细。改计时由 `followDraft` 换、时间流逝由 `followTime` 在每次读出草稿时换（只读请求不落库；测「存下了」要直接查 `sales_orders.receivable_cents`，读订单会再按此刻算一遍）；员工改过记 0 不再改；nil 是 0.0.18 的旧草稿，只在改计时时按建单时刻比对。0 元占位行不随时间改（名字里的分钟一直变，会让员工保存撞版本冲突）。

## 显示态在读的时候算，不要存

`Reservation.Display(now, grace)` 和 `Admission.Display(now)` 都是读时派生；入座申请 pending 超过 30 分钟就是 `expired`。API 出 `displayStatus` 字段，前端只认它。**不要写后台任务去改写状态**——过期只按当前时间派生。

## 估算金额宁可不给

`tableView` 的 `estimatedCents` 只在**恰好一个会话**且明细都有价时才带上，其余情况**整个字段省略**，不要给 0。`charge` 给后端写好的一句说明（`summary`），两端原样显示。

## 免单

免单是付款记录里 `method: comp` 的结清记录（金额是免掉的、带原因），不计入 `PaidCents`，不能退款；人工折扣仍不能把应收减到 0。分笔付款收了一部分后也能「对剩余免单」，金额是 `ordersapp.OutstandingCents`（应收 − 已收 − 免单）；`settlement: comp` 只给一分没收、整单免单的，收过钱的照常按笔退、`compCents` 写免掉多少。

## 分笔付款冻结计价

一单可以分几笔收（2026-10-06 业主定）。收第一笔还没收齐时订单是 `partially_paid`，计时停在这一刻（`freezeSession`，同停止计时），`followTime`、`draftTiming` 只认 `draft`，所以计价与明细自然冻结：之后时间再走金额不变、明细折扣改不了，收齐（已收 + 免单 = 应收）才 `paid`。查「付到一半金额怎么没跟着超时加收」先看订单状态，不是计费 bug。会员结账只能是第一笔（会员价按整单定，`offlineCents` 可只收一部分线下补付，`balanceCents` 可限定这次用多少储值，先本金后赠送），积分只按会员这一笔收到的钱送。

## 金额

整数分，折扣整数基点，禁止浮点。固定金额和比例减免都由后端算，前端只格式化。

## 配套的业主动作

套餐能不能自动定价、超时要不要自动加收、自由计时和陪客收多少，全取决于老板在「经营规则」发布了什么。**这是配置问题，不要用代码去补。**
