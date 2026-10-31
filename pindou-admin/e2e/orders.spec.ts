import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockApi, type MockHandler } from './mock-api'
import { orderListResult } from './order-list'

// 订单与退款：列表搜索、筛选、分页都在网址里；详情只展示接口给的金额；
// 退款逐件填回补件数，超上限拦下；409 冲突保留输入、重读后由人再确认；店员看不到退款。
// 会员结账的订单走会员退款（/loyalty/actions 的 refund，可分多次），每次将退回什么只照后端预览（refund_quote）。

const versionA = 'a'.repeat(64)
const versionB = 'b'.repeat(64)
const versionC = 'c'.repeat(64)

/** 订单里服务端带的顾客称呼（AccountLabel）：页面照它显示，不再为名字去读账号列表。 */
const li = { id: 'u-li', nickname: '小李', phoneMasked: '139****0002' }

type MockOrder = Record<string, unknown> & {
  id: string
  version: string
  refundedCents: number
  refundableCents: number
  refunds: {
    id: string
    reason: string
    amountCents: number
    returnedProducts?: Record<string, number>
    createdAt: string
  }[]
}

const orderId = '5e5e5e5e-0000-4000-8000-000000000001'

/** 已付 ¥300、此前退过 ¥50 并退回 1 包材料的订单：还可退 ¥250，材料还可退回 2 包。 */
function paidOrder(): MockOrder {
  return {
    id: orderId,
    version: versionA,
    accountId: 'u-li',
    customer: li,
    status: 'paid',
    receivableCents: 30000,
    paidCents: 30000,
    refundedCents: 5000,
    refundableCents: 25000,
    settlement: 'standard',
    createdAt: '2026-10-04T02:30:00Z',
    lines: [
      { productId: 'p-bead', name: '拼豆材料包', quantity: 3, unitPriceCents: 5000 },
      { name: '计时服务费', quantity: 1, unitPriceCents: 16000 },
    ],
    discounts: [
      { id: 'd1', kind: 'fixed', amountCents: 1000, reason: '老顾客优惠', createdAt: '2026-10-04T02:29:00Z' },
    ],
    payments: [
      {
        id: 'pay1',
        method: 'cash',
        amountCents: 30000,
        createdAt: '2026-10-04T02:31:00Z',
        cashReceivedCents: 50000,
        changeCents: 20000,
      },
    ],
    refunds: [
      {
        id: 'r1',
        reason: '首次退货',
        amountCents: 5000,
        returnedProducts: { 'p-bead': 1 },
        createdAt: '2026-10-04T03:00:00Z',
      },
    ],
  }
}

/** 模拟后端登记退款：追加记录，已退、可退照后端规则变，版本换新。 */
function applyRefund(order: MockOrder, body: Record<string, unknown>, version: string): MockOrder {
  const amount = body.amountCents as number
  return {
    ...order,
    version,
    refundedCents: order.refundedCents + amount,
    refundableCents: order.refundableCents - amount,
    refunds: [
      ...order.refunds,
      {
        id: `r${order.refunds.length + 1}`,
        reason: body.reason as string,
        amountCents: amount,
        ...(body.returnedProducts ? { returnedProducts: body.returnedProducts as Record<string, number> } : {}),
        createdAt: '2026-10-04T08:00:00Z',
      },
    ],
  }
}

const manager = { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' as const }

/** 按钮样式的单选：原生 input 被文字盖住，点看得见的那块，再确认选中。 */
async function pickStatus(page: Page, name: string) {
  await page.locator('.toolbar .semi-radio', { hasText: name }).click()
  await expect(page.getByRole('radio', { name })).toBeChecked()
}

async function openRefundSheet(page: Page) {
  await page.getByRole('button', { name: '办理退款' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.getByText('办理退款 · 订单 5e5e5e5e')).toBeVisible()
  return sheet
}

test('列表：搜索、状态筛选、分页都写进网址，刷新后还在，点行进详情', async ({ page }) => {
  // 25 张单，序号越大越新；每 5 张有一张已退款，第 7、14、21 张待结账，第 3 张卖的是钥匙扣
  const orders = Array.from({ length: 25 }, (_, index) => {
    const n = index + 1
    const status = n % 5 === 0 ? 'refunded' : n % 7 === 0 ? 'draft' : 'paid'
    return {
      id: `${(0xa0000000 + n).toString(16)}-0000-4000-8000-000000000000`,
      version: versionA,
      accountId: n === 3 ? 'u-li' : undefined,
      customer: n === 3 ? li : null,
      status,
      receivableCents: 1000 * n,
      paidCents: status === 'draft' ? 0 : 1000 * n,
      refundedCents: status === 'refunded' ? 1000 * n : 0,
      refundableCents: status === 'paid' ? 1000 * n : 0,
      createdAt: new Date(Date.UTC(2026, 9, 1, 2, 0) + n * 60_000).toISOString(),
      lines: [{ name: n === 3 ? '钥匙扣' : '拼豆材料包', quantity: 1, unitPriceCents: 1000 * n }],
    }
  })
  // 筛选、分页由服务端做：记下网页发出的查询条件，按同样口径回这一页
  const listSearches: URLSearchParams[] = []
  const lastSearch = () => Object.fromEntries(listSearches.at(-1) ?? [])
  await mockApi(page, {
    handlers: [
      ({ method, path, search }) => {
        if (method !== 'GET' || path !== '/sales-orders') return undefined
        listSearches.push(new URLSearchParams(search))
        return orderListResult(orders, search)
      },
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orders[2].id}` ? { status: 200, body: orders[2] } : undefined,
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/orders')

  await expect(page.getByRole('heading', { name: '订单与退款' })).toBeVisible()
  const rows = page.locator('.semi-table-tbody .semi-table-row')
  await expect(page.getByText('共 25 单')).toBeVisible()
  await expect(rows).toHaveCount(20)
  // 新单在前：第一行是第 25 张（已退款）
  await expect(rows.first()).toContainText('a0000019')
  await expect(rows.first()).toContainText('已退款')
  await expect(rows.first()).toContainText('¥250.00')
  expect(lastSearch()).toEqual({ page: '1', pageSize: '20' })

  // 翻到第 2 页：向服务端要第 2 页
  await page.locator('.semi-page-item', { hasText: /^2$/ }).click()
  await expect(page).toHaveURL(/[?&]page=2/)
  await expect(rows).toHaveCount(5)
  expect(lastSearch()).toEqual({ page: '2', pageSize: '20' })

  // 筛已退款：页码回到第 1 页
  await pickStatus(page, '已退款')
  await expect(page).toHaveURL(/[?&]status=refunded/)
  await expect(page).not.toHaveURL(/page=/)
  await expect(rows).toHaveCount(5)
  for (const row of await rows.all()) await expect(row).toContainText('已退款')
  expect(lastSearch()).toEqual({ page: '1', pageSize: '20', status: 'refunded' })

  // 回到全部，按项目名搜：停手后才写进网址
  await pickStatus(page, '全部')
  await expect(page).not.toHaveURL(/status=/)
  await page.getByLabel('查找订单').fill('钥匙')
  await expect(page).toHaveURL(/[?&]q=%E9%92%A5%E5%8C%99/)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('钥匙扣')
  await expect(rows.first()).toContainText('小李 · 139****0002')
  await expect(page.getByText('符合条件的订单 1 单')).toBeVisible()
  expect(lastSearch()).toEqual({ page: '1', pageSize: '20', q: '钥匙' })

  // 带着网址参数直接打开：搜索框与筛选都还原
  await page.goto('/orders?q=a0000003&status=paid')
  await expect(page.getByLabel('查找订单')).toHaveValue('a0000003')
  await expect(page.getByRole('radio', { name: '已付款' })).toBeChecked()
  await expect(rows).toHaveCount(1)

  // 没有结果
  await pickStatus(page, '待结账')
  await expect(page.getByText('没有符合条件的订单')).toBeVisible()
  await pickStatus(page, '已付款')

  // 点行进详情，返回时带着原来的条件
  await rows.first().click()
  await expect(page).toHaveURL(new RegExp(`/orders/${orders[2].id}$`))
  await expect(page.getByRole('heading', { name: '订单 a0000003' })).toBeVisible()
  await page.getByRole('button', { name: '返回列表' }).click()
  await expect(page).toHaveURL(/\/orders\?q=a0000003&status=paid$/)
  await expect(page.getByLabel('查找订单')).toHaveValue('a0000003')
})

test('详情按接口展示金额与记录；店长逐件退款，带幂等键和读到的版本', async ({ page }) => {
  let current = paidOrder()
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orderId}` ? { status: 200, body: current } : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/refunds`) return undefined
        current = applyRefund(current, body as Record<string, unknown>, versionB)
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${orderId}`)

  await expect(page.getByRole('heading', { name: '订单 5e5e5e5e' })).toBeVisible()
  // 门店时区：02:30Z 是北京时间 10:30
  await expect(page.getByText('2026-10-04 10:30 · 小李 · 139****0002')).toBeVisible()
  const summary = page.locator('.semi-card', { hasText: '状态与金额' })
  await expect(summary.getByText('已付款')).toBeVisible()
  await expect(summary.getByText('部分退款')).toBeVisible()
  await expect(summary.getByText('¥50.00')).toBeVisible()
  await expect(summary.getByText('¥250.00')).toBeVisible()
  await expect(summary.getByText(orderId)).toBeVisible()
  const refunds = page.locator('.semi-card', { hasText: '退款记录' })
  await expect(refunds.getByRole('row', { name: /首次退货/ })).toContainText('拼豆材料包 ×1')
  const lines = page.locator('.semi-card', { hasText: '消费明细' })
  await expect(lines.getByRole('row', { name: /计时服务费/ })).toContainText('服务')
  await expect(lines.getByRole('row', { name: /计时服务费/ })).toContainText('¥160.00')
  await expect(lines.getByRole('row', { name: /拼豆材料包/ })).toContainText('商品')
  await expect(page.locator('.semi-card', { hasText: '折扣与优惠' })).toContainText('固定减免 ¥10.00')
  // 现金记了实收的：同一行写出实收与找零（后端记下的数）
  const cashRow = page.locator('.semi-card', { hasText: '付款记录' }).getByRole('row', { name: /现金/ })
  await expect(cashRow).toContainText('2026-10-04 10:31')
  await expect(cashRow).toContainText('实收 ¥500.00 · 找零 ¥200.00')

  const sheet = await openRefundSheet(page)
  await expect(sheet.getByText('拼豆材料包（售出 3 件，已退回 1 件，还可退 2 件）')).toBeVisible()
  // 服务费不关联商品，不能回补库存
  await expect(sheet.getByLabel('计时服务费 退回件数')).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: '登记退款（不回补库存）' })).toBeVisible()

  await sheet.getByLabel('退款金额（元）').fill('120')
  await sheet.getByLabel('拼豆材料包 退回件数').fill('2')
  await sheet.getByLabel('退款原因').fill('未拆封退货')
  await sheet.getByRole('button', { name: '登记退款并回补 2 件' }).click()

  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('订单 5e5e5e5e')).toBeVisible()
  await expect(dialog.getByText('退款金额：¥120.00')).toBeVisible()
  await expect(dialog.getByText('回补库存：拼豆材料包 2 件')).toBeVisible()
  await expect(dialog.getByText('原因：未拆封退货')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(page.getByText('退款已登记')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0]).toMatchObject({ method: 'POST', path: `/sales-orders/${orderId}/refunds` })
  expect(api.writes[0].body).toEqual({
    expectedVersion: versionA,
    amountCents: 12000,
    reason: '未拆封退货',
    returnedProducts: { 'p-bead': 2 },
  })
  expect(api.writes[0].idempotencyKey).toBeTruthy()

  // 成功后侧边栏关上，页面按接口重读：已退 ¥170、还可退 ¥130、两笔退款记录
  await expect(sheet.getByText('办理退款 · 订单 5e5e5e5e')).toBeHidden()
  await expect(page.getByText('退款记录（2 笔）')).toBeVisible()
  await expect(summary.getByText('¥170.00')).toBeVisible()
  await expect(summary.getByText('¥130.00')).toBeVisible()
  await expect(refunds.getByRole('row', { name: /未拆封退货/ })).toContainText('拼豆材料包 ×2')
})

test('退款超过可退金额、件数超过可退回数、没写原因：表单拦下，不发请求', async ({ page }) => {
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orderId}` ? { status: 200, body: paidOrder() } : undefined,
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${orderId}`)
  const sheet = await openRefundSheet(page)

  await sheet.getByLabel('退款金额（元）').fill('250.01')
  await sheet.getByLabel('拼豆材料包 退回件数').fill('3')
  // 超了上限的件数不算进按钮：按钮仍说不回补，绝不悄悄改成 2
  await sheet.getByRole('button', { name: '登记退款（不回补库存）' }).click()
  await expect(sheet.getByText('超过这一笔还可退的 ¥250.00')).toBeVisible()
  await expect(sheet.getByText('最多可退回 2 件')).toBeVisible()
  await expect(sheet.getByText('请填写退款原因')).toBeVisible()
  await expect(page.locator('.semi-modal')).toHaveCount(0)
  expect(api.writes).toHaveLength(0)

  // 「填入全部可退」用的是接口给的可退金额
  await sheet.getByRole('button', { name: '填入全部可退' }).click()
  await expect(sheet.getByLabel('退款金额（元）')).toHaveValue('250.00')
})

test('409 版本冲突：保留输入，提示订单已被修改，重新读取后由人再确认，绝不自动重提', async ({ page }) => {
  let current = paidOrder()
  let refundPosts = 0
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orderId}` ? { status: 200, body: current } : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/refunds`) return undefined
        refundPosts++
        if (refundPosts === 1) {
          // 就在这时，别人在另一台设备上退了 ¥50 并退回 1 包
          current = applyRefund(
            current,
            { amountCents: 5000, reason: '另一台设备', returnedProducts: { 'p-bead': 1 } },
            versionB,
          )
          return { status: 409, body: { code: 'order_version_conflict', message: '订单已被修改，请重新读取并确认' } }
        }
        current = applyRefund(current, body as Record<string, unknown>, versionC)
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${orderId}`)
  const sheet = await openRefundSheet(page)

  await sheet.getByLabel('退款金额（元）').fill('50')
  await sheet.getByLabel('拼豆材料包 退回件数').fill('1')
  await sheet.getByLabel('退款原因').fill('退货')
  await sheet.getByRole('button', { name: '登记退款并回补 1 件' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(sheet.getByText('订单已被修改')).toBeVisible()
  await expect(sheet.getByLabel('退款金额（元）')).toHaveValue('50')
  await expect(sheet.getByLabel('拼豆材料包 退回件数')).toHaveValue('1')
  await expect(sheet.getByLabel('退款原因')).toHaveValue('退货')
  await expect(sheet.getByRole('button', { name: '登记退款并回补 1 件' })).toBeDisabled()
  expect(api.writes).toHaveLength(1)
  expect((api.writes[0].body as { expectedVersion: string }).expectedVersion).toBe(versionA)

  await sheet.getByRole('button', { name: '重新读取' }).click()
  await expect(sheet.getByText('订单已被修改')).toBeHidden()
  // 上限换成最新的：还可退 ¥200、材料还可退回 1 包；填的内容还在
  await expect(sheet.getByText('拼豆材料包（售出 3 件，已退回 2 件，还可退 1 件）')).toBeVisible()
  await expect(sheet.locator('.semi-descriptions')).toContainText('¥200.00')
  await expect(sheet.getByLabel('退款金额（元）')).toHaveValue('50')
  expect(api.writes).toHaveLength(1)

  // 由人再确认一次才提交，带新版本、新幂等键
  await sheet.getByRole('button', { name: '登记退款并回补 1 件' }).click()
  await expect(page.locator('.semi-modal').getByText('退款金额：¥50.00')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()
  await expect(page.getByText('退款已登记')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toEqual({
    expectedVersion: versionB,
    amountCents: 5000,
    reason: '退货',
    returnedProducts: { 'p-bead': 1 },
  })
  expect(api.writes[1].idempotencyKey).toBeTruthy()
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
})

test('店员能看订单，看不到退款按钮；待结账的单提示去结账', async ({ page }) => {
  const draftId = 'd1d1d1d1-0000-4000-8000-000000000002'
  const draft = {
    id: draftId,
    version: versionA,
    status: 'draft',
    receivableCents: 2000,
    paidCents: 0,
    refundedCents: 0,
    refundableCents: 0,
    createdAt: '2026-10-04T05:00:00Z',
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 2000 }],
  }
  const clerk = { id: 'u-clerk', nickname: '小店员', roles: ['clerk'], phoneVerificationStatus: 'verified' as const }
  await mockApi(page, {
    account: clerk,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orderId}`
          ? { status: 200, body: paidOrder() }
          : method === 'GET' && path === `/sales-orders/${draftId}`
            ? { status: 200, body: draft }
            : undefined,
    ],
  })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })

  await page.goto(`/orders/${orderId}`)
  await expect(page.getByRole('heading', { name: '订单 5e5e5e5e' })).toBeVisible()
  await expect(page.getByText('退款需店长或老板办理。')).toBeVisible()
  await expect(page.getByRole('button', { name: '办理退款' })).toHaveCount(0)

  await page.goto(`/orders/${draftId}`)
  await expect(page.getByRole('heading', { name: '订单 d1d1d1d1' })).toBeVisible()
  await expect(page.getByText(/这张订单还没结账/)).toBeVisible()
  await expect(page.getByRole('button', { name: '去结账' })).toBeVisible()
  await expect(page.getByRole('button', { name: '办理退款' })).toHaveCount(0)
})

// ---- 会员结账单 ----

const memberOrderId = '6f6f6f6f-0000-4000-8000-000000000003'

/**
 * 会员结账：抵扣 30 积分，储值本金 ¥50、赠送 ¥10，现金补付 ¥37，送 97 积分。
 * 每次退款将退回什么只看后端预览（refund_quote），页面不从付款记录或 memberCheckout 推算。
 */
function memberOrder(): MockOrder {
  return {
    id: memberOrderId,
    version: versionA,
    accountId: 'u-li',
    customer: li,
    status: 'paid',
    receivableCents: 9700,
    paidCents: 9700,
    refundedCents: 0,
    refundableCents: 9700,
    settlement: 'member',
    memberCheckout: {
      principalCents: 5000,
      giftCents: 1000,
      pointsUsed: 30,
      pointsEarned: 97,
      offlineCents: 3700,
      // 结账那一刻的余额（后端由会员流水推出）
      balanceAfter: { principalCents: 2000, giftCents: 0, points: 164 },
    },
    createdAt: '2026-10-04T06:00:00Z',
    lines: [
      { productId: 'p-bead', name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
      { name: '计时服务费', quantity: 1, unitPriceCents: 6000 },
    ],
    discounts: [
      { id: 'd-pts', kind: 'fixed', amountCents: 300, reason: '积分抵扣 30 积分', createdAt: '2026-10-04T06:10:00Z' },
    ],
    payments: [
      { id: 'pay-balance', method: 'balance', amountCents: 6000, createdAt: '2026-10-04T06:10:00Z' },
      { id: 'pay-cash', method: 'cash', amountCents: 3700, createdAt: '2026-10-04T06:10:00Z' },
    ],
    refunds: [],
  }
}

type RefundPart = {
  offlineCents: number
  principalCents: number
  giftCents: number
  pointsRestored: number
  pointsClawedBack: number
}

/** 模拟后端按原付款比例算好的数：测试只用到这几个金额，照真后端的结果写死，页面只照抄。 */
const memberParts: Record<number, RefundPart> = {
  1940: { offlineCents: 740, principalCents: 1000, giftCents: 200, pointsRestored: 6, pointsClawedBack: 19 },
  4999: { offlineCents: 1907, principalCents: 2577, giftCents: 515, pointsRestored: 15, pointsClawedBack: 49 },
  7760: { offlineCents: 2960, principalCents: 4000, giftCents: 800, pointsRestored: 24, pointsClawedBack: 78 },
  9700: { offlineCents: 3700, principalCents: 5000, giftCents: 1000, pointsRestored: 30, pointsClawedBack: 97 },
}

const sumParts = (a: RefundPart | undefined, b: RefundPart): RefundPart =>
  a
    ? {
        offlineCents: a.offlineCents + b.offlineCents,
        principalCents: a.principalCents + b.principalCents,
        giftCents: a.giftCents + b.giftCents,
        pointsRestored: a.pointsRestored + b.pointsRestored,
        pointsClawedBack: a.pointsClawedBack + b.pointsClawedBack,
      }
    : b

type MemberActionBody = {
  action?: string
  targetId?: string
  expectedVersion?: string
  amountCents?: number
  reason?: string
  returnedProducts?: Record<string, number>
}

const memberAction = (method: string, path: string, body: unknown, action: string) =>
  method === 'POST' &&
  path === '/loyalty/actions' &&
  (body as MemberActionBody | undefined)?.action === action &&
  (body as MemberActionBody).targetId === memberOrderId

/** 模拟后端的会员退款预览。 */
function quoteOf(order: MockOrder, body: MemberActionBody, blocked?: Record<string, unknown>) {
  const amount = body.amountCents ?? order.refundableCents
  return {
    orderVersion: order.version,
    amountCents: amount,
    refundableCents: order.refundableCents,
    settlesOrder: amount === order.refundableCents,
    ...memberParts[amount],
    ...(blocked ? { blocked } : {}),
  }
}

/** 模拟后端的会员退款：追加一笔这次金额的退款，累计已退回照预览加上，退满变已退款，版本换新。 */
function applyMemberRefund(order: MockOrder, body: MemberActionBody, version: string): MockOrder {
  const amount = body.amountCents ?? order.refundableCents
  const checkout = order.memberCheckout as Record<string, unknown>
  const refundable = order.refundableCents - amount
  return {
    ...order,
    version,
    status: refundable === 0 ? 'refunded' : 'paid',
    refundedCents: order.refundedCents + amount,
    refundableCents: refundable,
    memberCheckout: {
      ...checkout,
      refunded: sumParts(checkout.refunded as RefundPart | undefined, memberParts[amount]),
    },
    refunds: [
      ...order.refunds,
      {
        id: `mr${order.refunds.length + 1}`,
        reason: body.reason ?? '',
        amountCents: amount,
        ...(body.returnedProducts ? { returnedProducts: body.returnedProducts } : {}),
        createdAt: '2026-10-04T08:00:00Z',
      },
    ],
  }
}

const versionConflict = {
  status: 409,
  body: { code: 'order_version_conflict', message: '订单已被修改，请重新读取并确认' },
}

interface MemberState {
  current: MockOrder
  /** 预览这笔金额时积分够不够扣回：不够就返回后端的说明。 */
  blocked?: (body: MemberActionBody) => Record<string, unknown> | undefined
}

/** 详情与预览两个接口；预览核对版本。 */
function memberHandlers(state: MemberState): MockHandler[] {
  return [
    ({ method, path }) =>
      method === 'GET' && path === `/sales-orders/${memberOrderId}` ? { status: 200, body: state.current } : undefined,
    ({ method, path, body }) => {
      if (!memberAction(method, path, body, 'refund_quote')) return undefined
      const input = body as MemberActionBody
      if (input.expectedVersion !== state.current.version) return versionConflict
      return { status: 200, body: quoteOf(state.current, input, state.blocked?.(input)) }
    },
  ]
}

const refundWrites = (writes: MockApi['writes']) =>
  writes.filter((write) => (write.body as MemberActionBody | undefined)?.action === 'refund')
const quoteWrites = (writes: MockApi['writes']) =>
  writes.filter((write) => (write.body as MemberActionBody | undefined)?.action === 'refund_quote')

async function openMemberRefundSheet(page: Page) {
  await page.getByRole('button', { name: '办理会员退款' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.getByText('会员退款 · 订单 6f6f6f6f')).toBeVisible()
  return sheet
}

test('会员结账单部分退款：金额由人填，将退回什么只照后端预览；确认带预览依据的版本、金额、顾客和幂等键', async ({
  page,
}) => {
  const state: MemberState = { current: memberOrder() }
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        state.current = applyMemberRefund(state.current, body as MemberActionBody, versionB)
        return { status: 200, body: state.current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)

  await expect(page.getByRole('heading', { name: '订单 6f6f6f6f' })).toBeVisible()
  const summary = page.locator('.semi-card', { hasText: '状态与金额' })
  await expect(summary.getByText('会员结账', { exact: true })).toBeVisible()
  await expect(summary.getByText('¥97.00（按原付款比例退，可分多次）')).toBeVisible()
  const card = page.locator('.semi-card', { hasText: '储值本金支付' })
  for (const [label, value] of [
    ['储值本金支付', '¥50.00'],
    ['赠送余额支付', '¥10.00'],
    ['积分抵扣', '30 积分'],
    ['本单所得积分', '97 积分'],
    ['线下补付', '¥37.00'],
    // 本单结账后的余额接在本单变动后面（同小票）
    ['结账后储值本金', '¥20.00'],
    ['结账后赠送余额', '¥0.00'],
    ['结账后可用积分', '164 积分'],
  ])
    await expect(card.locator('tr', { hasText: label })).toContainText(value)
  // 普通退款的入口不出现，换成会员退款
  await expect(page.getByRole('button', { name: '办理退款', exact: true })).toHaveCount(0)

  const sheet = await openMemberRefundSheet(page)
  await expect(sheet.getByText('填好金额后，这里显示这次将退回的线下、本金、赠送和积分。')).toBeVisible()
  // 服务费不能回补库存
  await expect(sheet.getByLabel('计时服务费 退回件数')).toHaveCount(0)
  await expect(sheet.getByText('拼豆材料包（售出 2 件，还可退 2 件）')).toBeVisible()

  // 金额、原因必填：拦下，不弹确认、不发请求
  const amountInput = sheet.getByLabel('这次退款金额（元）')
  await expect(amountInput).toHaveAttribute('aria-required', 'true')
  await expect(amountInput).toHaveAccessibleDescription(/最多 ¥97\.00，按原付款比例拆到线下、储值和积分/)
  await sheet.getByRole('button', { name: '会员退款（不回补库存）' }).click()
  await expect(sheet.getByText('请填写这次退款的金额（元，最多两位小数）')).toBeVisible()
  await expect(sheet.getByText('请填写退款原因')).toBeVisible()
  // 出错的输入框标为无效，错误说明读屏软件读得到
  await expect(amountInput).toHaveAttribute('aria-invalid', 'true')
  await expect(amountInput).toHaveAccessibleDescription(/请填写这次退款的金额/)
  await expect(sheet.getByLabel('退款原因')).toHaveAccessibleDescription('请填写退款原因')
  await expect(page.locator('.semi-modal')).toHaveCount(0)
  expect(api.writes).toHaveLength(0)

  // 停手后问后端：这次将退回什么，原样显示
  await sheet.getByLabel('这次退款金额（元）').fill('19.40')
  const preview = sheet.getByLabel('这次将退回')
  await expect(preview).toContainText('这次将退回：线下 ¥7.40、本金 ¥10.00、赠送 ¥2.00、积分 6，扣回消费积分 19')
  await expect(preview).toContainText('线下的 ¥7.40 系统不退，请按原付款方式（现金）退还顾客')
  await expect(preview).toContainText('恢复的 6 积分回到原批次，保留原到期时间')
  expect(quoteWrites(api.writes).at(-1)?.body).toEqual({
    action: 'refund_quote',
    accountId: 'u-li',
    targetId: memberOrderId,
    expectedVersion: versionA,
    amountCents: 1940,
  })

  await sheet.getByLabel('拼豆材料包 退回件数').fill('1')
  await sheet.getByLabel('退款原因').fill('少做了一件')
  await sheet.getByRole('button', { name: '会员退款并回补 1 件' }).click()

  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('确认会员退款', { exact: true })).toBeVisible()
  await expect(dialog.getByText('订单 6f6f6f6f · 小李 · 139****0002')).toBeVisible()
  await expect(dialog.getByText('退款金额 ¥19.40')).toBeVisible()
  await expect(
    dialog.getByText('这次将退回：线下 ¥7.40、本金 ¥10.00、赠送 ¥2.00、积分 6，扣回消费积分 19'),
  ).toBeVisible()
  await expect(dialog.getByText('回补库存：拼豆材料包 1 件')).toBeVisible()
  await expect(dialog.getByText('原因：少做了一件')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(page.getByText('会员退款已办理')).toBeVisible()
  const refunds = refundWrites(api.writes)
  expect(refunds).toHaveLength(1)
  expect(refunds[0].body).toEqual({
    action: 'refund',
    accountId: 'u-li',
    targetId: memberOrderId,
    expectedVersion: versionA,
    amountCents: 1940,
    reason: '少做了一件',
    returnedProducts: { 'p-bead': 1 },
  })
  expect(refunds[0].idempotencyKey).toBeTruthy()

  // 成功后侧边栏关上，页面按接口重读：部分退款、累计已退回、一笔退款记录，还能接着退
  await expect(sheet.getByText('会员退款 · 订单 6f6f6f6f')).toBeHidden()
  await expect(summary.getByText('部分退款')).toBeVisible()
  await expect(summary.getByText('¥77.60（按原付款比例退，可分多次）')).toBeVisible()
  await expect(card.getByText('已退回（1 次累计）')).toBeVisible()
  for (const [label, value] of [
    ['已退线下', '¥7.40'],
    ['已退本金', '¥10.00'],
    ['已退赠送', '¥2.00'],
    ['已恢复积分', '6 积分'],
    ['已扣回消费积分', '19 积分'],
  ])
    await expect(card.locator('tr', { hasText: label })).toContainText(value)
  await expect(
    page.locator('.semi-card', { hasText: '退款记录' }).getByRole('row', { name: /少做了一件/ }),
  ).toContainText('拼豆材料包 ×1')
  await expect(page.getByRole('button', { name: '办理会员退款' })).toBeVisible()
})

test('全部退完：填入剩余全部，预览说明零头在这次结清；提交后订单变已退款、没有退款入口', async ({ page }) => {
  const state: MemberState = {
    current: applyMemberRefund(
      memberOrder(),
      { amountCents: 1940, reason: '第一次', returnedProducts: { 'p-bead': 1 } },
      versionB,
    ),
  }
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        state.current = applyMemberRefund(state.current, body as MemberActionBody, versionC)
        return { status: 200, body: state.current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)
  const sheet = await openMemberRefundSheet(page)
  // 部分退过、退回过 1 包：上限扣掉已退回的
  await expect(sheet.getByText('拼豆材料包（售出 2 件，已退回 1 件，还可退 1 件）')).toBeVisible()

  await sheet.getByRole('button', { name: '全部退完' }).click()
  await expect(sheet.getByLabel('这次退款金额（元）')).toHaveValue('77.60')
  const preview = sheet.getByLabel('这次将退回')
  await expect(preview).toContainText('这次将退回：线下 ¥29.60、本金 ¥40.00、赠送 ¥8.00、积分 24，扣回消费积分 78')
  await expect(preview).toContainText('这次退完剩余全部，各项零头在这次结清，订单变为已退款')

  await sheet.getByLabel('退款原因').fill('顾客全部不要了')
  await sheet.getByRole('button', { name: '会员退款（不回补库存）' }).click()
  await expect(page.locator('.semi-modal').getByText('确认会员退款（退完剩余全部）')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(page.getByText('会员退款已办理')).toBeVisible()
  expect(refundWrites(api.writes).map((write) => write.body)).toEqual([
    {
      action: 'refund',
      accountId: 'u-li',
      targetId: memberOrderId,
      expectedVersion: versionB,
      amountCents: 7760,
      reason: '顾客全部不要了',
    },
  ])
  const summary = page.locator('.semi-card', { hasText: '状态与金额' })
  await expect(summary.getByText('已退款')).toBeVisible()
  await expect(page.getByText('退款记录（2 笔）')).toBeVisible()
  await expect(page.locator('.semi-card', { hasText: '储值本金支付' }).getByText('已退回（2 次累计）')).toBeVisible()
  await expect(page.getByRole('button', { name: '办理会员退款' })).toHaveCount(0)
})

test('会员退款 409：保留金额、原因与件数，重读后重新预览、由人再确认，带新版本和新幂等键', async ({ page }) => {
  const state: MemberState = { current: memberOrder() }
  let posts = 0
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        posts++
        // 第一次提交的同时订单版本换了，内容仍是没退过的已付款单（例如后端升级改了版本摘要）
        if (posts === 1) state.current = { ...state.current, version: versionB }
        if ((body as MemberActionBody).expectedVersion !== state.current.version) return versionConflict
        state.current = applyMemberRefund(state.current, body as MemberActionBody, versionC)
        return { status: 200, body: state.current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)
  const sheet = await openMemberRefundSheet(page)

  await sheet.getByLabel('这次退款金额（元）').fill('19.40')
  await expect(sheet.getByLabel('这次将退回')).toContainText('线下 ¥7.40')
  await sheet.getByLabel('拼豆材料包 退回件数').fill('2')
  await sheet.getByLabel('退款原因').fill('作品返工')
  await sheet.getByRole('button', { name: '会员退款并回补 2 件' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(sheet.getByText('订单已被修改')).toBeVisible()
  await expect(sheet.getByLabel('这次退款金额（元）')).toHaveValue('19.40')
  await expect(sheet.getByLabel('拼豆材料包 退回件数')).toHaveValue('2')
  await expect(sheet.getByLabel('退款原因')).toHaveValue('作品返工')
  await expect(sheet.getByRole('button', { name: '会员退款并回补 2 件' })).toBeDisabled()
  expect(refundWrites(api.writes)).toHaveLength(1)
  expect((refundWrites(api.writes)[0].body as MemberActionBody).expectedVersion).toBe(versionA)

  await sheet.getByRole('button', { name: '重新读取' }).click()
  await expect(sheet.getByText('订单已被修改')).toBeHidden()
  // 按新版本重新预览
  await expect(sheet.getByLabel('这次将退回')).toContainText('线下 ¥7.40')
  expect((quoteWrites(api.writes).at(-1)?.body as MemberActionBody).expectedVersion).toBe(versionB)
  expect(refundWrites(api.writes)).toHaveLength(1)

  // 由人再确认一次才提交
  await sheet.getByRole('button', { name: '会员退款并回补 2 件' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()
  await expect(page.getByText('会员退款已办理')).toBeVisible()
  const refunds = refundWrites(api.writes)
  expect(refunds).toHaveLength(2)
  expect(refunds[1].body).toEqual({
    action: 'refund',
    accountId: 'u-li',
    targetId: memberOrderId,
    expectedVersion: versionB,
    amountCents: 1940,
    reason: '作品返工',
    returnedProducts: { 'p-bead': 2 },
  })
  expect(refunds[1].idempotencyKey).toBeTruthy()
  expect(refunds[1].idempotencyKey).not.toBe(refunds[0].idempotencyKey)
})

test('会员退款 409 后重读发现别人已经退完：停在说明上，不能再提交', async ({ page }) => {
  const state: MemberState = { current: memberOrder() }
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        if ((body as MemberActionBody).expectedVersion !== state.current.version) return versionConflict
        state.current = applyMemberRefund(state.current, body as MemberActionBody, versionC)
        return { status: 200, body: state.current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)
  const sheet = await openMemberRefundSheet(page)
  await sheet.getByLabel('这次退款金额（元）').fill('19.40')
  await expect(sheet.getByLabel('这次将退回')).toContainText('线下 ¥7.40')
  await sheet.getByLabel('退款原因').fill('重复操作')
  // 填写期间，另一台设备上已经把这张单全部退完
  state.current = applyMemberRefund(state.current, { reason: '另一台设备' }, versionB)
  await sheet.getByRole('button', { name: '会员退款（不回补库存）' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(sheet.getByText('订单已被修改')).toBeVisible()
  await sheet.getByRole('button', { name: '重新读取' }).click()
  await expect(sheet.getByText('这张订单已经全部退完，不能再退。')).toBeVisible()
  await expect(sheet.getByRole('button', { name: '会员退款（不回补库存）' })).toBeDisabled()
  expect(refundWrites(api.writes)).toHaveLength(1)
})

test('送出的积分被用掉：详情提前说明缺多少、最多能退多少；预览按金额拦下，改成最多能退的金额就能退', async ({
  page,
}) => {
  const otherOrderId = '7a7a7a7a-0000-4000-8000-000000000009'
  const spentBy = [
    { kind: 'checkout', sourceId: otherOrderId, points: 40, createdAt: '2026-10-04T09:00:00Z' },
    { kind: 'exchange', sourceId: 'rule-gift', points: 8, createdAt: '2026-10-04T10:00:00Z' },
  ]
  // 顾客这批积分只剩 49 分：要扣回的超过 49 分就退不了（退 ¥49.99 扣回 49 分，正好是最多能退的）
  const reasonFor = (clawBack: number) =>
    `本单送出的积分已被用掉：这次退款要按比例收回 ${clawBack} 积分，还缺 ${clawBack - 49} 积分，暂时不能退。先把用掉这些积分的会员结账单退款，积分回到本单后再退；或者这次少退一些，现在最多能退 ¥49.99`
  const order = memberOrder()
  order.memberCheckout = {
    ...(order.memberCheckout as Record<string, unknown>),
    refundBlocked: { reason: reasonFor(97), pointsShort: 48, maxRefundableCents: 4999, spentBy },
  }
  const state: MemberState = {
    current: order,
    blocked: (body) => {
      const part = memberParts[body.amountCents ?? 9700]
      return part.pointsClawedBack > 49
        ? {
            reason: reasonFor(part.pointsClawedBack),
            pointsShort: part.pointsClawedBack - 49,
            maxRefundableCents: 4999,
            spentBy,
          }
        : undefined
    },
  }
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        state.current = applyMemberRefund(state.current, body as MemberActionBody, versionB)
        return { status: 200, body: state.current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)

  const card = page.locator('.semi-card', { hasText: '储值本金支付' })
  await expect(
    card.getByText('退不完剩余全部：本单送出的积分已被用掉，扣回还缺 48 分，现在最多能退 ¥49.99'),
  ).toBeVisible()
  await expect(card.getByText('2026-10-04 17:00 会员结账抵扣 用掉 40 积分')).toBeVisible()
  await expect(card.getByRole('link', { name: '7a7a7a7a' })).toHaveAttribute('href', `/orders/${otherOrderId}`)
  await expect(card.getByText('2026-10-04 18:00 积分兑换 用掉 8 积分')).toBeVisible()

  // 还能少退：侧栏照常可填；退剩余全部被预览拦下，提交按钮不可用
  const sheet = await openMemberRefundSheet(page)
  await sheet.getByRole('button', { name: '全部退完' }).click()
  await expect(sheet.getByText('这次退 ¥97.00 要扣回 97 积分，还缺 48 分')).toBeVisible()
  await expect(sheet.getByText(`${reasonFor(97)}。`)).toBeVisible()
  await sheet.getByLabel('退款原因').fill('先退能退的')
  await expect(sheet.getByRole('button', { name: '会员退款（不回补库存）' })).toBeDisabled()

  await sheet.getByRole('button', { name: '改为现在最多能退的 ¥49.99' }).click()
  await expect(sheet.getByLabel('这次退款金额（元）')).toHaveValue('49.99')
  await expect(sheet.getByLabel('这次将退回')).toContainText(
    '这次将退回：线下 ¥19.07、本金 ¥25.77、赠送 ¥5.15、积分 15，扣回消费积分 49',
  )
  await sheet.getByRole('button', { name: '会员退款（不回补库存）' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()
  await expect(page.getByText('会员退款已办理')).toBeVisible()
  expect(refundWrites(api.writes).map((write) => (write.body as MemberActionBody).amountCents)).toEqual([4999])
})

test('预览之后顾客又用掉了积分：提交被拒时照原话显示，重新预览改为说明缺口，不能照旧的数再提交', async ({ page }) => {
  // 顾客在网页预览之后、提交之前，又在别处用掉了本单送的积分，这批只剩 10 分：退 ¥19.40 要扣回 19 分，缺 9 分
  const reason =
    '本单送出的积分已被用掉：这次退款要按比例收回 19 积分，还缺 9 积分，暂时不能退。先把用掉这些积分的会员结账单退款，积分回到本单后再退；或者这次少退一些，现在最多能退 ¥10.99'
  const blocked = {
    reason,
    pointsShort: 9,
    maxRefundableCents: 1099,
    spentBy: [{ kind: 'exchange', sourceId: 'rule-gift', points: 87, createdAt: '2026-10-04T10:00:00Z' }],
  }
  const state: MemberState = { current: memberOrder() }
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ...memberHandlers(state),
      ({ method, path, body }) => {
        if (!memberAction(method, path, body, 'refund')) return undefined
        state.blocked = () => blocked
        return { status: 409, body: { code: 'loyalty_conflict', message: reason } }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)
  const sheet = await openMemberRefundSheet(page)

  await sheet.getByLabel('这次退款金额（元）').fill('19.40')
  await expect(sheet.getByLabel('这次将退回')).toContainText('扣回消费积分 19')
  await sheet.getByLabel('退款原因').fill('少做了一件')
  await sheet.getByRole('button', { name: '会员退款（不回补库存）' }).click()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  // 被拒：后端的原话显示在上方；同一版本重新预览，改为说明缺口和现在最多能退多少，提交按钮不可用
  await expect(sheet.locator('.semi-banner-danger', { hasText: reason })).toBeVisible()
  await expect(sheet.getByText('这次退 ¥19.40 要扣回 19 积分，还缺 9 分')).toBeVisible()
  await expect(sheet.getByRole('button', { name: '改为现在最多能退的 ¥10.99' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: '会员退款（不回补库存）' })).toBeDisabled()
  const quotes = quoteWrites(api.writes)
  expect(quotes).toHaveLength(2)
  expect(quotes[1].body).toEqual(quotes[0].body)
  expect(refundWrites(api.writes)).toHaveLength(1)
  // 填写的内容都还在
  await expect(sheet.getByLabel('这次退款金额（元）')).toHaveValue('19.40')
  await expect(sheet.getByLabel('退款原因')).toHaveValue('少做了一件')
})

test('Esc 关侧栏：没填过直接关；填过先问，问的时候按 Esc 只关提问、填写的内容还在', async ({ page }) => {
  const api = await mockApi(page, { account: manager, handlers: memberHandlers({ current: memberOrder() }) })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)

  let sheet = await openMemberRefundSheet(page)
  await page.keyboard.press('Escape')
  await expect(sheet.getByText('会员退款 · 订单 6f6f6f6f')).toBeHidden()

  sheet = await openMemberRefundSheet(page)
  await sheet.getByLabel('这次退款金额（元）').fill('19.40')
  await page.keyboard.press('Escape')
  const ask = page.locator('.semi-modal', { hasText: '放弃这次退款？' })
  await expect(ask).toBeVisible()
  // 会丢掉填写的内容：确认按钮是危险样式
  await expect(ask.getByRole('button', { name: '放弃', exact: true })).toHaveClass(/semi-button-danger/)
  await page.keyboard.press('Escape')
  await expect(ask).toBeHidden()
  await expect(sheet.getByText('会员退款 · 订单 6f6f6f6f')).toBeVisible()
  await expect(sheet.getByLabel('这次退款金额（元）')).toHaveValue('19.40')

  await page.keyboard.press('Escape')
  await page.locator('.semi-modal button', { hasText: '放弃' }).click()
  await expect(sheet.getByText('会员退款 · 订单 6f6f6f6f')).toBeHidden()
  expect(refundWrites(api.writes)).toHaveLength(0)
})

test('送出的积分被用掉、一分也退不了：侧栏停在后端给的原因上，不能填也不能提交', async ({ page }) => {
  const reason =
    '本单送出的积分已被用掉：这次退款要按比例收回 97 积分，还缺 97 积分，暂时不能退。先把用掉这些积分的会员结账单退款，积分回到本单后再退'
  const order = memberOrder()
  order.memberCheckout = {
    ...(order.memberCheckout as Record<string, unknown>),
    refundBlocked: { reason, pointsShort: 97, maxRefundableCents: 0, spentBy: [] },
  }
  const api = await mockApi(page, { account: manager, handlers: memberHandlers({ current: order }) })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${memberOrderId}`)

  await expect(
    page
      .locator('.semi-card', { hasText: '储值本金支付' })
      .getByText('暂时不能退：本单送出的积分已被用掉，扣回还缺 97 分'),
  ).toBeVisible()
  const sheet = await openMemberRefundSheet(page)
  await expect(sheet.locator('.semi-banner', { hasText: reason })).toBeVisible()
  await expect(sheet.getByLabel('这次退款金额（元）')).toBeDisabled()
  await expect(sheet.getByRole('button', { name: '会员退款（不回补库存）' })).toBeDisabled()
  expect(api.writes).toHaveLength(0)
})

test('店员能看会员结账单，没有退款入口；列表里会员结账单带标识', async ({ page }) => {
  const clerk = { id: 'u-clerk', nickname: '小店员', roles: ['clerk'], phoneVerificationStatus: 'verified' as const }
  const api = await mockApi(page, {
    account: clerk,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/sales-orders'
          ? { status: 200, body: [paidOrder(), memberOrder()] }
          : method === 'GET' && path === `/sales-orders/${memberOrderId}`
            ? { status: 200, body: memberOrder() }
            : undefined,
    ],
  })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })

  await page.goto('/orders')
  const rows = page.locator('.semi-table-tbody .semi-table-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: '6f6f6f6f' })).toContainText('会员结账')
  await expect(rows.filter({ hasText: '5e5e5e5e' })).not.toContainText('会员结账')

  await rows.filter({ hasText: '6f6f6f6f' }).click()
  await expect(page.getByRole('heading', { name: '订单 6f6f6f6f' })).toBeVisible()
  await expect(
    page.locator('.semi-card', { hasText: '状态与金额' }).getByText('会员结账', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.semi-card', { hasText: '储值本金支付' })).toContainText('¥50.00')
  await expect(page.getByText('退款需店长或老板办理。')).toBeVisible()
  await expect(page.getByRole('button', { name: '办理会员退款' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '办理退款', exact: true })).toHaveCount(0)
  expect(api.writes).toHaveLength(0)
})

/** 分两笔收（微信 ¥40、支付宝 ¥30），剩下 ¥30 免单的订单；每笔的已退、可退照接口。 */
function splitOrder(): MockOrder {
  return {
    id: orderId,
    version: versionA,
    status: 'paid',
    receivableCents: 10000,
    paidCents: 7000,
    refundedCents: 0,
    refundableCents: 7000,
    outstandingCents: 0,
    compCents: 3000,
    settlement: 'standard',
    customer: null,
    createdAt: '2026-10-06T02:00:00Z',
    lines: [{ name: '计时服务费', quantity: 1, unitPriceCents: 10000 }],
    payments: [
      {
        id: 'pay-1',
        method: 'wechat',
        amountCents: 4000,
        createdAt: '2026-10-06T02:30:00Z',
        refundedCents: 0,
        refundableCents: 4000,
      },
      {
        id: 'pay-2',
        method: 'alipay',
        amountCents: 3000,
        createdAt: '2026-10-06T02:31:00Z',
        refundedCents: 0,
        refundableCents: 3000,
      },
      { id: 'comp-1', method: 'comp', amountCents: 3000, reason: '朋友没带钱', createdAt: '2026-10-06T02:32:00Z' },
    ],
    refunds: [],
  }
}

test('分笔收款的单按笔退款：先选哪一笔，上限是这一笔还可退的，请求带 paymentId；免单那一笔不给退', async ({ page }) => {
  let current = splitOrder()
  const api = await mockApi(page, {
    account: manager,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === `/sales-orders/${orderId}` ? { status: 200, body: current } : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== `/sales-orders/${orderId}/refunds`) return undefined
        const input = body as { paymentId: string; amountCents: number }
        const refunded = applyRefund(current, body as Record<string, unknown>, versionB)
        current = {
          ...refunded,
          payments: (current.payments as Record<string, unknown>[]).map((payment) =>
            payment.id === input.paymentId
              ? {
                  ...payment,
                  refundedCents: (payment.refundedCents as number) + input.amountCents,
                  refundableCents: (payment.refundableCents as number) - input.amountCents,
                }
              : payment,
          ),
        }
        return { status: 201, body: current }
      },
    ],
  })
  await signIn(page, { id: manager.id, nickname: manager.nickname, roles: manager.roles })
  await page.goto(`/orders/${orderId}`)

  // 剩余免单：标出免掉多少与原因，收到的两笔照常能退
  await expect(page.getByText('剩余 ¥30.00 已免单')).toBeVisible()
  const payments = page.locator('.semi-card', { hasText: '付款记录（分 2 笔收）' })
  await expect(payments.getByRole('row', { name: /免单原因：朋友没带钱/ })).toContainText('不能退款')
  await expect(payments.getByRole('row', { name: /免单原因/ }).getByRole('button')).toHaveCount(0)
  await expect(payments.getByRole('row', { name: /微信/ }).getByRole('button', { name: '退这笔' })).toBeVisible()

  // 顶上的「办理退款」：两笔都能退，让员工自己选
  await page.getByRole('button', { name: '办理退款' }).click()
  const sheet = page.locator('.semi-sidesheet')
  const choices = sheet.getByRole('radiogroup', { name: '退哪一笔' })
  await expect(choices.getByRole('radio')).toHaveCount(2)
  await expect(choices.getByRole('radio', { checked: true })).toHaveCount(0)
  await sheet.getByLabel('退款金额（元）').fill('35')
  await sheet.getByLabel('退款原因').fill('朋友先走了')
  await sheet.getByRole('button', { name: '登记退款（不回补库存）' }).click()
  await expect(sheet.getByText('请选择退哪一笔')).toBeVisible()
  expect(api.writes).toHaveLength(0)
  // 选支付宝那一笔：¥35 超过这一笔还可退的 ¥30
  await sheet.locator('.semi-radio', { hasText: '支付宝 ¥30.00' }).click()
  await sheet.getByRole('button', { name: '登记退款（不回补库存）' }).click()
  await expect(sheet.getByText('超过这一笔还可退的 ¥30.00')).toBeVisible()
  expect(api.writes).toHaveLength(0)
  await sheet.getByLabel('退款金额（元）').fill('30')
  await sheet.getByRole('button', { name: '登记退款（不回补库存）' }).click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('退哪一笔：支付宝 ¥30.00')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()
  await expect(page.getByText('退款已登记')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toEqual({
    paymentId: 'pay-2',
    amountCents: 3000,
    reason: '朋友先走了',
    expectedVersion: versionA,
  })

  // 付款记录里点「退这笔」：直接是那一笔（只剩微信能退了）
  await expect(payments.getByRole('row', { name: /支付宝/ }).getByRole('button')).toHaveCount(0)
  await payments.getByRole('row', { name: /微信/ }).getByRole('button', { name: '退这笔' }).click()
  await expect(sheet.getByText(/退的是：微信 ¥40.00/)).toBeVisible()
  await expect(sheet.getByLabel('退款金额（元）')).toHaveAccessibleDescription(/这一笔最多 ¥40.00/)
})
