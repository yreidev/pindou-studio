# 计划：各角色 UI/UX 走查问题的修法

> 2026-09-19 制定。依据是当晚 21:00–21:06 以「老板」身份对 23 个页面的采图
> （`pindou-miniapp/.e2e-shots/`，体验版 2.3.x），加上对应代码的核对。
> 没验到的：游客态（当前已登录，注册页直接跳回首页）、店员/店长视角（切身份只能点浮标）。
>
> 编号沿用走查报告的 1–23。🔴 影响完成任务 🟡 绕得过去但费劲 ⚪ 观感/一致性。
>
> **进度**：第 1、2 批已上线（体验版 2.4.0，业主真机确认无问题）。第 3 批已实现，待上传。
> #9 业主已定为不改（A/B/C/E 是店里真实编号，D 是别的区域，后期可能更新）。
> 字体子集 172 → 176 字，28.3 → 29.2 KB（新增「开台」等 4 字，来自开台页新增的 `StaffScreen title`）。

## 0. 怎么分批

按「改动范围」而不是按角色分：**只动小程序、且不需要产品拍板的先做**；
要改后端的、要业主决定的放最后。每一批一次提交、`npm test` 全绿、
`npm run preview` 核体积表、对涉及页面重新采图，再传体验版。

三条不变的约束：金额仍是整数分；权限判断仍在后端；改后端持久化的必跑
`make backend-test-db`（见 memory `pindou-db-tests-skip-silently`）。

## 1. 第一批：纯小程序、不需要拍板（约半天）

| # | 问题 | 改法 | 落点 | 测试 |
|---|---|---|---|---|
| 1 🔴 | 订单卡没时间 | 后端 `Order` 早就带 `createdAt`（`orders/domain/order.go:51`），只是小程序 `Order` 类型漏了。补字段，顾客卡片页脚左侧显示 `storeClock` 日期时间，员工行标题后面加时间。 | `services/customer.ts:12`、`components/customer/index.tsx:240`、`pages/staff/orders/index.tsx:225` | `orders.test.cjs` 断言卡片含日期；`responsive.test.cjs` 员工行 |
| 2 🟡 | 预约页默认「今天」，晚上必红字 | `dayISO` 初值改为 `days` 里第一个 `openSlots` 非空的日子；找不到才落今天。红字 `field-error` 改中性 `field-help`，文案二选一：已切日 →「今天的可约时段已过，已切到 X 月 X 日」；7 天全空 →「近 7 天没有可约时段」。删掉「可能超出 7 天」那半句——日期条只给 7 天，这个分支从 UI 进不去。 | `pages/customer/reservations/index.tsx:69,293` | `reservations.test.cjs` 加：TZ 晚间 21:30 打开 → 默认日期是明天，无红字 |
| 3 🟡 | 已登录还写「免费注册」 | banner 里读 `useCustomer()`；匿名保留原句，已登录换成「门店发布权益后会在这里展示」（与示例工坊社页同一句），有已发布权益时不显示这行。 | `components/customer/membership-banner.tsx:39` | `index.test.cjs` 两态 |
| 7 ⚪ | 无参错误动作不对 | 订单详情：`navigateBack` 有上一页就返回，否则首页。结账页：`缺少订单编号` 时不给「重新加载」，给「返回订单列表」。 | `pages/customer/order-detail`、`pages/staff/checkout/index.tsx:38,103` | 现有 Status 测试加分支 |
| 8 ⚪ | 作品墙单列 | 复用首页两列的 `.gallery-grid` 样式；卡片改缩略图上、标题下。纯 CSS。 | `pages/customer/gallery/index.tsx` + scss | 采图 |
| 12 🟡 | 开台开始时间有日期选择器但只许当天 | 删日期 Picker，只留时间；`startedAt` 日期固定门店今日。后端 `tables.go:240` 附近本来就只收当日，不动。 | `pages/staff/session-start/index.tsx:150-168` | `responsive.test.cjs` |
| 13 🟡 | 「会话 · 号桌」空串 | 有桌号才拼「· X号桌」，否则标题就叫「会话」。 | `pages/staff/session-detail/index.tsx:66` | 单测标题 |
| 14 🟡 | 「脱敏手机号」vs「手机尾号」 | 统一「昵称或手机尾号」。店员看到的本来就是脱敏号，能输的只有尾号。**先确认后端搜索是后缀匹配**（`membership.go` 查账号那段），不是才改。输入框 + 下拉两个控件：下拉保留（选中用），输入框改成「过滤」语义，placeholder 说清「输入后在下方选择」。 | `pages/staff/membership/index.tsx`、`session-start/index.tsx:75` | 现有测试改字面量 |
| 16 ⚪ | 员工订单行状态两遍 | 右下那格：`draft` 显「应收」，其余不显；状态只在标题一处。 | `pages/staff/orders/index.tsx:239` | — |
| 19 🟡 | 平面图 A1/A2 像「需关注」 | 底图 A 区自带粉色，`staff-plan-free` 40% 透明压不住。四个状态色 alpha 提到 .80，或给 `.staff-plan-hit` 加一层 `ui.$canvas` 底再叠状态色。**换底图不做**——顾客端同一张图，不想维护两份。 | `styles/staff.scss:170-174` | 采图对比 A 区与 B 区 |
| 21 ⚪ | 自己那行能点「撤销」 | `assignment.accountId === auth.account.id` 时不渲染撤销按钮，显「本人」。后端 last-owner 保护不动。 | `pages/staff/roles/index.tsx:191` | `roles` 测试 |
| 22 🟡 | 身份浮标压内容 | 默认位 `savedPosition.y` 0.65 → 1（`bounds()` 已把底栏 80PX 扣掉，y=1 正好停在底栏上方）；用户拖过的位置本来就记着。 | `components/developer-status.tsx:9` | — |

这批做完传一版体验版，业主看 2 / 19 / 22 三处观感。

## 2. 第二批：员工端流程（约一天，其中 17 / 18 要业主点头）

| # | 问题 | 改法 | 落点 | 测试 |
|---|---|---|---|---|
| 10 🔴 | 开台页不显示开哪张桌；无参时警告不见 | ① 页顶加一行「桌位」卡：`X号桌 · N座（· 整桌）`，数据从 `tableNumber` 参数来（`tables/index.tsx:113` 已传），座位数再从 `tables` 资源里按 id 找。② 无 `tableId` 时不渲染整张表单，渲染 `Status`「先在桌位页选一张桌 → 去桌位页」。③ `:171` 那条 `staff-notice` 为什么截图里没出现，**先在开发者工具里开一次无参页面看 DOM**，再决定是删（被②替代）还是修。 | `pages/staff/session-start/index.tsx:72,171` | `responsive.test.cjs` 加无参分支；有参分支断言桌号可见 |
| 11 🟡 | 时长不带价格 | 事实：计价发生在**结账时店员选商品**（「计时收费」是商品名，不在代码里），时长只管计时器。所以不在 chips 上编价格。改法：读 `loyalty.public()` 里的套餐规则，时长与某个已发布套餐相同的 chip 附上套餐名与价（「60 分钟 · 1小时 ¥29.90」），其余 chip 不带价；chips 下面一句 `field-help`「实际收费在结账时按商品/套餐计」。不动后端。 | `session-start/index.tsx:31,120-130` | 单测：有套餐 60 分钟带价，90 分钟不带 |
| 15 🟡 | 「取消或爽约的原因」全局文本框 | 删页顶文本框；点某条的「取消」/「爽约」时 `Taro.showModal({ editable: true, placeholderText: '原因（可不填）' })`，`content` 回填 `reason`。基础库 ≥2.17.1 支持 `editable`，项目要求的基础库版本够（`project.config.json` 核一眼）。 | `pages/staff/reservations/index.tsx:47,225,234,300` | 现有 reservations 员工测试改流程 |
| 17 🟡 | 工作台大按钮按角色给低频动作；「预约到店」重复 | 大按钮对**所有角色**都是「计时开台 / 订单收款」——这是店里一天最频的两件事，老板自己也干。店长/老板多出来的（规则、员工、盘点）留在下面的经营管理格。大按钮和格子去重。 | `pages/staff/workbench/index.tsx:40-75` | `responsive.test.cjs` 三角色各断言 |
| 18 🟡 | 「会员与计时」4 tab 折两行；「经营设置」藏在会员页 | 先做零风险的：tab 文案缩到两字「会员 / 计时 / 结账 / 规则」，一行放得下（`staff-tab min-width 64PX`×4 + gap 在 375 宽够）。工作台「规则发布」同步改「规则」。拆成独立页留到有第五个 tab 再说。 | `pages/staff/membership/index.tsx:285-292`、`workbench:62` | 采图 375 宽一行 |
| 20 ⚪ | 名字漂移 | 定一张表，工作台标签、页面标题、tab 标签三处对齐：桌位 / 订单 / 会员与计时 / 预约 / 库存 / 运营（报表·审计·备份）/ 员工权限。「桌位与原有会话」→「桌位」；「财务报表与备份 / 与审计」→「运营」；「库存管理 / 采购入库 / 库存盘点」→「库存」，角色差异用副标题不用改名。 | `workbench:40-58`、各 `StaffScreen title` | `font-subset` 测试会因 title 变动重跑，记体积 |
| 23 ⚪ | 「实时连接 更新 21:04:24 刷新」占一行 | 压成一行 24PX：左「● 21:04」，右「刷新」文字按钮；断线时才放大成整行提示。 | `components/staff.tsx` 的 `resource-freshness` + `staff.scss:120` | 采图 |

## 3. 第三批：要后端或业主决定（约一天 + 一次后端部署）

| # | 问题 | 改法 | 落点 | 测试 |
|---|---|---|---|---|
| 4 🟡 | 手机号「未验证」是死胡同 | 后端 `PATCH /accounts/{id}`（`identity.go:305`）现在只收 `phone` 且一律置 `unverified`。加 `phoneCode`：走 `s.wechat.ExchangePhone`，置 `verified`，逻辑照 `createUser:169-185` 抄，`phone` 与 `phoneCode` 互斥同注册。小程序 `updateProfile` 加 `phoneCode`；编辑页在 `wechatPhoneAuthorizationEnabled` 时先给「获取微信手机号」按钮，手输退为「手动填写」链接，和注册页一致。「我的」页的「未验证」标签变成可点，跳编辑页。 | `identity.go:305-350`、`services/customer.ts:329`、`pages/customer/profile-edit`、`pages/profile:637` | `identity_test.go` 加 phoneCode 用例；`profile-edit` 单测两态 |
| 5 🟡 | 「本次手作」两跳才扫码 | 把 `experience/index.tsx:81` 的扫码 + 解析桌码抽成 `services/table-code.ts`；首页主卡直接调它，成功后带参进 experience 页；experience 页保留「重新扫描」。没有进行中会话时首页主卡文案改「扫码入座」。 | `pages/index/index.tsx:63`、`pages/customer/experience` | `experience` 单测改为测 service；首页测试断言主卡不再 navigateTo |
| 6 ⚪ | 示例工坊社页主按钮是「本次手作」 | **要业主定**这一页的主动作。我的建议：金按钮撤掉；资产卡下加一句「充值、积分兑换请到店由店员办理」；「本次手作」降为底部文字链。若以后有会员码（给店员扫的），主按钮给它。 | `pages/customer/membership/index.tsx` | — |
| 9 ❓ | 分区没有 D | **业主已答：A/B/C/E 是店里真实编号，D 安排给了别的区域。不改。** 后期若更新编号，`store-layout.json` 两份 + 底图一起改。 | — | — |

### 第三批实施记录（2026-09-19 夜）

- **#4**：`PATCH /accounts/{id}` 加 `phoneCode`。换号在**上锁之前**做（外部网络请求不能占着
  store 的锁）；`phone` 与 `phoneCode` 互斥（400）；**代改他人不能用 phoneCode**（403）——
  那张 code 是本人微信给的，换出来的号会写到别人账上；`s.wechat == nil` 时跳过换取，
  与注册 `createUser` 保持一致，否则本地能改的线上改不了。手输号仍然 `unverified`，
  已验证的号再手输一个会退回 `unverified`（不能靠改号把验证状态带过去）。
  测试：`internal/app/identity_profile_test.go`。契约：`docs/api.yaml` 的 `AccountUpdateInput`。
- **#5**：扫码抽成 `src/services/table-code.ts`。抽出来的理由不只是复用 ——
  在页面里时它被相机挡着根本测不到，抽出来才验得了「别家的码不能瞎猜一个 ID」
  「取消不是错误」「相机打不开不能被当成取消吞掉」。首页主卡没登录先去登录；
  扫不出来时给一条「手动进入本次手作」，否则顾客卡在首页。
- **#6**：按上面第 3 条执行。

## 4. 不做的

- **不给员工端换底图**。顾客端和员工端同一张 `plan.jpg`、同一套坐标，是「店员看到的位置就是顾客看到的位置」这个承诺的基础；A 区透色用 alpha 解决。
- **不把「会员与计时」拆页**（本轮）。四个两字 tab 一行放得下；拆页要动 `?view=` 深链和工作台两处入口，收益不够。
- **不在开台页编价格**。计价点在结账，开台页只能「引用」已发布套餐的价，不能另算一套。
- **不改员工权限的后端**。last-owner 保护已有测试，前端藏按钮即可。

## 5. 验收

每批：`npm test` → `npm run preview` 看体积表（主包不得因 title 改动多出 1 KB 以上的字体子集）→
按下表采图 → 传体验版。

| 批 | 采图页 | 看什么 |
|---|---|---|
| 1 | 01 首页、02 订单、07 预约、11 作品墙、14 桌位、15 开台、17 员工订单、21 权限 | 时间有了；晚间预约页无红字且默认明天；A 区和 B 区同色；浮标在右下 |
| 2 | 13 工作台×3 角色、12 会员与计时、15 开台（有参/无参）、22 预约 | tab 一行；开台页顶有桌号；取消预约弹输入框 |
| 3 | 03 我的、10 编辑资料、05 示例工坊社、01 首页 | 微信取号按钮；首页主卡直接扫码 |

第 2 批的三角色采图需要你在浮标上切身份，我不动浮标；切好告诉我，我只跑 `staff` 那组。

## 6. 业主已定（2026-09-19 晚）

1. **#17** 同意：大按钮全角色统一「计时开台 / 订单收款」。
2. **#18** 由我定：先缩成两字 tab，不拆页。
3. **#6** 业主让我按自己的判断做：撤掉金按钮「本次手作」，资产卡下加一句
   「充值、积分兑换请到店由店员办理」，「去本次手作」降为底部文字链。主位先空着，
   留给以后的会员码（顾客亮码、店员扫一下调出账户）。
4. **#9** A/B/C/E 是店里真实编号，D 是别的区域；**不改**。后期若更新编号，`store-layout.json` 两份 + 底图一起改。
