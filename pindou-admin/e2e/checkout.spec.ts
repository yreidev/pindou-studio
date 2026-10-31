import { expect, test, type Page } from '@playwright/test'
import { accountListResult } from './account-list'
import { mockApi, signIn } from './mock-api'
import { orderListResult } from './order-list'

// 结账与小票：规则照小程序结账页——改明细先保存、应收以接口为准；人工折扣只给店长、老板；
// 关联顾客的订单走会员结账（先报价、再按报价确认）；待结账订单能绑定、更换顾客或改散客（套餐单不能）；
// 现金可填实收、看应找零，找零由后端记在付款上；写请求带幂等键和读到的订单版本，409 保留输入、重读后由人再确认；
// 付款后打印小票（58mm、80mm、A4），只印接口给的数字（含实收现金、找零、本单结账后余额），不印手机号。
// 设了 PINDOU_ADMIN_SHOTS（目录）时顺带截图，供人自查版面，不入库。

const versionA = 'a'.repeat(64)
const versionB = 'b'.repeat(64)
const versionC = 'c'.repeat(64)
const quoteV = (n: number) => String(n).repeat(64)

const beadId = '0b0b0b0b-0000-4000-8000-000000000001'
const keyringId = '0b0b0b0b-0000-4000-8000-000000000002'
const catalog = [
  { id: beadId, name: '拼豆材料包', unitPriceCents: 2000 },
  { id: keyringId, name: '钥匙扣', unitPriceCents: 1500 },
]

const clerk = { id: 'u-clerk', nickname: '小店员', roles: ['clerk'], phoneVerificationStatus: 'verified' as const }
const manager = { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' as const }
const owner = { id: 'u-owner', nickname: '阿贝', roles: ['owner'], phoneVerificationStatus: 'verified' as const }
const li = { id: 'u-li', nickname: '小李', phoneMasked: '139****0002' }

type Line = { productId?: string; name?: string; quantity: number; unitPriceCents: number }
type MockOrder = Record<string, unknown> & {
  id: string
  version: string
  status: string
  createdAt: string
  lines: Line[]
  receivableCents: number
}

const shots = process.env.PINDOU_ADMIN_SHOTS
async function shoot(page: Page, name: string, target?: ReturnType<Page['locator']>) {
  if (!shots) return
  const path = `${shots}/${name}.png`
  if (target) {
    await target.screenshot({ path })
    return
  }
  // 后台的内容区自己滚动，整页截图截不到下面：临时把窗口拉高，截完还原
  const size = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.setViewportSize({ width: size.width, height: 1300 })
  await page.screenshot({ path })
  await page.setViewportSize(size)
}

function draftOrder(id: string, overrides: Partial<MockOrder> = {}): MockOrder {
  return {
    id,
    version: versionA,
    status: 'draft',
    receivableCents: 0,
    paidCents: 0,
    refundedCents: 0,
    refundableCents: 0,
    settlement: 'standard',
    customer: null,
    createdAt: '2026-10-05T06:00:00Z',
    lines: [],
    discounts: [],
    payments: [],
    refunds: [],
    ...overrides,
  }
}

/** 模拟后端保存明细：应收按明细重算（真实口径由 Go 测试覆盖），版本换新。 */
function saveLines(order: MockOrder, lines: Line[], version: string): MockOrder {
  return {
    ...order,
    version,
    lines,
    receivableCents: lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0),
  }
}

/** 模拟后端登记收款：已付等于应收，状态已付款，版本换新；现金带了实收就记下实收与找零（真实规则由 Go 测试覆盖）。 */
function payOrder(order: MockOrder, method: string, version: string, cashReceivedCents?: number): MockOrder {
  const tender =
    cashReceivedCents === undefined ? {} : { cashReceivedCents, changeCents: cashReceivedCents - order.receivableCents }
  return {
    ...order,
    version,
    status: 'paid',
    paidCents: order.receivableCents,
    refundableCents: order.receivableCents,
    payments: [
      { id: 'pay-1', method, amountCents: order.receivableCents, createdAt: '2026-10-05T06:30:00Z', ...tender },
    ],
  }
}

const orderHandler =
  (id: string, current: () => MockOrder) =>
  ({ method, path }: { method: string; path: string }) =>
    method === 'GET' && path === `/sales-orders/${id}` ? { status: 200, body: current() } : undefined

const catalogHandler = ({ method, path }: { method: string; path: string }) =>
  method === 'GET' && path === '/catalog-items' ? { status: 200, body: catalog } : undefined

const payButton = (page: Page) => page.getByRole('button', { name: /^确认收款/ })
/** 按标题找卡片：套餐单的说明里也有「人工折扣」几个字，按内容找会认错。 */
const cardTitled = (page: Page, title: string) =>
  page.locator('.semi-card').filter({ has: page.locator('.semi-card-header').getByText(title, { exact: true }) })

test('普通结账：店员填占位价、加商品、改数量、删行，保存后按接口的应收收现金；付款后可打印小票', async ({ page }) => {
  const orderId = '1a1a1a1a-0000-4000-8000-000000000001'
  const sessionId = '5e550000-0000-4000-8000-000000000001'
  let current = draftOrder(orderId, {
    venueSessionId: sessionId,
    lines: [
      { name: '计时 75 分钟', quantity: 1, unitPriceCents: 0 },
      { name: '误加的一行', quantity: 1, unitPriceCents: 0 },
    ],
  })
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      // 旧整桌会话（不是会员扫码入座的套餐），明细可以改
      ({ method, path }) =>
        method === 'GET' && path === `/venue-sessions/${sessionId}`
          ? {
              status: 200,
              body: {
                id: sessionId,
                serviceTableId: 'tttt0000-0000-4000-8000-000000000001',
                status: 'active',
                timingMode: 'timed',
                startedAt: '2026-10-05T05:00:00Z',
              },
            }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'PATCH' || path !== `/sales-orders/${orderId}`) return undefined
        current = saveLines(current, (body as { lines: Line[] }).lines, versionB)
        return { status: 200, body: current }
      },
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/payments`) return undefined
        const input = body as { method: string; cashReceivedCents?: number }
        current = payOrder(current, input.method, versionC, input.cashReceivedCents)
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)

  await expect(page.getByRole('heading', { name: '结账 · 订单 1a1a1a1a' })).toBeVisible()
  // 店员看不到人工折扣；散客单没有会员抵扣
  await expect(page.getByLabel('第 1 项名称')).toHaveValue('计时 75 分钟')
  await expect(cardTitled(page, '人工折扣')).toHaveCount(0)
  await expect(page.getByText(/散客单：没有绑定顾客账户/)).toBeVisible()
  await expect(cardTitled(page, '会员结账')).toHaveCount(0)
  // 占位行没填单价：不能收款，说清为什么
  await expect(payButton(page)).toBeDisabled()
  await expect(page.getByText('有明细还没填单价，填好并保存才能收款')).toBeVisible()

  // 明细的下拉框有读屏名：Semi 的下拉框丢掉 aria-label（没选时为空、选中后念 selected），名字经 aria-labelledby 接上
  await expect(page.getByRole('combobox', { name: '第 1 项商品或服务' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: '添加商品' })).toBeVisible()
  await page.getByLabel('第 1 项单价（元）').fill('80')
  await page.getByRole('button', { name: '删除第 2 项' }).click()
  await page.locator('.checkout-line-actions .semi-select').click()
  await page.getByRole('option', { name: '拼豆材料包' }).click()
  // 从目录加的商品：名称、单价预填商品资料
  await expect(page.getByLabel('第 2 项名称')).toHaveValue('拼豆材料包')
  await expect(page.getByLabel('第 2 项单价（元）')).toHaveValue('20.00')
  await page.getByLabel('第 2 项数量').fill('2')
  // 改过没保存：不显示本地估算的金额，收款按钮灰着并说明
  await expect(page.getByText('明细已改动，尚未保存')).toBeVisible()
  await expect(page.getByText('应收（保存明细后显示）')).toBeVisible()
  await expect(page.getByText('明细改过，请先保存并核对金额')).toBeVisible()
  await expect(payButton(page)).toBeDisabled()

  // 单价写错：表单拦下，不发请求
  await page.getByLabel('第 1 项单价（元）').fill('80.123')
  await page.getByRole('button', { name: '保存明细' }).click()
  await expect(page.getByText('单价须为非负金额，最多两位小数')).toBeVisible()
  // 错误挂在那一格上：标成填错，读屏聚焦时念出原因
  await expect(page.getByLabel('第 1 项单价（元）')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('第 1 项单价（元）')).toHaveAccessibleDescription('单价须为非负金额，最多两位小数')
  // 选了商品的那一行：「收款时扣库存」是下拉框的说明
  await expect(page.getByRole('combobox', { name: '第 2 项商品或服务' })).toHaveAccessibleDescription(
    '商品：收款时扣库存',
  )
  expect(api.writes).toHaveLength(0)
  await page.getByLabel('第 1 项单价（元）').fill('80')

  await page.getByRole('button', { name: '保存明细' }).click()
  await expect(page.getByText('明细已保存，请核对金额')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0]).toMatchObject({ method: 'PATCH', path: `/sales-orders/${orderId}` })
  expect(api.writes[0].body).toEqual({
    lines: [
      { name: '计时 75 分钟', quantity: 1, unitPriceCents: 8000 },
      { productId: beadId, name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
    ],
    expectedVersion: versionA,
  })
  expect(api.writes[0].idempotencyKey).toBeTruthy()

  // 应收照接口：¥120.00
  const payment = page.locator('.semi-card', { hasText: '收款登记' })
  await expect(payment.getByText('应收金额')).toBeVisible()
  await expect(payment.getByRole('radiogroup', { name: '线下收款方式' })).toHaveAccessibleDescription(
    '核实实际到账后再确认，此操作只登记收款。',
  )
  await expect(payButton(page)).toHaveText('确认收款 ¥120.00')
  // 微信、支付宝没有「实收现金」；选现金才填
  await expect(payment.getByLabel('实收现金')).toHaveCount(0)
  await payment.locator('.semi-radio', { hasText: '现金' }).click()
  await expect(page.getByRole('radio', { name: '现金' })).toBeChecked()
  // 实收少于应收：说清为什么，不能收款，不发请求
  await payment.getByLabel('实收现金').fill('100')
  await expect(payment.getByText('实收现金不能少于本次收款 ¥120.00')).toHaveCount(2)
  await expect(payButton(page)).toBeDisabled()
  // 输入框标成填错，下面那行原因挂在它上面，读屏聚焦时一起念
  await expect(payment.getByLabel('实收现金')).toHaveAttribute('aria-invalid', 'true')
  await expect(payment.getByLabel('实收现金')).toHaveAccessibleDescription('实收现金不能少于本次收款 ¥120.00')
  // 顾客给 200：应找零 80（提交前给员工点钱看）
  await payment.getByLabel('实收现金').fill('200')
  await expect(payment.getByText('应找零 ¥80.00')).toBeVisible()
  await expect(payment.getByLabel('实收现金')).toHaveAccessibleDescription('应找零 ¥80.00')
  await shoot(page, 'checkout-standard')
  await payButton(page).click()

  await expect(page.getByText('收款成功')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1]).toMatchObject({ method: 'POST', path: `/sales-orders/${orderId}/payments` })
  expect(api.writes[1].body).toEqual({
    method: 'cash',
    amountCents: 12000,
    expectedVersion: versionB,
    cashReceivedCents: 20000,
  })
  expect(api.writes[1].idempotencyKey).toBeTruthy()
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)

  await expect(page.locator('.semi-banner', { hasText: '已付款' })).toContainText('实收 ¥120.00')
  // 记下的实收与找零照接口显示
  await expect(page.locator('.semi-card tr', { hasText: '现金' })).toContainText('实收 ¥200.00 · 找零 ¥80.00')
  // 按钮直接跳转，不包在链接里（<a><button> 读屏、键盘都要走两次）
  await expect(page.getByRole('button', { name: '查看订单详情' })).toBeVisible()
  await expect(page.getByRole('button', { name: '回到待结账列表' })).toBeVisible()
  await expect(page.locator('a button, a [role="button"]')).toHaveCount(0)
  await page.getByRole('button', { name: '打印小票' }).click()
  await expect(page).toHaveURL(new RegExp(`/receipt/${orderId}$`))
  const sheet = page.getByRole('region', { name: '小票' })
  await expect(sheet).toContainText('计时 75 分钟')
  const row = (label: string) => sheet.locator('.receipt-row').filter({ has: page.getByText(label, { exact: true }) })
  await expect(row('现金')).toContainText('¥120.00')
  await expect(row('实收现金')).toContainText('¥200.00')
  await expect(row('找零')).toContainText('¥80.00')
})

test('人工折扣（店长）：比例换成整数基点、必须写原因；409 保留输入，重新读取后由人再确认，换新版本与幂等键', async ({
  page,
}) => {
  const orderId = '2b2b2b2b-0000-4000-8000-000000000002'
  let current = draftOrder(orderId, {
    receivableCents: 10000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
  })
  let discountPosts = 0
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/discounts`) return undefined
        discountPosts++
        if (discountPosts === 1) {
          // 就在这时，有人在手机上加了一包材料
          current = saveLines(
            current,
            [...current.lines, { productId: beadId, name: '拼豆材料包', quantity: 1, unitPriceCents: 2000 }],
            versionB,
          )
          return { status: 409, body: { code: 'order_version_conflict', message: '订单已被修改，请重新读取并确认' } }
        }
        const input = body as { rateBasisPoints: number; reason: string }
        current = {
          ...current,
          version: versionC,
          receivableCents: 10800,
          discounts: [
            {
              id: 'd1',
              kind: 'percentage',
              rateBasisPoints: input.rateBasisPoints,
              reason: input.reason,
              createdAt: '2026-10-05T06:10:00Z',
            },
          ],
        }
        return { status: 201, body: current }
      },
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/payments`) return undefined
        current = payOrder(current, (body as { method: string }).method, 'd'.repeat(64))
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, manager)
  await page.goto(`/checkout/${orderId}`)

  const card = cardTitled(page, '人工折扣')
  await expect(card).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥100.00')

  // 固定金额 0 元、没写原因：拦下，不发请求
  await card.locator('.semi-radio', { hasText: '固定金额' }).click()
  await card.getByLabel('减免金额（元）').fill('0')
  await card.getByRole('button', { name: '应用折扣' }).click()
  await expect(card.getByText('请填写减免金额（元，最多两位小数）')).toBeVisible()
  await expect(card.getByText('请填写折扣原因')).toBeVisible()
  // 标题、说明、错误都接在输入框上；两种方式是一组有名字的单选
  await expect(card.getByRole('radiogroup', { name: '折扣方式' })).toBeVisible()
  await expect(card.getByLabel('折扣原因')).toHaveAttribute('aria-invalid', 'true')
  await expect(card.getByLabel('折扣原因')).toHaveAccessibleDescription('请填写折扣原因')
  await expect(card.getByLabel('减免金额（元）')).toHaveAccessibleDescription(
    '直接减免的金额，单位为元 请填写减免金额（元，最多两位小数）',
  )
  expect(api.writes).toHaveLength(0)

  // 会把应收减到 0 的（固定减免不少于应收、减免 100%）填的时候就说明、不给提交：应收为 0 收不了款，整单不收钱要用免单
  const zeroHint = card.getByText('这样会把应收减到 0')
  await card.getByLabel('减免金额（元）').fill('100')
  await expect(zeroHint).toBeVisible()
  await expect(card.getByLabel('减免金额（元）')).toHaveAccessibleDescription(/这样会把应收减到 0/)
  await expect(card.getByRole('button', { name: '应用折扣' })).toBeDisabled()
  await card.getByLabel('减免金额（元）').fill('99.99')
  await expect(zeroHint).toHaveCount(0)

  // 换回比例：数值清空（10 元和 10% 不是一回事）
  await card.locator('.semi-radio', { hasText: '比例减免' }).click()
  await expect(card.getByLabel('减免百分比')).toHaveValue('')
  await card.getByLabel('减免百分比').fill('100')
  await expect(zeroHint).toBeVisible()
  await card.getByLabel('减免百分比').fill('10')
  await expect(zeroHint).toHaveCount(0)
  await card.getByLabel('折扣原因').fill('老顾客')
  await card.getByRole('button', { name: '应用折扣' }).click()

  await expect(page.locator('.semi-banner', { hasText: '订单已被修改' })).toBeVisible()
  await expect(card.getByLabel('减免百分比')).toHaveValue('10')
  await expect(card.getByLabel('折扣原因')).toHaveValue('老顾客')
  await expect(card.getByRole('button', { name: '应用折扣' })).toBeDisabled()
  await expect(payButton(page)).toBeDisabled()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toEqual({
    kind: 'percentage',
    rateBasisPoints: 1000,
    reason: '老顾客',
    expectedVersion: versionA,
  })

  // 绝不自动重提：重新读取后看到别人加的那包材料，由人再点一次
  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(page.locator('.semi-banner', { hasText: '订单已被修改' })).toHaveCount(0)
  await expect(page.getByLabel('第 2 项名称')).toHaveValue('拼豆材料包')
  await expect(payButton(page)).toHaveText('确认收款 ¥120.00')
  expect(api.writes).toHaveLength(1)

  await card.getByRole('button', { name: '应用折扣' }).click()
  await expect(page.getByText('折扣已应用')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toEqual({
    kind: 'percentage',
    rateBasisPoints: 1000,
    reason: '老顾客',
    expectedVersion: versionB,
  })
  expect(api.writes[1].idempotencyKey).toBeTruthy()
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)

  // 减多少由后端算：应收换成接口给的 ¥108.00，折扣列在收款卡片里，表单清空
  const payment = page.locator('.semi-card', { hasText: '收款登记' })
  await expect(payment.getByText('已减免 · 按比例减免 10% · 老顾客')).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥108.00')
  await expect(card.getByLabel('减免百分比')).toHaveValue('')
  await shoot(page, 'checkout-discount')

  // 默认微信收款：没有实收现金
  await expect(page.getByLabel('实收现金')).toHaveCount(0)
  await payButton(page).click()
  await expect(page.getByText('收款成功')).toBeVisible()
  expect(api.writes[2].body).toEqual({ method: 'wechat', amountCents: 10800, expectedVersion: versionC })
})

test('计时费说明与免单（店长）：照接口显示超时加收；免单必须写原因、先确认，记成免单结清、实收 0', async ({ page }) => {
  const orderId = '2c2c2c2c-0000-4000-8000-000000000009'
  const timing = {
    kind: 'package',
    summary: '超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块',
    usedSeconds: 85 * 60,
    overtimeSeconds: 25 * 60,
    graceMinutes: 10,
    blockMinutes: 30,
    blockCents: 1500,
    blocks: 1,
    totalCents: 4490,
    applied: true,
  }
  let current = draftOrder(orderId, {
    receivableCents: 4490,
    autoLines: 2,
    timing,
    lines: [
      { name: '1小时', quantity: 1, unitPriceCents: 2990 },
      { name: '1小时 · 超时加收', quantity: 1, unitPriceCents: 1500 },
    ],
  })
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/comps`) return undefined
        // 结清后不再是计时会话的草稿：后端不再带计时说明
        const rest = { ...current }
        delete rest.timing
        current = {
          ...rest,
          version: versionB,
          status: 'paid',
          settlement: 'comp',
          compCents: 4490,
          payments: [
            {
              id: 'comp-1',
              method: 'comp',
              amountCents: 4490,
              reason: (body as { reason: string }).reason,
              createdAt: '2026-10-06T06:30:00Z',
            },
          ],
        }
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, manager)
  await page.goto(`/checkout/${orderId}`)

  // 计时费由后端算好：说明原样显示
  await expect(page.getByText('计时费 ¥44.90（系统按计时算）')).toBeVisible()
  await expect(page.getByText('超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块。')).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥44.90')

  const card = cardTitled(page, '免单')
  await card.getByRole('button', { name: '免单结清' }).click()
  await expect(card.getByText('请填写免单原因')).toBeVisible()
  await expect(card.getByLabel('免单原因')).toHaveAttribute('aria-invalid', 'true')
  expect(api.writes).toHaveLength(0)

  await card.getByLabel('免单原因').fill('老顾客生日，店长同意免单')
  await card.getByRole('button', { name: '免单结清' }).click()
  const dialog = page.getByRole('dialog', { name: '免单 ¥44.90？' })
  await expect(dialog).toContainText('不能退款，也不能改回收款')
  // 先取消：什么都不发
  await dialog.getByRole('button', { name: '取消' }).click()
  expect(api.writes).toHaveLength(0)

  await card.getByRole('button', { name: '免单结清' }).click()
  await page.getByRole('dialog', { name: '免单 ¥44.90？' }).getByRole('button', { name: '确认免单' }).click()
  await expect(page.getByText('已免单 ¥44.90')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].path).toBe(`/sales-orders/${orderId}/comps`)
  expect(api.writes[0].body).toEqual({ reason: '老顾客生日，店长同意免单', expectedVersion: versionA })
  expect(api.writes[0].idempotencyKey).toBeTruthy()

  // 结清后：标明免单、免掉的金额与原因，实收 0
  await expect(page.getByText('已免单结清')).toBeVisible()
  await expect(page.getByText('免单 ¥44.90，实收 ¥0.00。原因：老顾客生日，店长同意免单')).toBeVisible()
  await shoot(page, 'checkout-comp')
})

test('店员看不到免单入口（后端也拒绝）', async ({ page }) => {
  const orderId = '2c2c2c2c-0000-4000-8000-00000000000a'
  const current = draftOrder(orderId, {
    receivableCents: 4490,
    lines: [{ name: '1小时', quantity: 1, unitPriceCents: 4490 }],
  })
  await mockApi(page, { account: clerk, handlers: [orderHandler(orderId, () => current), catalogHandler] })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)
  await expect(payButton(page)).toHaveText('确认收款 ¥44.90')
  await expect(cardTitled(page, '免单')).toHaveCount(0)
})

// ---- 会员结账 ----

const memberOrderId = '3c3c3c3c-0000-4000-8000-000000000003'
const admissionSessionId = '5e550000-0000-4000-8000-000000000003'

function memberDraft(): MockOrder {
  return draftOrder(memberOrderId, {
    accountId: li.id,
    customer: li,
    venueSessionId: admissionSessionId,
    receivableCents: 10000,
    lines: [
      { name: '三小时畅玩套餐', quantity: 1, unitPriceCents: 6000 },
      { productId: beadId, name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
    ],
  })
}

/** 模拟后端的会员结账报价：会员 95 折，积分 100 分抵 10 元，余额先本金后赠送。 */
function quoteFor(points: number, useBalance: boolean, gift: number, version: string) {
  const afterDiscount = 9500
  const pointsCents = points >= 100 ? 1000 : 0
  const remaining = afterDiscount - pointsCents
  const principal = useBalance ? Math.min(5000, remaining) : 0
  const giftUsed = useBalance ? Math.min(gift, remaining - principal) : 0
  const offline = remaining - principal - giftUsed
  return {
    originalCents: 10000,
    discountCents: 500,
    pointsUsed: pointsCents ? 100 : 0,
    pointsCents,
    principalCents: principal,
    giftCents: giftUsed,
    offlineCents: offline,
    earnedPoints: Math.floor(offline / 100),
    pointsValidDays: 365,
    version,
  }
}

function paidMemberOrder(): MockOrder {
  return {
    ...memberDraft(),
    version: versionC,
    status: 'paid',
    settlement: 'member',
    receivableCents: 8500,
    paidCents: 8500,
    refundableCents: 8500,
    memberCheckout: {
      principalCents: 5000,
      giftCents: 900,
      pointsUsed: 100,
      pointsEarned: 26,
      offlineCents: 2600,
      // 结账那一刻的余额（后端由会员流水推出）：本金用完，赠送剩 1 元，积分 320 − 100 + 26
      balanceAfter: { principalCents: 0, giftCents: 100, points: 246 },
    },
    discounts: [
      { id: 'd-m', kind: 'fixed', amountCents: 500, reason: '会员权益', createdAt: '2026-10-05T06:40:00Z' },
      { id: 'd-p', kind: 'fixed', amountCents: 1000, reason: '积分抵扣 100 积分', createdAt: '2026-10-05T06:40:00Z' },
    ],
    payments: [
      { id: 'pay-b', method: 'balance', amountCents: 5900, createdAt: '2026-10-05T06:40:00Z' },
      {
        id: 'pay-c',
        method: 'cash',
        amountCents: 2600,
        cashReceivedCents: 3000,
        changeCents: 400,
        createdAt: '2026-10-05T06:40:00Z',
      },
    ],
  }
}

const memberAccount = (gift: number) => ({
  balance: {
    principalCents: 5000,
    giftCents: gift,
    points: 320,
    expiringPoints: 0,
    tierName: '金卡会员',
    rateBasisPoints: 9500,
  },
  profile: { birthday: '', birthdayYear: 0 },
  entries: [],
  rules: [],
  admissions: [],
  version: 'e'.repeat(64),
})

type LoyaltyBody = {
  action: string
  points?: number
  useBalance?: boolean
  quoteVersion?: string
  method?: string
  cashReceivedCents?: number
}

test('会员结账：带出绑定顾客与余额，先按不用积分报价；改积分、用余额后重算；资产变了被拒时重算再由人确认', async ({
  page,
}) => {
  let current = memberDraft()
  // 顾客的赠送余额：第一次确认时被别处用掉 ¥1，报价随之改变
  let gift = 1000
  let checkouts = 0
  const api = await mockApi(page, {
    account: owner,
    handlers: [
      orderHandler(memberOrderId, () => current),
      catalogHandler,
      // 会员扫码入座的套餐会话：明细按购买快照，不能改、不能打折
      ({ method, path }) =>
        method === 'GET' && path === `/venue-sessions/${admissionSessionId}`
          ? {
              status: 200,
              body: {
                id: admissionSessionId,
                serviceTableId: 'tttt0000-0000-4000-8000-000000000003',
                status: 'active',
                timingMode: 'timed',
                startedAt: '2026-10-05T05:00:00Z',
                seatNumber: 1,
                admissionId: 'adad0000-0000-4000-8000-000000000003',
              },
            }
          : undefined,
      ({ method, path, search }) =>
        method === 'GET' && path === '/loyalty/account' && search.get('accountId') === li.id
          ? { status: 200, body: memberAccount(gift) }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        const input = body as LoyaltyBody
        // 报价版本随内容变：不用积分余额 1，用 100 积分 4，再用余额 2，赠送余额变了 3
        const version = quoteV(gift !== 1000 ? 3 : input.useBalance ? 2 : input.points ? 4 : 1)
        const quote = quoteFor(input.points ?? 0, Boolean(input.useBalance), gift, version)
        if (input.action === 'quote' && (input.points ?? 0) % 100)
          return { status: 409, body: { code: 'loyalty_conflict', message: '积分须按 100 分一份使用' } }
        if (input.action === 'quote') return { status: 200, body: quote }
        if (input.action !== 'checkout') return undefined
        checkouts++
        if (checkouts === 1) {
          gift = 900
          return {
            status: 409,
            body: { code: 'loyalty_conflict', message: '会员资产或权益已变化，请重新预览结账' },
          }
        }
        if (input.quoteVersion !== quote.version)
          return { status: 409, body: { code: 'loyalty_conflict', message: '会员资产或权益已变化，请重新预览结账' } }
        current = paidMemberOrder()
        return { status: 200, body: { order: current, quote } }
      },
    ],
  })
  await signIn(page, owner)
  await page.goto(`/checkout/${memberOrderId}`)

  const member = page.locator('.semi-card', { hasText: '使用储值余额' })
  await expect(member.getByText('小李 · 139****0002')).toBeVisible()
  const balance = member.locator('.checkout-balance')
  // 左对齐的键值表（不是 row 布局，size 不起作用，所以不写）
  await expect(balance).toHaveClass(/semi-descriptions-left/)
  await expect(balance).not.toHaveClass(/semi-descriptions-double/)
  await expect(balance.locator('tr', { hasText: '会员等级' })).toContainText('金卡会员（9.5 折）')
  await expect(balance.locator('tr', { hasText: '储值本金' })).toContainText('¥50.00')
  await expect(balance.locator('tr', { hasText: '可用积分' })).toContainText('320 积分')
  // 套餐订单：明细只读，老板也没有人工折扣；顾客由入座申请决定，不能换
  await expect(page.getByText(/这是会员扫码入座的套餐订单：按购买时的套餐快照结算/)).toBeVisible()
  await expect(page.getByLabel('第 1 项名称')).toHaveCount(0)
  await expect(cardTitled(page, '人工折扣')).toHaveCount(0)
  const customerCard = cardTitled(page, '顾客账户')
  await expect(customerCard.getByText(/顾客由入座申请决定，不能更换/)).toBeVisible()
  await expect(customerCard.getByRole('button')).toHaveCount(0)

  // 打开就按「不用积分、不用余额」报价，可以直接收线下款
  await expect(payButton(page)).toHaveText('确认收款 ¥95.00')
  const quotes = () =>
    api.writes.filter((write) => (write.body as LoyaltyBody).action === 'quote').map((write) => write.body)
  expect(quotes()[0]).toEqual({
    action: 'quote',
    targetId: memberOrderId,
    expectedVersion: versionA,
    points: 0,
    useBalance: false,
  })

  // 积分不够整份：照后端的说明显示，不能收款
  await member.getByLabel('使用积分').fill('7')
  await expect(member.getByText('积分须按 100 分一份使用')).toBeVisible()
  await expect(payButton(page)).toBeDisabled()
  await expect(page.getByText('会员优惠算不出来，请先按提示修改积分或余额')).toBeVisible()
  // 不是整数：前端拦下，不去报价
  await expect(member.getByLabel('使用积分')).toHaveAccessibleDescription('按积分抵扣规则整份使用，0 表示不用')
  await member.getByLabel('使用积分').fill('1.5')
  await expect(member.getByText('积分须为不小于 0 的整数')).toBeVisible()
  await expect(member.getByLabel('使用积分')).toHaveAccessibleDescription('积分须为不小于 0 的整数')
  await expect(member.getByRole('switch', { name: '使用储值余额' })).toHaveAccessibleDescription(
    '先扣本金，再扣赠送余额',
  )
  expect(quotes().some((body) => (body as LoyaltyBody).points === 1.5)).toBe(false)

  await member.getByLabel('使用积分').fill('100')
  await member.getByRole('switch', { name: '使用储值余额' }).click()
  await expect(payButton(page)).toHaveText('确认收款 ¥25.00')
  const quoteCard = member.locator('.checkout-quote')
  await expect(quoteCard.locator('tr', { hasText: '会员优惠' })).toContainText('-¥5.00')
  await expect(quoteCard.locator('tr', { hasText: '积分抵扣（100 积分）' })).toContainText('-¥10.00')
  await expect(quoteCard.locator('tr', { hasText: '储值本金支付' })).toContainText('-¥50.00')
  await expect(quoteCard.locator('tr', { hasText: '赠送余额支付' })).toContainText('-¥10.00')
  await expect(quoteCard.locator('tr', { hasText: '线下补付' })).toContainText('¥25.00')
  expect(quotes().at(-1)).toMatchObject({ points: 100, useBalance: true })

  const payment = page.locator('.semi-card', { hasText: '收款登记' })
  await payment.locator('.semi-radio', { hasText: '现金' }).click()
  await expect(page.getByRole('radio', { name: '现金' })).toBeChecked()
  // 线下补付走现金：顾客给 30，补 25，应找零 5
  await payment.getByLabel('实收现金').fill('30')
  await expect(payment.getByText('应找零 ¥5.00')).toBeVisible()
  await shoot(page, 'checkout-member')
  await payButton(page).click()

  // 会员资产在报价后变了：后端拒收，页面重算，金额变了要人再确认，绝不自动重提；应找零跟着新补付变
  await expect(payment.getByText(/会员资产或权益已变化，请重新预览结账。会员优惠已按最新情况重新计算/)).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥26.00')
  await expect(payment.getByText('应找零 ¥4.00')).toBeVisible()
  const checkoutsSent = () => api.writes.filter((write) => (write.body as LoyaltyBody).action === 'checkout')
  expect(checkoutsSent()).toHaveLength(1)
  expect(checkoutsSent()[0].body).toEqual({
    action: 'checkout',
    targetId: memberOrderId,
    expectedVersion: versionA,
    quoteVersion: quoteV(2),
    points: 100,
    useBalance: true,
    method: 'cash',
    cashReceivedCents: 3000,
  })
  // 报价只算不写，不带实收现金
  expect(quotes().every((body) => !('cashReceivedCents' in (body as object)))).toBe(true)

  await payButton(page).click()
  await expect(page.getByText('收款成功')).toBeVisible()
  expect(checkoutsSent()).toHaveLength(2)
  expect(checkoutsSent()[1].body).toMatchObject({ quoteVersion: quoteV(3), method: 'cash', cashReceivedCents: 3000 })
  expect(checkoutsSent()[1].idempotencyKey).not.toBe(checkoutsSent()[0].idempotencyKey)

  const paid = page.locator('.semi-card', { hasText: '实收' })
  await expect(page.locator('.semi-banner', { hasText: '已付款' })).toContainText('实收 ¥85.00')
  await expect(paid.locator('tr', { hasText: '储值余额' })).toContainText('¥59.00')
  await expect(paid.locator('tr', { hasText: '线下补付' })).toContainText('¥26.00')
  await expect(paid.locator('tr', { hasText: '现金' })).toContainText('实收 ¥30.00 · 找零 ¥4.00')
  await expect(paid.locator('tr', { hasText: '结账后可用积分' })).toContainText('246 积分')
  await expect(page.getByRole('button', { name: '打印小票' })).toBeVisible()
  await shoot(page, 'checkout-paid')
})

test('换顾客：散客单绑定顾客后走会员结账；更换时 409 保留所选、重读后由人再确认；改为散客先确认；都带订单版本与幂等键', async ({
  page,
}) => {
  const orderId = '6e6e6e6e-0000-4000-8000-000000000006'
  const wang = { id: 'u-wang', nickname: '小王', phoneMasked: '138****0003' }
  const customers = [li, wang]
  const versionD = 'd'.repeat(64)
  const versionE = 'e'.repeat(64)
  let current = draftOrder(orderId, {
    receivableCents: 3000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 3000 }],
  })
  let patches = 0
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, search }) =>
        method === 'GET' && path === '/accounts' ? accountListResult(customers, search) : undefined,
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account' ? { status: 200, body: memberAccount(1000) } : undefined,
      ({ method, path, body }) => {
        if (method !== 'PATCH' || path !== `/sales-orders/${orderId}/customer`) return undefined
        patches++
        const input = body as { accountId: string | null; expectedVersion: string }
        if (patches === 2) {
          // 就在这时，有人在手机上给这张单加了一包材料
          current = saveLines(
            current,
            [...current.lines, { productId: beadId, name: '拼豆材料包', quantity: 1, unitPriceCents: 2000 }],
            versionC,
          )
        }
        if (input.expectedVersion !== current.version)
          return { status: 409, body: { code: 'order_version_conflict', message: '订单已被修改，请重新读取并确认' } }
        const who = customers.find((customer) => customer.id === input.accountId)
        current = {
          ...current,
          version: patches === 1 ? versionB : patches === 3 ? versionD : versionE,
          accountId: who?.id,
          customer: who ?? null,
        }
        return { status: 200, body: current }
      },
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/loyalty/actions' || (body as LoyaltyBody).action !== 'quote')
          return undefined
        return {
          status: 200,
          body: {
            originalCents: current.receivableCents,
            discountCents: 0,
            pointsUsed: 0,
            pointsCents: 0,
            principalCents: 0,
            giftCents: 0,
            offlineCents: current.receivableCents,
            earnedPoints: 0,
            pointsValidDays: 0,
            version: quoteV(7),
          },
        }
      },
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)

  const card = cardTitled(page, '顾客账户')
  await expect(card.getByText('散客', { exact: true })).toBeVisible()
  await expect(cardTitled(page, '会员结账')).toHaveCount(0)
  // 明细改过没保存：先保存再换（换顾客成功后页面换成新版本的订单，没保存的明细会被替换）
  await page.getByLabel('第 1 项名称').fill('计时服务费（改）')
  await expect(card.getByRole('button', { name: '绑定顾客账户' })).toBeDisabled()
  await expect(card.getByText('明细改过，请先保存明细再换顾客')).toBeVisible()
  await page.getByLabel('第 1 项名称').fill('计时服务费')

  // 绑定小李：带读到的版本；成功后走会员结账，按新版本报价
  await card.getByRole('button', { name: '绑定顾客账户' }).click()
  await card.getByRole('combobox', { name: '选择顾客账户' }).click()
  await page.locator('.semi-select-option', { hasText: '小李' }).click()
  await card.getByRole('button', { name: '确认绑定' }).click()
  await expect(page.getByText('已绑定顾客账户，可以用会员结账')).toBeVisible()
  const customerWrites = () => api.writes.filter((write) => write.path === `/sales-orders/${orderId}/customer`)
  expect(customerWrites()[0]).toMatchObject({
    method: 'PATCH',
    body: { accountId: li.id, expectedVersion: versionA },
  })
  expect(customerWrites()[0].idempotencyKey).toBeTruthy()
  await expect(card.getByText('小李 · 139****0002')).toBeVisible()
  await expect(cardTitled(page, '会员结账')).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥30.00')
  const quoted = api.writes.filter((write) => (write.body as LoyaltyBody).action === 'quote')
  expect(quoted.at(-1)?.body).toMatchObject({ targetId: orderId, expectedVersion: versionB })

  // 换成小王时订单刚被别人改过：409，保留选好的人，提示重读；不自动重提
  await card.getByRole('button', { name: '更换顾客' }).click()
  await card.locator('.semi-select').click()
  await page.locator('.semi-select-option', { hasText: '小王' }).click()
  await card.getByRole('button', { name: '确认更换' }).click()
  await expect(page.locator('.semi-banner', { hasText: '订单已被修改' })).toContainText('换了顾客')
  await expect(card.locator('.semi-select')).toContainText('小王')
  await expect(card.getByRole('button', { name: '确认更换' })).toBeDisabled()
  expect(customerWrites()).toHaveLength(2)
  expect(customerWrites()[1].body).toEqual({ accountId: wang.id, expectedVersion: versionB })

  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(page.locator('.semi-banner', { hasText: '订单已被修改' })).toHaveCount(0)
  await expect(page.getByLabel('第 2 项名称')).toHaveValue('拼豆材料包')
  expect(customerWrites()).toHaveLength(2)
  await card.getByRole('button', { name: '确认更换' }).click()
  await expect(page.getByText('已更换顾客，会员优惠按新顾客重新计算')).toBeVisible()
  expect(customerWrites()).toHaveLength(3)
  expect(customerWrites()[2].body).toEqual({ accountId: wang.id, expectedVersion: versionC })
  expect(customerWrites()[2].idempotencyKey).not.toBe(customerWrites()[1].idempotencyKey)
  await expect(card.getByText('小王 · 138****0003')).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥50.00')

  // 改为散客：先确认写清后果，accountId 传 null
  await card.getByRole('button', { name: '改为散客' }).click()
  await expect(page.locator('.semi-modal')).toContainText('订单将不再关联「小王 · 138****0003」')
  // 确认按钮和触发它的一样标成危险操作
  await expect(page.locator('.semi-modal button', { hasText: '改为散客' })).toHaveClass(/semi-button-danger/)
  await page.locator('.semi-modal button', { hasText: '改为散客' }).click()
  await expect(page.getByText('已改为散客')).toBeVisible()
  expect(customerWrites()[3].body).toEqual({ accountId: null, expectedVersion: versionD })
  await expect(card.getByText('散客', { exact: true })).toBeVisible()
  await expect(cardTitled(page, '会员结账')).toHaveCount(0)
  await expect(payButton(page)).toHaveText('确认收款 ¥50.00')
  expect(current.version).toBe(versionE)
})

test('小票：门店、订单号、门店时区时间、明细、折扣、应收实收、付款方式与找零、会员变动与结账后余额；不印手机号；按纸宽打印', async ({
  page,
}) => {
  const order = paidMemberOrder()
  // 余额只印订单接口给的本单结账后的数：不读会员资产（读了就是打印那一刻的余额，事后重印会变）
  await mockApi(page, { account: clerk, handlers: [orderHandler(memberOrderId, () => order)] })
  await signIn(page, clerk)
  await page.goto(`/receipt/${memberOrderId}?paper=58`)

  const sheet = page.getByRole('region', { name: '小票' })
  const row = (label: string) => sheet.locator('.receipt-row').filter({ has: page.getByText(label, { exact: true }) })
  await expect(sheet).toHaveAttribute('data-paper', '58')
  await expect(sheet).toContainText('Example示例工坊·拼豆·手作研究室')
  await expect(sheet.locator('.receipt-row', { hasText: '订单号' })).toContainText('3c3c3c3c')
  // 门店时区：06:40Z 是北京时间 14:40
  await expect(sheet.locator('.receipt-row', { hasText: '收款时间' })).toContainText('2026-10-05 14:40')
  await expect(sheet.locator('.receipt-row', { hasText: '顾客' })).toContainText('小李')
  await expect(sheet.locator('.receipt-row', { hasText: '拼豆材料包' })).toContainText('¥20.00 ×2')
  await expect(sheet.locator('.receipt-row', { hasText: '三小时畅玩套餐' })).toContainText('¥60.00 ×1')
  await expect(sheet.locator('.receipt-row', { hasText: '会员权益' })).toContainText('-¥5.00')
  await expect(sheet.locator('.receipt-row', { hasText: '积分抵扣 100 积分' })).toContainText('-¥10.00')
  await expect(sheet.locator('.receipt-row', { hasText: '应收' })).toContainText('¥85.00')
  await expect(row('储值余额')).toContainText('¥59.00')
  await expect(row('现金')).toContainText('¥26.00')
  await expect(row('实收现金')).toContainText('¥30.00')
  await expect(row('找零')).toContainText('¥4.00')
  await expect(row('实收')).toContainText('¥85.00')
  await expect(row('储值本金支付')).toContainText('-¥50.00')
  await expect(row('赠送余额支付')).toContainText('-¥9.00')
  await expect(row('本单获得积分')).toContainText('+26 积分')
  // 本单结账后的余额（结账那一刻的，不是打印时的），和本单的变动分开
  await expect(sheet.getByText('本单结账后余额', { exact: true })).toBeVisible()
  await expect(row('储值本金')).toContainText('¥0.00')
  await expect(row('赠送余额')).toContainText('¥1.00')
  await expect(row('可用积分')).toContainText('246 积分')
  await expect(sheet).not.toContainText('截至')
  // 不印手机号（打了码的也不印）
  await expect(sheet).not.toContainText('139')

  // 打印时只留小票：侧栏、顶栏、标题与按钮都不印
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('.semi-layout-sider')).toBeHidden()
  await expect(page.locator('.receipt-toolbar')).toBeHidden()
  await expect(page.getByRole('heading', { name: /小票 · 订单/ })).toBeHidden()
  await expect(sheet).toBeVisible()
  // 58mm 卷纸：小票就是纸宽
  expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(Math.round((58 * 96) / 25.4))
  await shoot(page, 'receipt-58mm', sheet)
  await shoot(page, 'receipt-58mm-page')

  // 换 80mm、A4：写进网址，这台电脑记住
  await page.emulateMedia({ media: 'screen' })
  await page.locator('.receipt-toolbar .semi-radio', { hasText: '80mm' }).click()
  await expect(sheet).toHaveAttribute('data-paper', '80')
  await page.emulateMedia({ media: 'print' })
  expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(Math.round((80 * 96) / 25.4))
  await shoot(page, 'receipt-80mm', sheet)
  await page.emulateMedia({ media: 'screen' })
  await page.locator('.receipt-toolbar .semi-radio', { hasText: 'A4' }).click()
  await expect(page).toHaveURL(/[?&]paper=a4/)
  await expect(sheet).toHaveAttribute('data-paper', 'a4')
  await page.emulateMedia({ media: 'print' })
  await shoot(page, 'receipt-a4', sheet)
  await page.emulateMedia({ media: 'screen' })
  await page.goto(`/receipt/${memberOrderId}`)
  await expect(page.getByRole('region', { name: '小票' })).toHaveAttribute('data-paper', 'a4')
})

test('入口：订单列表与详情里，待结账的「去结账」，收过款的「打印小票」；没付款的单不出小票', async ({ page }) => {
  const draft = draftOrder('4d4d4d4d-0000-4000-8000-000000000004', {
    receivableCents: 3000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 3000 }],
  })
  const paid = payOrder(
    draftOrder('5f5f5f5f-0000-4000-8000-000000000005', {
      receivableCents: 4000,
      lines: [{ name: '钥匙扣', quantity: 1, unitPriceCents: 4000 }],
      createdAt: '2026-10-05T07:00:00Z',
    }),
    'alipay',
    versionB,
  )
  await mockApi(page, {
    account: clerk,
    handlers: [
      ({ method, path, search }) =>
        method === 'GET' && path === '/sales-orders' ? orderListResult([draft, paid], search) : undefined,
      orderHandler(draft.id, () => draft),
      orderHandler(paid.id, () => paid),
      catalogHandler,
    ],
  })
  await signIn(page, clerk)
  await page.goto('/orders')

  const rows = page.locator('.semi-table-tbody .semi-table-row')
  // 列表行上的快捷入口是按钮，不包在链接里；点它不进详情
  await expect(rows.locator('a button')).toHaveCount(0)
  await rows.filter({ hasText: '5f5f5f5f' }).getByRole('button', { name: '打印小票' }).click()
  await expect(page).toHaveURL(new RegExp(`/receipt/${paid.id}$`))
  await expect(page.getByRole('region', { name: '小票' })).toContainText('支付宝')
  await page.getByRole('button', { name: '返回' }).click()

  await rows.filter({ hasText: '4d4d4d4d' }).getByRole('button', { name: '去结账' }).click()
  await expect(page).toHaveURL(new RegExp(`/checkout/${draft.id}$`))
  await expect(payButton(page)).toHaveText('确认收款 ¥30.00')

  // 详情页：待结账的有「去结账」，收过款的有「打印小票」；直接打开时「返回列表」也是按钮
  await page.goto(`/orders/${draft.id}`)
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible()
  await expect(page.locator('a button')).toHaveCount(0)
  await page.getByRole('button', { name: '去结账' }).click()
  await expect(page).toHaveURL(new RegExp(`/checkout/${draft.id}$`))
  await page.goto(`/orders/${paid.id}`)
  await expect(page.getByRole('button', { name: '去结账' })).toHaveCount(0)
  await page.getByRole('button', { name: '打印小票' }).click()
  await expect(page).toHaveURL(new RegExp(`/receipt/${paid.id}$`))

  // 还没付款的单打开小票：说明并给去结账的入口
  await page.goto(`/receipt/${draft.id}`)
  await expect(page.getByText('这张订单还没付款')).toBeVisible()
  await expect(page.getByRole('region', { name: '小票' })).toHaveCount(0)
  await expect(page.locator('a button')).toHaveCount(0)
  await page.getByRole('button', { name: '去结账' }).click()
  await expect(page).toHaveURL(new RegExp(`/checkout/${draft.id}$`))
})

/** 模拟后端分笔收款：这一笔不超过还差的数；没收齐是部分付款（还差、已收照接口），收齐变已付款。真实规则由 Go 测试覆盖。 */
function collect(
  order: MockOrder,
  input: { method: string; amountCents: number; cashReceivedCents?: number },
  version: string,
  at: string,
): MockOrder {
  const paid = (order.paidCents as number) + input.amountCents
  const outstanding = order.receivableCents - paid
  const payments = (order.payments as Record<string, unknown>[]) ?? []
  const tender =
    input.cashReceivedCents === undefined
      ? {}
      : { cashReceivedCents: input.cashReceivedCents, changeCents: input.cashReceivedCents - input.amountCents }
  return {
    ...order,
    version,
    status: outstanding > 0 ? 'partially_paid' : 'paid',
    paidCents: paid,
    outstandingCents: outstanding,
    refundableCents: outstanding > 0 ? 0 : paid,
    payments: [
      ...payments,
      {
        id: `pay-${payments.length + 1}`,
        method: input.method,
        amountCents: input.amountCents,
        createdAt: at,
        ...tender,
      },
    ],
  }
}

test('分笔付款：散客单先收一部分，显示已收 1 笔、还差多少，明细只读；收下一笔默认还差的全部，收齐结清', async ({
  page,
}) => {
  const orderId = '3d3d3d3d-0000-4000-8000-000000000031'
  let current = draftOrder(orderId, {
    receivableCents: 10000,
    outstandingCents: 10000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
  })
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/payments`) return undefined
        const input = body as { method: string; amountCents: number; cashReceivedCents?: number }
        const first = current.status === 'draft'
        current = collect(
          current,
          input,
          first ? versionB : versionC,
          first ? '2026-10-06T06:30:00Z' : '2026-10-06T06:35:00Z',
        )
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)

  const payment = cardTitled(page, '收款登记')
  await expect(payButton(page)).toHaveText('确认收款 ¥100.00')
  // 收款金额空着就是全部；超过还差的拦下，不发请求
  const amount = payment.getByLabel('收款金额（元）')
  await expect(amount).toHaveAttribute('placeholder', '全部 ¥100.00')
  await amount.fill('100.01')
  await expect(payment.getByText('这一笔不能超过还差的 ¥100.00')).toHaveCount(2)
  await expect(payButton(page)).toBeDisabled()
  await expect(amount).toHaveAttribute('aria-invalid', 'true')
  // 第一位朋友付 ¥40（微信）
  await amount.fill('40')
  await expect(payButton(page)).toHaveText('确认收款 ¥40.00')
  await payButton(page).click()
  await expect(page.getByText('已收 ¥40.00，还差 ¥60.00')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toEqual({ method: 'wechat', amountCents: 4000, expectedVersion: versionA })
  expect(api.writes[0].idempotencyKey).toBeTruthy()

  // 部分付款：明细只读，不能换顾客；列出已收 1 笔、还差多少；按钮默认还差的全部
  await expect(page.getByText('部分付款', { exact: true })).toBeVisible()
  await expect(page.getByText(/已经收了第一笔：明细和金额定在收第一笔时/)).toBeVisible()
  await expect(page.getByRole('button', { name: '保存明细' })).toHaveCount(0)
  await expect(cardTitled(page, '顾客账户')).toHaveCount(0)
  const collected = cardTitled(page, '已收 1 笔')
  await expect(collected).toContainText('第 1 笔')
  await expect(collected).toContainText('微信')
  await expect(collected).toContainText('¥40.00')
  await expect(collected.locator('.semi-descriptions')).toContainText('还差')
  await expect(collected.locator('.semi-descriptions')).toContainText('¥60.00')
  const next = cardTitled(page, '收下一笔')
  await expect(next.getByText('还差', { exact: true })).toBeVisible()
  await expect(payButton(page)).toHaveText('确认收款 ¥60.00')
  await shoot(page, 'checkout-split-partial')

  // 第二位付现金，给 ¥100：找零按这一笔算
  await next.locator('.semi-radio', { hasText: '现金' }).click()
  await next.getByLabel('实收现金').fill('100')
  await expect(next.getByText('应找零 ¥40.00')).toBeVisible()
  await payButton(page).click()
  await expect(page.getByText('收款成功')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toEqual({
    method: 'cash',
    amountCents: 6000,
    cashReceivedCents: 10000,
    expectedVersion: versionB,
  })
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
  // 收齐：逐笔列出
  await expect(page.getByText('第 1 笔 · 微信')).toBeVisible()
  await expect(page.getByText('第 2 笔 · 现金')).toBeVisible()
  await expect(page.getByText('¥60.00（实收 ¥100.00 · 找零 ¥40.00）')).toBeVisible()
})

test('部分付款对剩余免单（店长）：确认框写清已收与免掉多少；结清后标剩余免单', async ({ page }) => {
  const orderId = '3d3d3d3d-0000-4000-8000-000000000032'
  let current = draftOrder(orderId, {
    status: 'partially_paid',
    receivableCents: 10000,
    paidCents: 4000,
    outstandingCents: 6000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
    payments: [{ id: 'pay-1', method: 'wechat', amountCents: 4000, createdAt: '2026-10-06T06:30:00Z' }],
  })
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/comps`) return undefined
        current = {
          ...current,
          version: versionB,
          status: 'paid',
          outstandingCents: 0,
          refundableCents: 4000,
          compCents: 6000,
          payments: [
            ...(current.payments as Record<string, unknown>[]),
            {
              id: 'comp-1',
              method: 'comp',
              amountCents: 6000,
              reason: (body as { reason: string }).reason,
              createdAt: '2026-10-06T06:40:00Z',
            },
          ],
        }
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, manager)
  await page.goto(`/checkout/${orderId}`)

  // 部分付款：没有人工折扣，免单卡片是「对剩余免单」
  await expect(cardTitled(page, '人工折扣')).toHaveCount(0)
  const card = cardTitled(page, '对剩余免单')
  await expect(card.getByLabel('免单原因')).toHaveAccessibleDescription(/剩下没付的 ¥60.00 不收了/)
  await card.getByLabel('免单原因').fill('朋友没带钱，店长同意')
  await card.getByRole('button', { name: '对剩余免单' }).click()
  const dialog = page.getByRole('dialog', { name: '对剩余 ¥60.00 免单？' })
  await expect(dialog).toContainText('已收 ¥40.00；剩余 ¥60.00 将记为免单')
  await dialog.getByRole('button', { name: '确认免单' }).click()
  await expect(page.getByText('已对剩余免单 ¥60.00，已收 ¥40.00')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0]).toMatchObject({ method: 'POST', path: `/sales-orders/${orderId}/comps` })
  expect(api.writes[0].body).toEqual({ reason: '朋友没带钱，店长同意', expectedVersion: versionA })

  await expect(page.getByText('已付款（剩余免单）')).toBeVisible()
  await expect(page.getByText('免单 ¥60.00，实收 ¥40.00。原因：朋友没带钱，店长同意')).toBeVisible()
})

test('会员结账只收一部分线下补付：带 offlineCents，订单变部分付款；为 0 且不用储值时提前说明', async ({ page }) => {
  const orderId = '3d3d3d3d-0000-4000-8000-000000000033'
  let current = draftOrder(orderId, {
    accountId: li.id,
    customer: li,
    receivableCents: 10000,
    outstandingCents: 10000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
  })
  const quote = (useBalance: boolean) => ({
    originalCents: 10000,
    discountCents: 0,
    pointsUsed: 0,
    pointsCents: 0,
    principalCents: useBalance ? 3000 : 0,
    giftCents: 0,
    offlineCents: useBalance ? 7000 : 10000,
    earnedPoints: 100,
    pointsValidDays: 365,
    version: quoteV(useBalance ? 2 : 1),
  })
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, search }) =>
        method === 'GET' && path === '/loyalty/account' && search.get('accountId') === li.id
          ? { status: 200, body: memberAccount(1000) }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        const input = body as { action: string; useBalance?: boolean; offlineCents?: number; method?: string }
        const q = quote(Boolean(input.useBalance))
        if (input.action === 'quote') return { status: 200, body: q }
        const offline = input.offlineCents ?? q.offlineCents
        current = {
          ...current,
          version: versionB,
          status: 'partially_paid',
          settlement: 'member',
          paidCents: q.principalCents + offline,
          outstandingCents: q.offlineCents - offline,
          payments: [
            {
              id: 'pay-b',
              method: 'balance',
              amountCents: q.principalCents,
              createdAt: '2026-10-06T06:30:00Z',
              member: true,
            },
            ...(offline
              ? [
                  {
                    id: 'pay-o',
                    method: input.method,
                    amountCents: offline,
                    createdAt: '2026-10-06T06:30:00Z',
                    member: true,
                  },
                ]
              : []),
          ],
        }
        return { status: 200, body: { order: current, quote: q } }
      },
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)

  const payment = cardTitled(page, '收款登记')
  await expect(payButton(page)).toHaveText('确认收款 ¥100.00')
  // 不用储值又这次不收线下款：会员这一笔没收到钱，提前说明
  const offline = payment.getByLabel('这次收的线下款（元）')
  await offline.fill('0')
  await expect(payment.getByText(/会员结账这一笔要收到钱/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^确认会员结账/ })).toBeDisabled()
  // 用储值 ¥30，这次线下只收 ¥20，余下 ¥50 之后别人付
  await page.locator('.semi-card', { hasText: '使用储值余额' }).getByRole('switch', { name: '使用储值余额' }).click()
  await expect(offline).toHaveAttribute('placeholder', '全部 ¥70.00')
  await offline.fill('20')
  await expect(payButton(page)).toHaveText('确认收款 ¥20.00')
  await payButton(page).click()
  await expect(page.getByText('已收 ¥50.00，还差 ¥50.00')).toBeVisible()
  const checkout = api.writes.find((write) => (write.body as { action?: string }).action === 'checkout')
  expect(checkout?.body).toMatchObject({
    action: 'checkout',
    targetId: orderId,
    expectedVersion: versionA,
    useBalance: true,
    method: 'wechat',
    offlineCents: 2000,
    quoteVersion: quoteV(2),
  })
  // 之后余下的按普通收款分笔收：会员这一笔标出来
  const collected = cardTitled(page, '已收 1 笔')
  await expect(collected).toContainText('微信（会员结账）')
  await expect(payButton(page)).toHaveText('确认收款 ¥50.00')
})

test('会员只用储值付自己那份：填这次用多少储值，报价与确认都带 balanceCents；超了照后端原话说明', async ({ page }) => {
  const orderId = '3d3d3d3d-0000-4000-8000-000000000034'
  let current = draftOrder(orderId, {
    accountId: li.id,
    customer: li,
    receivableCents: 10000,
    outstandingCents: 10000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
  })
  // 可用储值 ¥60（本金 ¥50、赠送 ¥10）：不填就全用，填了按填的用，超过 ¥60 后端拒绝
  const quote = (useBalance: boolean, cap?: number) => {
    const used = useBalance ? Math.min(cap ?? 6000, 6000) : 0
    return {
      originalCents: 10000,
      discountCents: 0,
      pointsUsed: 0,
      pointsCents: 0,
      principalCents: Math.min(used, 5000),
      giftCents: Math.max(0, used - 5000),
      offlineCents: 10000 - used,
      earnedPoints: 100,
      pointsValidDays: 365,
      version: quoteV(used === 0 ? 1 : used === 6000 ? 2 : 3),
    }
  }
  const quotes: { balanceCents?: number }[] = []
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, search }) =>
        method === 'GET' && path === '/loyalty/account' && search.get('accountId') === li.id
          ? { status: 200, body: memberAccount(1000) }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        const input = body as { action: string; useBalance?: boolean; balanceCents?: number; offlineCents?: number }
        if (input.balanceCents !== undefined && input.balanceCents > 6000)
          return {
            status: 400,
            body: {
              code: 'invalid_request',
              message: '这次用的储值 ¥70.00 超过了可用储值 ¥60.00（本金加赠送）',
              requestId: 'r',
            },
          }
        const q = quote(Boolean(input.useBalance), input.balanceCents)
        if (input.action === 'quote') {
          quotes.push({ balanceCents: input.balanceCents })
          return { status: 200, body: q }
        }
        const offline = input.offlineCents ?? q.offlineCents
        current = {
          ...current,
          version: versionB,
          status: 'partially_paid',
          settlement: 'member',
          paidCents: q.principalCents + q.giftCents + offline,
          outstandingCents: q.offlineCents - offline,
          payments: [
            {
              id: 'pay-b',
              method: 'balance',
              amountCents: q.principalCents + q.giftCents,
              createdAt: '2026-10-06T06:30:00Z',
              member: true,
            },
          ],
        }
        return { status: 200, body: { order: current, quote: q } }
      },
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)

  const memberCard = page.locator('.semi-card', { hasText: '使用储值余额' })
  await expect(memberCard.getByLabel('这次用多少储值（元）')).toHaveCount(0)
  await memberCard.getByRole('switch', { name: '使用储值余额' }).click()
  const cap = memberCard.getByLabel('这次用多少储值（元）')
  await expect(cap).toHaveAttribute('placeholder', '全部可用')
  // 超过可用储值：照后端原话说明，收款按钮灰着
  await cap.fill('70')
  await expect(memberCard.getByText('这次用的储值 ¥70.00 超过了可用储值 ¥60.00（本金加赠送）')).toBeVisible()
  await expect(page.getByRole('button', { name: /^确认/ })).toBeDisabled()
  // 只用 ¥30 付会员自己那份，这次不收线下款，余下 ¥70 别人付
  await cap.fill('30')
  const payment = cardTitled(page, '收款登记')
  await expect(payment.getByLabel('这次收的线下款（元）')).toHaveAttribute('placeholder', '全部 ¥70.00')
  await payment.getByLabel('这次收的线下款（元）').fill('0')
  // 储值也算会员这一笔收到的钱：这次可以一分线下款都不收
  const confirm = page.getByRole('button', { name: '确认会员结账（这次不收线下款）' })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByText('已收 ¥30.00，还差 ¥70.00')).toBeVisible()
  expect(quotes.at(-1)).toEqual({ balanceCents: 3000 })
  const checkout = api.writes.find((write) => (write.body as { action?: string }).action === 'checkout')
  expect(checkout?.body).toMatchObject({
    action: 'checkout',
    useBalance: true,
    balanceCents: 3000,
    offlineCents: 0,
    quoteVersion: quoteV(3),
  })
})

test('两组单选各管各的：选折扣方式不清掉收款方式，选收款方式也不清掉折扣方式', async ({ page }) => {
  const orderId = '6a6a6a6a-0000-4000-8000-000000000006'
  const order = draftOrder(orderId, {
    receivableCents: 10000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
  })
  await mockApi(page, { account: manager, handlers: [orderHandler(orderId, () => order), catalogHandler] })
  await signIn(page, manager)
  await page.goto(`/checkout/${orderId}`)

  const discount = cardTitled(page, '人工折扣')
  const payment = cardTitled(page, '收款登记')
  await expect(payButton(page)).toHaveText('确认收款 ¥100.00')
  await payment.locator('.semi-radio', { hasText: '现金' }).click()
  await expect(payment.getByRole('radio', { name: '现金' })).toBeChecked()
  await discount.locator('.semi-radio', { hasText: '固定金额' }).click()
  await expect(discount.getByRole('radio', { name: '固定金额' })).toBeChecked()
  // 浏览器把同一表单里同名的原生单选框当成一组：两组同名时选了这组，那组的勾就被取消
  await expect(payment.getByRole('radio', { name: '现金' })).toBeChecked()
  await payment.locator('.semi-radio', { hasText: '支付宝' }).click()
  await expect(payment.getByRole('radio', { name: '支付宝' })).toBeChecked()
  await expect(discount.getByRole('radio', { name: '固定金额' })).toBeChecked()
  // 现在折扣那组在 <form> 里、收款那组不在，浏览器碰巧分得开；名字各起各的，不靠表单结构碰运气
  const names = await page
    .locator('input[type="radio"]')
    .evaluateAll((inputs) => [...new Set(inputs.map((input) => (input as HTMLInputElement).name))])
  expect(names).toHaveLength(2)
})

test('改过明细还没保存时订单在别处变了：重新读取先确认，确认按钮是危险样式，按钮读屏名就是按钮上的字', async ({
  page,
}) => {
  const orderId = '7b7b7b7b-0000-4000-8000-000000000007'
  let current = draftOrder(orderId, {
    receivableCents: 3000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 3000 }],
  })
  const api = await mockApi(page, { account: clerk, handlers: [orderHandler(orderId, () => current), catalogHandler] })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)
  await expect(payButton(page)).toHaveText('确认收款 ¥30.00')

  await page.getByLabel('第 1 项名称').fill('计时 90 分钟')
  await expect(page.getByText('明细已改动，尚未保存')).toBeVisible()
  // 别人在手机上改了这张单：实时事件到达，页面重读到新版本
  current = { ...current, version: versionB, receivableCents: 4000 }
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  for (const ws of api.sockets) ws.send(JSON.stringify({ type: 'resource.updated', resource: 'sales-orders' }))
  await expect(page.getByText(/这张订单刚有了变化/)).toBeVisible()

  await page.getByRole('button', { name: '重新读取' }).click()
  const dialog = page.getByRole('dialog', { name: '重新读取订单' })
  await expect(dialog).toContainText('当前未保存的明细修改将被替换')
  await expect(dialog.getByRole('button', { name: '重新读取' })).toHaveClass(/semi-button-danger/)
  await expect(dialog.getByRole('button', { name: 'confirm' })).toHaveCount(0)
  // 取消：改动留着
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('第 1 项名称')).toHaveValue('计时 90 分钟')
  // 确认：换成新版本，改动被替换
  await page.getByRole('button', { name: '重新读取' }).click()
  await page.getByRole('dialog', { name: '重新读取订单' }).getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByLabel('第 1 项名称')).toHaveValue('计时服务费')
  await expect(payButton(page)).toHaveText('确认收款 ¥40.00')
  expect(api.writes).toHaveLength(0)
})

test('会员码：手机转来的会员码打开「顾客账户」并选好这位，由人确认后才绑定；扫码枪对着选顾客框扫会员码也一样', async ({
  page,
}) => {
  const orderId = '7f7f7f7f-0000-4000-8000-000000000007'
  const wang = { id: 'u-wang', nickname: '小王', phoneMasked: '138****0003' }
  const customers = [li, wang]
  const codes: Record<string, typeof li> = { '91234567890123456789': li, '90000000000000000003': wang }
  let current = draftOrder(orderId, {
    receivableCents: 3000,
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 3000 }],
  })
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      orderHandler(orderId, () => current),
      catalogHandler,
      ({ method, path, search }) =>
        method === 'GET' && path === '/accounts' ? accountListResult(customers, search) : undefined,
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account' ? { status: 200, body: memberAccount(1000) } : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/member-codes/lookups') return undefined
        const who = codes[(body as { code: string }).code]
        return who
          ? {
              status: 200,
              body: { ...who, phoneVerificationStatus: 'verified', roles: [], balance: memberAccount(0).balance },
            }
          : { status: 404, body: { code: 'member_code_not_found', message: '这不是本店的会员码', requestId: 'r' } }
      },
      ({ method, path, body }) => {
        if (method !== 'PATCH' || path !== `/sales-orders/${orderId}/customer`) return undefined
        const who = customers.find((customer) => customer.id === (body as { accountId: string }).accountId)
        current = { ...current, version: versionB, accountId: who?.id, customer: who ?? null }
        return { status: 200, body: current }
      },
      ({ method, path, body }) =>
        method === 'POST' && path === '/loyalty/actions' && (body as LoyaltyBody).action === 'quote'
          ? {
              status: 200,
              body: {
                originalCents: current.receivableCents,
                discountCents: 0,
                pointsUsed: 0,
                pointsCents: 0,
                principalCents: 0,
                giftCents: 0,
                offlineCents: current.receivableCents,
                earnedPoints: 0,
                pointsValidDays: 0,
                version: quoteV(8),
              },
            }
          : undefined,
    ],
  })
  await signIn(page, clerk)
  await page.goto(`/checkout/${orderId}`)
  const card = cardTitled(page, '顾客账户')
  await expect(card.getByText('散客', { exact: true })).toBeVisible()
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  const relay = (code: string) =>
    api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'scan.relayed', code }))

  // 手机扫到小李的会员码：打开「顾客账户」并选好小李，还没提交
  relay('91234567890123456789')
  await expect(page.getByText('已按会员码选中「小李」')).toBeVisible()
  await expect(card.locator('.semi-select')).toContainText('小李')
  const customerWrites = () => api.writes.filter((write) => write.path === `/sales-orders/${orderId}/customer`)
  expect(customerWrites()).toHaveLength(0)
  await card.getByRole('button', { name: '确认绑定' }).click()
  await expect(page.getByText('已绑定顾客账户，可以用会员结账')).toBeVisible()
  expect(customerWrites()[0].body).toEqual({ accountId: li.id, expectedVersion: versionA })

  // 再转来同一位：只提示就是现在的顾客
  relay('91234567890123456789')
  await expect(page.getByText('手机扫到的会员码就是这张单现在的顾客「小李」')).toBeVisible()
  // 商品条码：结账页没有按条码加商品的入口，交给全站提示
  relay('6901234567892')
  await expect(page.locator('.semi-notification-notice', { hasText: '手机扫到' })).toContainText('6901234567892')

  // 柜台扫码枪：点开选顾客框，键入小王的会员码再回车，选中的是小王（不是高亮的第一位）
  await card.getByRole('button', { name: '更换顾客' }).click()
  await card.getByRole('combobox', { name: '选择顾客账户' }).click()
  await expect(page.locator('.semi-select-option', { hasText: '小李' })).toBeVisible()
  await page.keyboard.type('90000000000000000003')
  await page.keyboard.press('Enter')
  await expect(card.locator('.semi-select')).toContainText('小王（138****0003）')
  await expect(card.getByRole('button', { name: '确认更换' })).toBeEnabled()
  // 扫码枪结尾的回车被拦下：下拉框收起后不会又展开
  await expect(page.locator('.semi-select-option')).toHaveCount(0)
  await expect(card.getByRole('combobox', { name: '选择顾客账户' })).toHaveAttribute('aria-expanded', 'false')
  // 不是本店的码：照后端的话说，选中的人不变
  await card.getByRole('combobox', { name: '选择顾客账户' }).click()
  await page.keyboard.type('98888888888888888888')
  await expect(page.getByText('这不是本店的会员码')).toBeVisible()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(card.locator('.semi-select')).toContainText('小王')
  expect(customerWrites()).toHaveLength(1)
})
