import { expect, test, type Page } from '@playwright/test'
import { memberListResult } from './account-list'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 会员资产：搜索与详情（查找、分页在服务端）、流水分页、手动加减与充值退款（原因必填、确认、幂等键）、
// 版本冲突后重读再确认、店长只能看不能办理。

const lin = 'aaaa1111-0000-4000-8000-000000000001'
const wang = 'bbbb2222-0000-4000-8000-000000000002'
const bei = 'cccc3333-0000-4000-8000-000000000003'

const balance = (overrides: Record<string, unknown> = {}) => ({
  principalCents: 0,
  giftCents: 0,
  points: 0,
  boardUses: 0,
  expiringPoints: 0,
  tierName: '普通会员',
  rateBasisPoints: 10000,
  ...overrides,
})

const linBalance = balance({
  principalCents: 50000,
  giftCents: 5000,
  points: 320,
  expiringPoints: 120,
  tierName: '金卡会员',
  rateBasisPoints: 9500,
})

const members = [
  { id: wang, nickname: '小王', phoneMasked: '139****5678', balance: balance() },
  { id: lin, nickname: '小林', phoneMasked: '138****1234', balance: linBalance },
  { id: bei, nickname: '阿贝', phoneMasked: '', balance: balance() },
]

const recharge = {
  id: 'e-recharge',
  accountId: lin,
  kind: 'recharge',
  sourceId: 'rule-500',
  reason: '',
  method: 'wechat',
  principalCents: 50000,
  giftCents: 5000,
  points: [{ lotId: 'e-recharge', delta: 200, expiresAt: '2027-09-01T02:00:00Z' }],
  rule: { id: 'rule-500', kind: 'recharge', name: '充 500 送 50' },
  createdAt: '2026-09-01T02:00:00Z',
}

/** 12 条消费积分，加上最早那笔充值一共 13 条，流水分两页。 */
const earned = Array.from({ length: 12 }, (_, index) => ({
  id: `e-earned-${index + 1}`,
  accountId: lin,
  kind: 'earned',
  sourceId: `${String(index + 1).padStart(8, '0')}-order`,
  reason: '',
  principalCents: 0,
  giftCents: 0,
  points: [{ lotId: `e-earned-${index + 1}`, delta: 10 }],
  createdAt: `2026-09-${String(index + 2).padStart(2, '0')}T06:00:00Z`,
}))

function memberView(version: string, entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    balance: linBalance,
    profile: { birthday: '03-05', birthdayYear: 2026 },
    entries,
    rules: [],
    admissions: [],
    version,
    ...overrides,
  }
}

/** GET /loyalty/members：服务端按关键字筛、按昵称拼音排、分页。 */
const membersHandler: MockHandler = ({ method, path, search }) =>
  method === 'GET' && path === '/loyalty/members' ? memberListResult(members, search) : undefined

const listCard = (page: Page) => page.locator('.semi-card', { hasText: '查找会员' })
const memberRows = (page: Page) => listCard(page).locator('.semi-table-tbody .semi-table-row')
const detailCard = (page: Page) => page.locator('.semi-card', { hasText: '资产流水' })
const entryRows = (page: Page) => detailCard(page).locator('.semi-table-tbody .semi-table-row')

test('搜会员、看资产与流水，流水分页，地址里记着搜索和页码', async ({ page }) => {
  // 生产 CSP 下页面没有报错
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  const reads: string[] = []
  const listSearches: Record<string, string>[] = []
  await mockApi(page, {
    handlers: [
      ({ method, path, search }) => {
        if (method === 'GET' && path === '/loyalty/members') listSearches.push(Object.fromEntries(search))
        return membersHandler({ method, path, search, body: undefined })
      },
      ({ method, path, search }) => {
        if (method !== 'GET' || path !== '/loyalty/account') return undefined
        reads.push(search.get('accountId') ?? '')
        return { status: 200, body: memberView('m-v1', [recharge, ...earned]) }
      },
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/members')

  await expect(page.getByRole('heading', { name: '会员资产' })).toBeVisible()
  await expect(page.getByText('先选一位会员')).toBeVisible()
  const list = memberRows(page)
  await expect(list).toHaveCount(3)
  // 服务端按昵称拼音排，只取一页
  await expect(list.first()).toContainText('阿贝')
  expect(listSearches.at(-1)).toEqual({ page: '1', pageSize: '10' })

  // 输入停下来才写进地址，交给服务端筛
  await page.getByLabel('查找会员').fill('1234')
  // 路由把像数字的文字加引号存进地址，读回来仍是文字
  await expect(page).toHaveURL(/q=(%22)?1234/)
  await expect(list).toHaveCount(1)
  expect(listSearches.at(-1)).toEqual({ page: '1', pageSize: '10', q: '1234' })
  await page.getByLabel('查找会员').fill('不存在的人')
  await expect(page.getByText('没有匹配的会员')).toBeVisible()
  await page.getByLabel('查找会员').fill('aaaa11')
  await expect(list).toHaveCount(1)
  await list.filter({ hasText: '小林' }).click()
  await expect(page).toHaveURL(new RegExp(`account=${lin}`))

  // 资产全部来自接口
  const assets = page.locator('.semi-card', { hasText: '30 天内到期积分' })
  await expect(assets.getByText('¥550.00')).toBeVisible()
  await expect(assets.getByText('¥50.00')).toBeVisible()
  await expect(assets.getByText('320', { exact: true })).toBeVisible()
  await expect(assets.getByText('120', { exact: true })).toBeVisible()
  await expect(assets.getByText('金卡会员')).toBeVisible()
  await expect(assets.getByText('9.5 折')).toBeVisible()
  await expect(assets.getByText('3 月 5 日（2026 年设置）')).toBeVisible()
  expect(reads).toContain(lin)

  // 流水最新的在前，一页 10 条
  await expect(detailCard(page).getByText('共 13 条，最新的在前')).toBeVisible()
  await expect(entryRows(page)).toHaveCount(10)
  await expect(entryRows(page).first()).toContainText('消费积分')
  await expect(entryRows(page).first()).toContainText('订单 00000012')
  await detailCard(page).locator('.semi-page-item', { hasText: /^2$/ }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(entryRows(page)).toHaveCount(3)
  const rechargeRow = entryRows(page).filter({ hasText: '充值入账' })
  await expect(rechargeRow).toContainText('充 500 送 50 · 微信线下收款')
  await expect(rechargeRow).toContainText('+¥500.00')
  await expect(rechargeRow).toContainText('+200')
  await expect(rechargeRow).toContainText('2027-09-01 到期')

  // 刷新页面，地址里的会员和页码还在
  await page.reload()
  await expect(entryRows(page)).toHaveCount(3)
  await expect(page.getByLabel('查找会员')).toHaveValue('aaaa11')

  // 手打进地址栏的纯数字尾号也能搜
  await page.goto('/members?q=5678')
  await expect(page.getByLabel('查找会员')).toHaveValue('5678')
  await expect(list).toHaveCount(1)
  await expect(list).toContainText('小王')
  expect(problems).toEqual([])
})

test('会员多时左边列表在服务端分页；直接打开不在这一页的会员，另读账户资料拿称呼', async ({ page }) => {
  const many = Array.from({ length: 23 }, (_, index) => {
    const n = String(index + 1).padStart(2, '0')
    return {
      id: `000000${n}-0000-4000-8000-000000000000`,
      nickname: `会员${n}`,
      phoneMasked: `139****00${n}`,
      balance: balance({ principalCents: (index + 1) * 100 }),
    }
  })
  const last = many[22]
  const listSearches: Record<string, string>[] = []
  const profileReads: string[] = []
  await mockApi(page, {
    handlers: [
      ({ method, path, search }) => {
        if (method !== 'GET' || path !== '/loyalty/members') return undefined
        if (!many.some((member) => member.id === search.get('q'))) listSearches.push(Object.fromEntries(search))
        return memberListResult(many, search)
      },
      ({ method, path }) => {
        if (method !== 'GET' || path !== `/accounts/${last.id}`) return undefined
        profileReads.push(last.id)
        return {
          status: 200,
          body: { ...last, balance: undefined, roles: [], phoneVerificationStatus: 'verified' },
        }
      },
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account'
          ? { status: 200, body: memberView('m-v1', [recharge]) }
          : undefined,
    ],
  })
  await signIn(page, { id: 'u-owner' })

  // 直接打开第 3 页上那位会员的地址：左边是第 1 页，右边的称呼另读账户资料
  await page.goto(`/members?account=${last.id}`)
  const list = memberRows(page)
  await expect(list).toHaveCount(10)
  await expect(list.first()).toContainText('会员01')
  expect(listSearches.at(-1)).toEqual({ page: '1', pageSize: '10' })
  const assets = page.locator('.semi-card', { hasText: '30 天内到期积分' })
  await expect(assets).toContainText('会员23')
  await expect(assets).toContainText('139****0023')
  expect(profileReads).toEqual([last.id])

  // 翻到第 3 页：向服务端要第 3 页，地址里记着；右边的会员不变
  await listCard(page).locator('.semi-page-item', { hasText: /^3$/ }).click()
  await expect(page).toHaveURL(/listPage=3/)
  await expect(list).toHaveCount(3)
  expect(listSearches.at(-1)).toEqual({ page: '3', pageSize: '10' })
  await expect(assets).toContainText('会员23')

  // 点第 3 页的一位，再翻回第 1 页：右边仍是他的称呼，不用另读
  await list.filter({ hasText: '会员21' }).click()
  await expect(page).toHaveURL(new RegExp(`account=${many[20].id}`))
  await expect(assets).toContainText('会员21')
  await listCard(page).locator('.semi-page-item', { hasText: /^1$/ }).click()
  await expect(page).not.toHaveURL(/listPage=/)
  await expect(list.first()).toContainText('会员01')
  await expect(assets).toContainText('会员21')
  await expect(assets).toContainText('139****0021')
  expect(profileReads).toEqual([last.id])

  // 换搜索词：列表回到第 1 页
  await listCard(page).locator('.semi-page-item', { hasText: /^2$/ }).click()
  await expect(page).toHaveURL(/listPage=2/)
  await page.getByLabel('查找会员').fill('0002')
  await expect(page).not.toHaveURL(/listPage=/)
  await expect(list).toHaveCount(1)
  await expect(list).toContainText('会员02')
  expect(listSearches.at(-1)).toEqual({ page: '1', pageSize: '10', q: '0002' })
})

test('手动加减：原因必填、至少调一项，确认框写清调整后各是多少，确认后带版本和幂等键提交', async ({ page }) => {
  let version = 1
  const api = await mockApi(page, {
    handlers: [
      membersHandler,
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account'
          ? { status: 200, body: memberView(`m-v${version}`, [recharge]) }
          : undefined,
      ({ method, path }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        version++
        return { status: 200, body: memberView(`m-v${version}`, [recharge]) }
      },
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto(`/members?account=${lin}`)
  const card = page.locator('.semi-card', { hasText: '手动加减' })
  await expect(card).toBeVisible()

  // 什么都没填：原因必填、至少调整一项
  await card.getByRole('button', { name: '提交调整' }).click()
  await expect(card.getByText('请填写调整原因')).toBeVisible()
  await expect(card.getByText('本金、赠送余额、积分、智能豆板次数至少调整一项')).toBeVisible()
  // 金额最多两位小数
  await page.getByLabel('本金调整（元）').fill('-5.001')
  await expect(card.getByText('金额最多两位小数，可带负号，绝对值不超过 1000 万元')).toBeVisible()
  // 错误挂在输入框上：标成填错，读屏聚焦时念出原因
  await expect(page.getByLabel('本金调整（元）')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('本金调整（元）')).toHaveAccessibleDescription(
    '金额最多两位小数，可带负号，绝对值不超过 1000 万元',
  )
  await page.getByLabel('本金调整（元）').fill('-5')
  await page.getByLabel('积分调整').fill('+10')
  await page.getByLabel('调整原因').fill('10 月 2 日充值时本金录多了 5 元')
  await expect(card.getByText('请填写调整原因')).toHaveCount(0)
  expect(api.writes).toHaveLength(0)

  await card.getByRole('button', { name: '提交调整' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认手动加减' })
  await expect(dialog.getByText('会员：小林 · 138****1234')).toBeVisible()
  await expect(dialog.getByText('当前：本金 ¥500.00、赠送余额 ¥50.00、积分 320')).toBeVisible()
  await expect(dialog.getByText('本次调整：本金 -¥5.00、积分 +10')).toBeVisible()
  await expect(dialog.getByText('调整后：本金 ¥495.00、赠送余额 ¥50.00、积分 330')).toBeVisible()
  // 先取消：不提交
  await dialog.locator('button', { hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.writes).toHaveLength(0)

  await card.getByRole('button', { name: '提交调整' }).click()
  await page.locator('.semi-modal button', { hasText: '确认调整' }).click()
  await expect(page.getByText('已调整，另记了一条「资产调整」流水')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/loyalty/actions',
      body: {
        action: 'adjust',
        accountId: lin,
        expectedVersion: 'm-v1',
        principalCents: -500,
        giftCents: 0,
        points: 10,
        boardUses: 0,
        reason: '10 月 2 日充值时本金录多了 5 元',
      },
      idempotencyKey: expect.any(String),
    },
  ])
  // 成功后清空表单
  await expect(page.getByLabel('本金调整（元）')).toHaveValue('')
})

test('会员资产版本冲突：提示重读，重读后按新版本再确认', async ({ page }) => {
  let version = 1
  let accountReads = 0
  let conflictOnce = true
  const api = await mockApi(page, {
    handlers: [
      membersHandler,
      ({ method, path }) => {
        if (method !== 'GET' || path !== '/loyalty/account') return undefined
        accountReads++
        return { status: 200, body: memberView(`m-v${version}`, [recharge]) }
      },
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        if (conflictOnce) {
          // 店员刚在小程序给这位会员办了一笔，版本变了
          conflictOnce = false
          version = 2
          return {
            status: 409,
            body: { code: 'loyalty_conflict', message: '资产已变化，请刷新后重新确认', requestId: 'r1' },
          }
        }
        if ((body as { expectedVersion: string }).expectedVersion !== `m-v${version}`)
          return { status: 409, body: { code: 'loyalty_conflict', message: '资产已变化，请刷新后重新确认' } }
        version = 3
        return { status: 200, body: memberView('m-v3', [recharge]) }
      },
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto(`/members?account=${lin}`)
  const card = page.locator('.semi-card', { hasText: '手动加减' })
  await page.getByLabel('赠送余额调整（元）').fill('20')
  await page.getByLabel('调整原因').fill('补发活动赠送')
  await card.getByRole('button', { name: '提交调整' }).click()
  await page.locator('.semi-modal button', { hasText: '确认调整' }).click()

  await expect(card.getByText('资产已变化，请刷新后重新确认')).toBeVisible()
  // 输入保留，不自动换版本重提
  await expect(page.getByLabel('赠送余额调整（元）')).toHaveValue('20')
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toMatchObject({ action: 'adjust', expectedVersion: 'm-v1', giftCents: 2000 })

  const readsBefore = accountReads
  await card.getByRole('button', { name: '重新读取' }).click()
  await expect.poll(() => accountReads).toBeGreaterThan(readsBefore)
  await expect(card.getByText('资产已变化，请刷新后重新确认')).toHaveCount(0)

  await card.getByRole('button', { name: '提交调整' }).click()
  await page.locator('.semi-modal button', { hasText: '确认调整' }).click()
  await expect(page.getByText('已调整，另记了一条「资产调整」流水')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toMatchObject({ action: 'adjust', expectedVersion: 'm-v2', giftCents: 2000 })
  // 内容变了（新版本）就换新的幂等键
  expect(api.writes[1].idempotencyKey).toBeTruthy()
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
})

test('老板退回一笔充值：先写原因，再确认，退过的不能再退', async ({ page }) => {
  let refunded = false
  const refundEntry = {
    id: 'e-recharge-refund',
    accountId: lin,
    kind: 'recharge_refund',
    sourceId: 'e-recharge',
    reason: '顾客搬家',
    method: 'wechat',
    principalCents: -50000,
    giftCents: -5000,
    points: [{ lotId: 'e-recharge', delta: -200 }],
    createdAt: '2026-10-04T08:00:00Z',
  }
  const api = await mockApi(page, {
    handlers: [
      membersHandler,
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account'
          ? {
              status: 200,
              body: memberView(refunded ? 'm-v2' : 'm-v1', refunded ? [recharge, refundEntry] : [recharge]),
            }
          : undefined,
      ({ method, path }) => {
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        refunded = true
        return { status: 200, body: memberView('m-v2', [recharge, refundEntry]) }
      },
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto(`/members?account=${lin}`)

  const row = entryRows(page).filter({ hasText: '充值入账' })
  await row.getByRole('button', { name: '退款' }).click()
  const form = page.locator('.semi-modal', { hasText: '退款原因' })
  await expect(form.getByText('充 500 送 50')).toBeVisible()
  await expect(form.getByText('微信线下收款')).toBeVisible()

  // 原因必填
  await form.locator('button', { hasText: '下一步' }).click()
  await expect(form.getByText('请填写退款原因')).toBeVisible()
  await expect(page.getByLabel('退款原因')).toHaveAccessibleDescription(
    '余额或这笔积分已被用掉时后端会拒绝，需要先和顾客核对。 请填写退款原因',
  )
  expect(api.writes).toHaveLength(0)

  await page.getByLabel('退款原因').fill('顾客搬家')
  await form.locator('button', { hasText: '下一步' }).click()
  const confirmDialog = page.locator('.semi-modal', { hasText: '确认充值退款' })
  await expect(confirmDialog.getByText('会员：小林 · 138****1234')).toBeVisible()
  await expect(confirmDialog.getByText('退回本金 ¥500.00')).toBeVisible()
  await expect(confirmDialog.getByText('收回赠送余额 ¥50.00、积分 200')).toBeVisible()
  await expect(confirmDialog.getByText(/按原渠道（微信线下收款）线下退给顾客/)).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认退款' }).click()

  await expect(page.getByText('充值已退款，另记了一条「充值退款」冲正流水')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/loyalty/actions',
      body: { action: 'recharge_refund', accountId: lin, targetId: 'e-recharge', reason: '顾客搬家' },
      idempotencyKey: expect.any(String),
    },
  ])
  // 原充值保留并标记已退款，另多一条冲正流水；不能再退
  await expect(page.locator('.semi-modal')).toHaveCount(0)
  await expect(row).toContainText('已退款')
  await expect(row.getByRole('button', { name: '退款' })).toHaveCount(0)
  await expect(entryRows(page).filter({ hasText: '充值退款' })).toContainText('退回 2026-09-01 10:00 的充值')
})

test('店长能手动加减、不能办充值退款；扣成负数的不提交；导航里没有系统设置', async ({ page }) => {
  const api = await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    handlers: [
      membersHandler,
      ({ method, path }) =>
        method === 'GET' && path === '/loyalty/account'
          ? { status: 200, body: memberView('m-v1', [recharge]) }
          : undefined,
      ({ method, path }) =>
        method === 'POST' && path === '/loyalty/actions'
          ? { status: 200, body: memberView('m-v2', [recharge]) }
          : undefined,
    ],
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长', roles: ['manager'] })
  await page.goto(`/members?account=${lin}`)

  await expect(page.locator('.semi-card', { hasText: '30 天内到期积分' }).getByText('¥550.00')).toBeVisible()
  await expect(entryRows(page)).toHaveCount(1)
  await expect(page.getByText('充值退款只有老板能办理。')).toBeVisible()
  await expect(page.getByRole('button', { name: '退款' })).toHaveCount(0)
  // 手动加减所有员工都能办（2026-10-10 起）；扣得比现有的多：直接提示，不弹确认、不提交
  const card = page.locator('.semi-card', { hasText: '手动加减' })
  await page.getByLabel('积分调整').fill('-400')
  await page.getByLabel('调整原因').fill('美团团购退了，收回送的积分')
  await card.getByRole('button', { name: '提交调整' }).click()
  await expect(page.getByText('积分不够扣：调整后不能是负数，请核对后再填')).toBeVisible()
  await expect(page.locator('.semi-modal')).toHaveCount(0)
  expect(api.writes).toHaveLength(0)
  await page.getByLabel('积分调整').fill('-20')
  await card.getByRole('button', { name: '提交调整' }).click()
  await expect(page.locator('.semi-modal').getByText('调整后：本金 ¥500.00、赠送余额 ¥50.00、积分 300')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认调整' }).click()
  await expect(page.getByText('已调整，另记了一条「资产调整」流水')).toBeVisible()
  expect(api.writes).toEqual([
    expect.objectContaining({ body: expect.objectContaining({ action: 'adjust', points: -20, principalCents: 0 }) }),
  ])

  const nav = page.locator('.admin-nav')
  await expect(nav.getByText('会员资产')).toBeVisible()
  await expect(nav.getByText('系统设置')).toHaveCount(0)
})

// ---- 柜台三项：充值登记、积分兑换、生日礼物核销（所有员工都能办，与小程序「会员与计时 › 会员」同一套请求）----

const counterRule = (overrides: Record<string, unknown>) => ({
  enabled: true,
  amountCents: 0,
  giftCents: 0,
  points: 0,
  minimumPoints: 0,
  renewalCents: 0,
  rateBasisPoints: 0,
  maxBasisPoints: 0,
  durationMinutes: 0,
  renewalMinutes: 0,
  pauseLimitMinutes: 0,
  validDays: 0,
  mode: '',
  scope: '',
  stack: false,
  productId: '',
  quantity: 0,
  perUserLimit: 0,
  overtime: '',
  ...overrides,
})

const counterRules = [
  counterRule({
    id: 'rule-500',
    kind: 'recharge',
    name: '充 500 送 50',
    amountCents: 50000,
    giftCents: 5000,
    points: 200,
  }),
  counterRule({
    id: 'rule-keychain',
    kind: 'exchange',
    name: '拼豆钥匙扣',
    points: 300,
    quantity: 50,
    perUserLimit: 2,
  }),
  // 别的种类不出现在柜台三项里
  counterRule({ id: 'rule-earn', kind: 'earn', name: '消费积分', scope: 'all', rateBasisPoints: 100 }),
]

const giftRule = counterRule({
  id: 'rule-bear',
  kind: 'birthday',
  name: '生日小熊',
  scope: 'gift',
  mode: 'month',
  validDays: 30,
})
const birthdayEntry = (id: string, rule: unknown, createdAt: string) => ({
  id,
  accountId: lin,
  kind: 'birthday',
  sourceId: 'rule-bear',
  reason: '',
  principalCents: 0,
  giftCents: 0,
  points: [],
  rule,
  createdAt,
})
const counterEntries = [
  recharge,
  // 去年领的礼物已核销；今年领的待核销；积分类生日福利不用核销
  birthdayEntry('e-gift-old', giftRule, '2025-10-02T02:00:00Z'),
  {
    id: 'e-gift-old-done',
    accountId: lin,
    kind: 'fulfill_gift',
    sourceId: 'e-gift-old',
    reason: '',
    principalCents: 0,
    giftCents: 0,
    points: [],
    createdAt: '2025-10-02T03:00:00Z',
  },
  birthdayEntry('e-gift-new', giftRule, '2026-10-03T02:00:00Z'),
  birthdayEntry(
    'e-points',
    counterRule({ id: 'rule-pts', kind: 'birthday', name: '生日积分', scope: 'points' }),
    '2026-10-03T02:05:00Z',
  ),
]

interface CounterInput {
  action: string
  accountId: string
  targetId: string
  expectedVersion: string
  method?: string
}

/**
 * 柜台三项的模拟后端：按动作入账、扣积分、记核销；充值和兑换核对会员资产版本（同后端），对不上回 409；
 * 同一个幂等键重放上次的结果。failNext 让下一次请求被拒，loseNextReply 让下一次办成了却丢掉响应（502）。
 */
function counterBackend() {
  const state = {
    version: 1,
    principalCents: 50000,
    giftCents: 5000,
    points: 520,
    entries: [...counterEntries] as Record<string, unknown>[],
    accountReads: 0,
    replies: new Map<string, unknown>(),
    failNext: null as null | { status: number; code: string; message: string },
    loseNextReply: false,
  }
  const view = () =>
    memberView(`m-v${state.version}`, state.entries, {
      balance: balance({
        principalCents: state.principalCents,
        giftCents: state.giftCents,
        points: state.points,
        tierName: '金卡会员',
      }),
      rules: counterRules,
    })
  const handler: MockHandler = ({ method, path, body, idempotencyKey }) => {
    if (method === 'GET' && path === '/loyalty/account') {
      state.accountReads++
      return { status: 200, body: view() }
    }
    if (method !== 'POST' || path !== '/loyalty/actions') return undefined
    if (idempotencyKey && state.replies.has(idempotencyKey))
      return { status: 200, body: state.replies.get(idempotencyKey) }
    const input = body as CounterInput
    if (state.failNext) {
      const failure = state.failNext
      state.failNext = null
      return { status: failure.status, body: { code: failure.code, message: failure.message, requestId: 'm' } }
    }
    if ((input.action === 'recharge' || input.action === 'exchange') && input.expectedVersion !== `m-v${state.version}`)
      return {
        status: 409,
        body: { code: 'loyalty_conflict', message: '规则或资产已变化，请刷新后重新确认', requestId: 'm' },
      }
    const entry: Record<string, unknown> = {
      id: `e-${state.entries.length + 1}`,
      accountId: lin,
      kind: input.action,
      sourceId: input.targetId,
      reason: '',
      principalCents: 0,
      giftCents: 0,
      points: [],
      createdAt: '2026-10-06T06:00:00Z',
    }
    if (input.action === 'recharge') {
      state.principalCents += 50000
      state.giftCents += 5000
      state.points += 200
      Object.assign(entry, {
        method: input.method,
        principalCents: 50000,
        giftCents: 5000,
        points: [{ lotId: entry.id, delta: 200 }],
        rule: counterRules[0],
      })
    } else if (input.action === 'exchange') {
      state.points -= 300
      Object.assign(entry, { points: [{ lotId: 'e-recharge', delta: -300 }], rule: counterRules[1] })
    }
    state.entries = [...state.entries, entry]
    state.version++
    const result = view()
    if (idempotencyKey) state.replies.set(idempotencyKey, result)
    if (state.loseNextReply) {
      state.loseNextReply = false
      return { status: 502, body: {} }
    }
    return { status: 200, body: result }
  }
  return { state, handler }
}

/** 按卡片标题找卡片（流水里也有「积分兑换」这类字，不能按内容找）。 */
const titledCard = (page: Page, title: string) =>
  page.locator('.semi-card').filter({ has: page.locator('.semi-card-header-wrapper-title', { hasText: title }) })

const clerk = { id: 'u-clerk', nickname: '店员小周', roles: ['clerk'], phoneVerificationStatus: 'verified' as const }

test('店员在柜台办充值、积分兑换、生日礼物核销：先确认，带版本、幂等键提交，办完重读', async ({ page }) => {
  const backend = counterBackend()
  const api = await mockApi(page, { account: clerk, handlers: [membersHandler, backend.handler] })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
  await page.goto('/')
  // 店员侧栏也有会员页
  await page.locator('.admin-nav').getByText('会员资产').click()
  await expect(page.getByRole('heading', { name: '会员资产' })).toBeVisible()
  await memberRows(page).filter({ hasText: '小林' }).click()

  const assets = page.locator('.semi-card', { hasText: '30 天内到期积分' })
  const recharges = titledCard(page, '充值登记')
  const exchanges = titledCard(page, '积分兑换')
  const gifts = titledCard(page, '生日礼物核销')
  const rows = (card: typeof recharges) => card.locator('.semi-table-tbody .semi-table-row')
  await expect(assets.getByText('¥550.00')).toBeVisible()
  // 店员也能手动加减，看不到老板的充值退款
  await expect(page.getByText('充值退款只有老板能办理。')).toBeVisible()
  await expect(titledCard(page, '手动加减')).toBeVisible()

  // 只列已发布的充值方案和兑换商品（消费积分规则不在这里）
  await expect(rows(recharges)).toHaveCount(1)
  await expect(rows(recharges)).toContainText('充 500 送 50')
  await expect(rows(recharges)).toContainText('¥500.00')
  await expect(rows(exchanges)).toHaveCount(1)
  await expect(rows(exchanges)).toContainText('拼豆钥匙扣')
  await expect(exchanges.getByText('可用积分 520')).toBeVisible()
  // 只有今年领的、还没核销的礼物；去年的已核销，积分类生日福利不用核销
  await expect(rows(gifts)).toHaveCount(1)
  await expect(rows(gifts)).toContainText('生日小熊')
  await expect(rows(gifts)).toContainText('2026-10-03 10:00')

  // 收款方式默认微信，和小程序一样；读屏念得出这一组是什么
  await expect(recharges.getByRole('radiogroup', { name: '收款方式' })).toBeVisible()
  await expect(page.getByRole('radio', { name: '微信线下收款' })).toBeChecked()
  await recharges.locator('.semi-radio', { hasText: '现金' }).click()
  await expect(page.getByRole('radio', { name: '现金' })).toBeChecked()

  // 充值登记：确认框写清对谁、哪个方案、怎么收的钱、入账什么；先取消，不提交
  await recharges.getByRole('button', { name: '登记充值' }).click()
  const rechargeDialog = page.locator('.semi-modal', { hasText: '确认充值登记' })
  await expect(rechargeDialog.getByText('会员：小林 · 138****1234')).toBeVisible()
  await expect(rechargeDialog.getByText('充值方案：充 500 送 50')).toBeVisible()
  await expect(rechargeDialog.getByText('收款方式：现金')).toBeVisible()
  await expect(
    rechargeDialog.getByText('已收到该顾客 ¥500.00？确认后本金入账，赠送 ¥50.00 和 200 积分。'),
  ).toBeVisible()
  await rechargeDialog.locator('button', { hasText: '取消' }).click()
  await expect(rechargeDialog).toHaveCount(0)
  expect(api.writes).toHaveLength(0)

  await recharges.getByRole('button', { name: '登记充值' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入账' }).click()
  await expect(page.locator('.semi-toast').getByText('已登记充值「充 500 送 50」')).toBeVisible()
  expect(api.writes.at(-1)).toEqual({
    method: 'POST',
    path: '/loyalty/actions',
    body: {
      action: 'recharge',
      accountId: lin,
      targetId: 'rule-500',
      expectedVersion: 'm-v1',
      method: 'cash',
      serviceDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
    idempotencyKey: expect.any(String),
  })
  // 余额、积分以重读回来的为准
  await expect(assets.getByText('¥1,100.00')).toBeVisible()
  await expect(exchanges.getByText('可用积分 720')).toBeVisible()

  // 积分兑换：确认框写扣多少积分、出库什么；带重读后的新版本
  await exchanges.getByRole('button', { name: '兑换' }).click()
  const exchangeDialog = page.locator('.semi-modal', { hasText: '确认积分兑换' })
  await expect(exchangeDialog.getByText('当前可用积分：720')).toBeVisible()
  await expect(exchangeDialog.getByText('扣除 300 积分并出库一件 拼豆钥匙扣？')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认兑换' }).click()
  await expect(page.locator('.semi-toast').getByText('已兑换「拼豆钥匙扣」，请把商品交给顾客')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({
    body: { action: 'exchange', accountId: lin, targetId: 'rule-keychain', expectedVersion: 'm-v2' },
    idempotencyKey: expect.any(String),
  })
  await expect(exchanges.getByText('可用积分 420')).toBeVisible()

  // 生日礼物核销：核销的是那条领取流水
  await gifts.getByRole('button', { name: '核销' }).click()
  const giftDialog = page.locator('.semi-modal', { hasText: '确认核销生日礼物' })
  await expect(giftDialog.getByText('生日礼物：生日小熊（2026-10-03 10:00 领取）')).toBeVisible()
  await expect(giftDialog.getByText('确认交付生日礼物并扣减库存？')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认核销' }).click()
  await expect(page.locator('.semi-toast').getByText('已核销生日礼物「生日小熊」，请把礼物交给顾客')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({
    body: { action: 'fulfill_gift', accountId: lin, targetId: 'e-gift-new', expectedVersion: 'm-v3' },
    idempotencyKey: expect.any(String),
  })
  await expect(gifts.getByText(/没有待核销的生日礼物/)).toBeVisible()

  // 三次办理三个不同的幂等键，一次一件
  expect(api.writes).toHaveLength(3)
  expect(new Set(api.writes.map((write) => write.idempotencyKey)).size).toBe(3)
})

test('柜台办理被拒：原因显示在办的那一块，页面重读后按新版本再办，换新的幂等键', async ({ page }) => {
  const backend = counterBackend()
  const api = await mockApi(page, { account: clerk, handlers: [membersHandler, backend.handler] })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
  await page.goto(`/members?account=${lin}`)
  const recharges = titledCard(page, '充值登记')
  const exchanges = titledCard(page, '积分兑换')
  await expect(recharges.getByRole('button', { name: '登记充值' })).toBeVisible()

  // 店员刚在小程序给这位会员办了一笔：网页还拿着旧版本
  backend.state.version = 2
  const readsBefore = backend.state.accountReads
  await recharges.getByRole('button', { name: '登记充值' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入账' }).click()
  await expect(recharges.locator('.semi-banner-danger')).toContainText('规则或资产已变化，请刷新后重新确认')
  await expect(recharges.locator('.semi-banner-danger')).toContainText('页面已重新读取')
  // 失败只显示在充值那一块，并且已经重读
  await expect(exchanges.locator('.semi-banner')).toHaveCount(0)
  await expect.poll(() => backend.state.accountReads).toBeGreaterThan(readsBefore)
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toMatchObject({ action: 'recharge', expectedVersion: 'm-v1', method: 'wechat' })

  // 人看过最新资产再点：按新版本提交，新的幂等键，不是自动重提
  await recharges.getByRole('button', { name: '登记充值' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入账' }).click()
  await expect(page.locator('.semi-toast').getByText('已登记充值「充 500 送 50」')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toMatchObject({ action: 'recharge', expectedVersion: 'm-v2' })
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
  await expect(recharges.locator('.semi-banner')).toHaveCount(0)

  // 后端的业务拒绝原样显示在兑换那一块
  backend.state.failNext = { status: 409, code: 'loyalty_conflict', message: '兑换数量已用完' }
  await exchanges.getByRole('button', { name: '兑换' }).click()
  await page.locator('.semi-modal button', { hasText: '确认兑换' }).click()
  await expect(exchanges.locator('.semi-banner-danger')).toContainText('兑换数量已用完')
  await expect(recharges.locator('.semi-banner')).toHaveCount(0)
})

// 充值的响应丢了（其实已经入账）：页面重读后版本已变，员工再点一次，不能充成两次。
// 网页先把上一次那一条原样（原请求体、原幂等键）重发，后端重放出成功，就说明上次已生效、这次不提交。
test('结果未知后重读再点充值：先原样重发上一次，已生效就提醒、不再充一次', async ({ page }) => {
  const backend = counterBackend()
  const api = await mockApi(page, { account: clerk, handlers: [membersHandler, backend.handler] })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
  await page.goto(`/members?account=${lin}`)
  const assets = page.locator('.semi-card', { hasText: '30 天内到期积分' })
  const recharges = titledCard(page, '充值登记')
  await expect(assets.getByText('¥550.00')).toBeVisible()

  backend.state.loseNextReply = true
  await recharges.getByRole('button', { name: '登记充值' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入账' }).click()
  await expect(recharges.locator('.semi-banner-danger')).toBeVisible()
  // 失败后重读：其实已经入账了
  await expect(assets.getByText('¥1,100.00')).toBeVisible()

  await recharges.getByRole('button', { name: '登记充值' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入账' }).click()
  const notice = recharges.locator('.semi-banner-warning')
  await expect(notice).toContainText('上一次没收到结果的那次操作其实已经生效，这一次没有提交')
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1]).toEqual(api.writes[0])
  expect(api.writes[1].body).toMatchObject({ action: 'recharge', expectedVersion: 'm-v1' })
  // 只入账了一次
  expect(backend.state.principalCents).toBe(100000)
  await expect(assets.getByText('¥1,100.00')).toBeVisible()
})

test('会员码：扫码枪对着查找框扫会员码直接打开这位会员；手机转来的也一样；过期的码照后端的话说，不当搜索词', async ({
  page,
}) => {
  const linCode = '91234567890123456789'
  const wangCode = '90000000000000000002'
  const expiredCode = '99999999999999999999'
  const lookups: string[] = []
  const listSearches: Record<string, string>[] = []
  const api = await mockApi(page, {
    account: { id: 'u-clerk', nickname: '小店员', roles: ['clerk'], phoneVerificationStatus: 'verified' },
    handlers: [
      ({ method, path, search }) => {
        if (method === 'GET' && path === '/loyalty/members') listSearches.push(Object.fromEntries(search))
        return membersHandler({ method, path, search, body: undefined })
      },
      ({ method, path, search }) =>
        method === 'GET' && path === '/loyalty/account'
          ? { status: 200, body: memberView(`m-${search.get('accountId')}`, [recharge]) }
          : undefined,
      ({ method, path, body }) => {
        if (method !== 'POST' || path !== '/member-codes/lookups') return undefined
        const { code } = body as { code: string }
        lookups.push(code)
        const found = code === linCode ? members[1] : code === wangCode ? members[0] : undefined
        return found
          ? {
              status: 200,
              body: { ...found, phoneVerificationStatus: 'verified', roles: [] },
            }
          : {
              status: 410,
              body: {
                code: 'member_code_expired',
                message: '会员码已过期，请顾客刷新会员码后再扫',
                requestId: 'r',
              },
            }
      },
    ],
  })
  await signIn(page, { id: 'u-clerk', nickname: '小店员', roles: ['clerk'] })
  await page.goto('/members')
  await expect(memberRows(page)).toHaveCount(3)

  // 扫码枪：点一下查找框，键入会员码再回车
  const box = page.getByLabel('查找会员')
  await box.click()
  await page.keyboard.type(expiredCode)
  await page.keyboard.press('Enter')
  await expect(listCard(page).getByText('会员码已过期，请顾客刷新会员码后再扫')).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(page.getByText('先选一位会员')).toBeVisible()

  await page.keyboard.type(linCode)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`account=${lin}`))
  await expect(page.locator('.semi-card', { hasText: '30 天内到期积分' })).toContainText('小林')
  await expect(listCard(page).getByText('会员码已过期')).toHaveCount(0)
  await expect(box).toHaveValue('')
  // 会员码从没当成搜索词发给会员列表
  expect(listSearches.every((search) => !search.q)).toBe(true)

  // 手机「扫码给电脑」转来小王的会员码
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'scan.relayed', code: wangCode }))
  await expect(page).toHaveURL(new RegExp(`account=${wang}`))
  await expect(page.locator('.semi-card', { hasText: '30 天内到期积分' })).toContainText('小王')
  expect(lookups).toEqual([expiredCode, linCode, wangCode])

  // 商品条码在这一页用不上：右下角提示「手机扫到」，可复制，不打开谁
  api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'scan.relayed', code: '6901234567892' }))
  const notice = page.locator('.semi-notification-notice', { hasText: '手机扫到' })
  await expect(notice).toContainText('6901234567892')
  await expect(notice).toContainText('收货入库会按条码加商品')
  await expect(notice.locator('.semi-typography-action-copy')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`account=${wang}`))
  expect(lookups).toHaveLength(3)
})

// 新流程仍由临时库上的 cmd/pindou-dev 提供页面和 CSP，接口按已有用例模拟，核对浏览器提交内容。
test('消费登记：补录日期、确认扣款与另付，店长写原因撤销后保留原流水', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-27T04:00:00Z'))
  const entries: Record<string, unknown>[] = []
  let version = 1
  let currentBalance = balance({ principalCents: 50000, giftCents: 5000, boardUses: 2 })
  const view = () =>
    memberView(`m-v${version}`, entries, {
      balance: currentBalance,
      rules: [counterRule({ kind: 'package', id: 'p-three', name: '3 小时', durationMinutes: 180 })],
    })
  const api = await mockApi(page, {
    account: { id: 'u-manager', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    billingEnabled: false,
    handlers: [
      membersHandler,
      ({ method, path, body }) => {
        if (method === 'GET' && path === '/loyalty/account') return { status: 200, body: view() }
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        const input = body as {
          action: string
          reason?: string
          serviceDate?: string
          consumption?: Record<string, unknown>
        }
        version++
        if (input.action === 'consume') {
          currentBalance = balance({ boardUses: 1 })
          entries.push({
            id: 'consume-1',
            kind: 'consume',
            accountId: lin,
            sourceId: '',
            reason: input.reason ?? '',
            principalCents: -50000,
            giftCents: -5000,
            points: [],
            boardUses: -1,
            serviceDate: input.serviceDate,
            createdAt: '2026-10-27T04:00:00Z',
            consumption: { ...input.consumption, packageName: '3 小时', extraCents: 5000 },
            balanceAfter: { principalCents: 0, giftCents: 0, boardUses: 1 },
          })
        } else if (input.action === 'consume_reverse') {
          currentBalance = balance({ principalCents: 50000, giftCents: 5000, boardUses: 2 })
          entries.push({
            ...entries[0],
            id: 'reverse-1',
            kind: 'consume_reverse',
            sourceId: 'consume-1',
            reason: input.reason,
            principalCents: 50000,
            giftCents: 5000,
            boardUses: 1,
            createdAt: '2026-10-27T04:01:00Z',
            balanceAfter: { principalCents: 50000, giftCents: 5000, boardUses: 2 },
          })
        }
        return { status: 200, body: view() }
      },
    ],
  })
  await signIn(page, { id: 'u-manager', nickname: '店长', roles: ['manager'] })
  await page.goto(`/members?account=${lin}`)
  const card = titledCard(page, '消费登记')
  await card.getByPlaceholder('选择消费日期').fill('2026-10-25')
  await card.getByLabel('消费金额（元）').click()
  await expect(card.getByRole('radio', { name: '节假日', exact: true })).toBeChecked()
  await card.getByRole('combobox', { name: '消费套餐' }).click()
  await page.getByRole('option', { name: /3 小时/ }).click()
  // ★ Semi 受控下拉框等收起动画放完才通知 onChange（semi-foundation select 的 closeCb）：没等显示出来就去填金额，
  //   这次选择会丢。2026-10-28 本机连挂五次（请求里没有 packageId），CI 机器慢才一直碰巧通过。
  await expect(card.getByRole('combobox', { name: '消费套餐' })).toContainText('3 小时')
  await card.getByLabel('消费金额（元）').fill('600')
  await card.getByLabel('智能豆板用几次').fill('1')
  await card.getByLabel('消费备注').fill('补录周日消费')
  await card.getByRole('button', { name: '登记消费', exact: true }).click()
  const confirmation = page.locator('.semi-modal', { hasText: '确认消费登记' })
  await expect(confirmation).toContainText('消费金额 ¥600.00，当前余额 ¥550.00')
  await expect(confirmation).toContainText('本次从余额扣 ¥550.00（本金 ¥500.00、赠送 ¥50.00）')
  await expect(confirmation).toContainText('另付 ¥50.00')
  await expect(confirmation).toContainText('扣完余额 ¥0.00')
  await expect(confirmation).toContainText('智能豆板用 1 次，剩 1 次')
  await confirmation.getByRole('button', { name: '确认登记' }).click()
  await expect(page.locator('.semi-toast')).toContainText('已登记消费')
  expect(api.writes[0]).toMatchObject({
    path: '/loyalty/actions',
    idempotencyKey: expect.any(String),
    body: {
      action: 'consume',
      accountId: lin,
      expectedVersion: 'm-v1',
      serviceDate: '2026-10-25',
      reason: '补录周日消费',
      consumption: { packageId: 'p-three', headcount: 1, dayType: 'holiday', amountCents: 60000, boardUses: 1 },
    },
  })
  const original = entryRows(page).filter({ hasText: '消费 · 单人 · 3 小时 · 节假日' })
  await expect(original).toContainText('2026-10-25')
  await expect(original).toContainText('智能豆板 -1 次')
  await expect(original).toContainText('余额不够，另付 ¥50.00')
  await expect(original).toContainText('记完余额 ¥0.00 · 豆板 1 次')
  await original.getByRole('button', { name: '撤销', exact: true }).click()
  const reverse = page.locator('.semi-modal', { hasText: '撤销原因' })
  await reverse.getByRole('button', { name: '确认撤销' }).click()
  await expect(reverse.getByText('请填写撤销原因')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  await reverse.getByLabel('撤销原因').fill('金额填错，重新登记')
  await reverse.getByRole('button', { name: '确认撤销' }).click()
  // 登记时的「已登记消费」可能还没消失，按文字找这一条
  await expect(page.locator('.semi-toast').getByText('已撤销消费')).toBeVisible()
  expect(api.writes[1]).toMatchObject({
    idempotencyKey: expect.any(String),
    body: {
      action: 'consume_reverse',
      accountId: lin,
      targetId: 'consume-1',
      expectedVersion: 'm-v2',
      reason: '金额填错，重新登记',
    },
  })
  await expect(entryRows(page)).toHaveCount(2)
  await expect(entryRows(page).filter({ hasText: '已撤销' })).toHaveCount(1)
  await expect(detailCard(page).getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  await expect(detailCard(page).getByRole('button', { name: '复制给顾客', exact: true })).toHaveCount(0)
})

test('店员登记：其他须写备注、次数不足不提交；冲突保留输入，重读后用新版本确认', async ({ page }) => {
  let version = 1
  const api = await mockApi(page, {
    account: clerk,
    billingEnabled: false,
    handlers: [
      membersHandler,
      ({ method, path }) => {
        if (method === 'GET' && path === '/loyalty/account')
          return { status: 200, body: memberView(`m-v${version}`, [], { balance: balance({ boardUses: 1 }) }) }
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        if (version === 1) {
          version++
          return {
            status: 409,
            body: { code: 'loyalty_conflict', message: '资产已变化，请刷新后重新确认', requestId: 'consume' },
          }
        }
        return { status: 200, body: memberView('m-v3', []) }
      },
    ],
  })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
  await page.goto(`/members?account=${lin}`)
  const card = titledCard(page, '消费登记')
  await card.getByLabel('消费金额（元）').fill('0')
  await card.getByLabel('智能豆板用几次').fill('2')
  await card.getByRole('button', { name: '登记消费', exact: true }).click()
  await expect(card.getByText('选「其他」时请填写备注')).toBeVisible()
  await expect(card.getByText('智能豆板次数须为 0～1 的整数')).toBeVisible()
  expect(api.writes).toHaveLength(0)
  await card.getByLabel('智能豆板用几次').fill('1')
  await card.getByLabel('消费备注').fill('只用赠送豆板')
  await card.getByRole('button', { name: '登记消费', exact: true }).click()
  await page.locator('.semi-modal').getByRole('button', { name: '确认登记' }).click()
  await expect(card.getByText('资产已变化，请刷新后重新确认')).toBeVisible()
  await expect(card.getByLabel('消费备注')).toHaveValue('只用赠送豆板')
  expect(api.writes).toHaveLength(1)
  await card.getByRole('button', { name: '重新读取' }).click()
  await expect(card.getByText('资产已变化，请刷新后重新确认')).toHaveCount(0)
  await card.getByRole('button', { name: '登记消费', exact: true }).click()
  await page.locator('.semi-modal').getByRole('button', { name: '确认登记' }).click()
  await expect(page.locator('.semi-toast')).toContainText('已登记消费')
  expect(api.writes[1]).toMatchObject({
    body: { action: 'consume', expectedVersion: 'm-v2', consumption: { amountCents: 0, boardUses: 1 } },
  })
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
  await expect(detailCard(page).getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
})

for (const existing of [false, true]) {
  test(`店员代开会员：同意后提交并直接打开，${existing ? '撞号提示已有账户' : '显示未认领及认领方法'}`, async ({
    page,
  }) => {
    const opened = {
      id: 'dddd4444-0000-4000-8000-000000000004',
      nickname: '新会员',
      phoneMasked: '138****8888',
      balance: balance(),
      unclaimed: true,
    }
    let didOpen = false
    const api = await mockApi(page, {
      account: clerk,
      handlers: [
        ({ method, path, search }) =>
          method === 'GET' && path === '/loyalty/members'
            ? memberListResult(didOpen ? [...members, opened] : members, search)
            : undefined,
        ({ method, path }) => {
          if (method === 'POST' && path === '/member-accounts') {
            didOpen = true
            return { status: existing ? 200 : 201, body: { existing, account: opened } }
          }
          if (method === 'GET' && path === '/loyalty/account')
            return { status: 200, body: memberView('m-new', [], { balance: balance() }) }
          return undefined
        },
      ],
    })
    await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
    await page.goto('/members')
    await page.getByRole('button', { name: '代开会员', exact: true }).click()
    const modal = page.locator('.semi-modal', { hasText: '顾客已同意门店记下称呼和手机号' })
    await modal.getByLabel('称呼', { exact: true }).fill('新会员')
    await modal.getByLabel('手机号', { exact: true }).fill('138-0013-8888')
    await modal.getByRole('button', { name: '确认代开' }).click()
    await expect(modal.getByText('请先确认顾客已同意')).toBeVisible()
    expect(api.writes).toHaveLength(0)
    // Semi 的复选框由外层盖住 input，点外层（同 storefront.spec.ts）
    await modal
      .locator('.semi-checkbox', { has: page.getByRole('checkbox', { name: '顾客已同意门店记下称呼和手机号' }) })
      .click()
    await modal.getByRole('button', { name: '确认代开' }).click()
    await expect(page).toHaveURL(new RegExp(`account=${opened.id}`))
    await expect(page.locator('.semi-toast')).toContainText(
      existing ? '这个手机号已经有账户，已为你打开' : '已代开会员',
    )
    const assets = page.locator('.semi-card', { hasText: '30 天内到期积分' })
    await expect(assets).toContainText('新会员')
    await expect(assets).toContainText('店员代开 · 未认领')
    await expect(assets).toContainText('店员帮我开过会员，去认领')
    expect(api.writes[0]).toMatchObject({
      path: '/member-accounts',
      body: { nickname: '新会员', phone: '138-0013-8888', consent: true },
    })
  })
}

test('复制给顾客：消费和充值登记成功可复制，后续资产变了仍按各笔快照复制', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date('2026-10-27T04:00:00Z'))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const entries: Record<string, unknown>[] = []
  let version = 1
  let assets = balance({ principalCents: 50000, giftCents: 5000, boardUses: 2 })
  const rule = counterRule({
    id: 'recharge-888',
    kind: 'recharge',
    name: '888 送 120',
    amountCents: 88800,
    giftCents: 12000,
    boardUses: 2,
  })
  const view = () =>
    memberView(`copy-v${version}`, entries, {
      balance: assets,
      rules: [
        counterRule({ id: 'p3', kind: 'package', name: '3 小时', durationMinutes: 180 }),
        counterRule({ id: 'close', kind: 'package', name: '全天不限时', durationMinutes: 0, untilClose: true }),
        counterRule({ id: 'p1', kind: 'package', name: '1 小时', durationMinutes: 60 }),
        rule,
      ],
    })
  await mockApi(page, {
    account: clerk,
    handlers: [
      membersHandler,
      ({ method, path, body }) => {
        if (method === 'GET' && path === '/loyalty/account') return { status: 200, body: view() }
        if (method !== 'POST' || path !== '/loyalty/actions') return undefined
        const input = body as { action: string; serviceDate: string; consumption?: Record<string, unknown> }
        version++
        if (input.action === 'consume') {
          assets = balance({ boardUses: 1 })
          entries.push({
            id: 'copy-consume',
            accountId: lin,
            kind: 'consume',
            sourceId: '',
            reason: '给店里看的备注',
            points: [],
            principalCents: -50000,
            giftCents: -5000,
            boardUses: -1,
            serviceDate: input.serviceDate,
            createdAt: '2026-10-27T04:00:00Z',
            consumption: { ...input.consumption, packageName: '3 小时', extraCents: 5000 },
            balanceAfter: { principalCents: 0, giftCents: 0, boardUses: 1 },
          })
        } else if (input.action === 'recharge') {
          assets = balance({ principalCents: 88800, giftCents: 12000, boardUses: 3 })
          entries.push({
            id: 'copy-recharge',
            accountId: lin,
            kind: 'recharge',
            sourceId: 'recharge-888',
            reason: '',
            points: [],
            rule,
            principalCents: 88800,
            giftCents: 12000,
            boardUses: 2,
            serviceDate: input.serviceDate,
            createdAt: '2026-10-27T04:01:00Z',
            balanceAfter: { principalCents: 88800, giftCents: 12000, boardUses: 3 },
          })
        }
        return { status: 200, body: view() }
      },
    ],
  })
  await signIn(page, { id: clerk.id, nickname: clerk.nickname, roles: clerk.roles })
  await page.goto(`/members?account=${lin}`)
  const consume = titledCard(page, '消费登记')
  await consume.getByRole('combobox', { name: '消费套餐' }).click()
  await expect(page.getByRole('option')).toHaveText(['1 小时', '3 小时', '全天不限时', '其他'])
  await page.getByRole('option', { name: /3 小时/ }).click()
  await consume.getByPlaceholder('选择消费日期').fill('2026-10-25')
  await consume.getByLabel('消费金额（元）').fill('600')
  await consume.getByLabel('智能豆板用几次').fill('1')
  await consume.getByLabel('消费备注').fill('给店里看的备注')
  await consume.getByRole('button', { name: '登记消费', exact: true }).click()
  await page.locator('.semi-modal').getByRole('button', { name: '确认登记' }).click()
  const consumptionText = [
    'EXAMPLE 示例工坊 · 消费记录',
    '10月25日 单人 · 3 小时 · 节假日',
    '消费 ¥600.00，余额扣 ¥550.00',
    '余额不够，另付 ¥50.00',
    '余额 ¥0.00',
    '智能豆板用 1 次，剩 1 次',
  ].join('\n')
  await consume.getByRole('button', { name: '复制给顾客', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(consumptionText)
  await expect(page.locator('.semi-toast').getByText('已复制，去微信粘贴给顾客')).toBeVisible()
  const recharges = titledCard(page, '充值登记')
  await recharges.getByRole('button', { name: '登记充值', exact: true }).click()
  await page.locator('.semi-modal').getByRole('button', { name: '确认入账' }).click()
  const rechargeText = [
    'EXAMPLE 示例工坊 · 充值记录',
    '10月27日 充值「888 送 120」',
    '付 ¥888.00，到账 ¥1,008.00，送智能豆板 2 次',
    '余额 ¥1,008.00（其中赠送 ¥120.00）',
    '智能豆板剩 3 次',
  ].join('\n')
  await recharges.getByRole('button', { name: '复制给顾客', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(rechargeText)
  await entryRows(page)
    .filter({ hasText: '消费 · 单人 · 3 小时 · 节假日' })
    .getByRole('button', { name: '复制给顾客' })
    .click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(consumptionText)
  await entryRows(page).filter({ hasText: '充值入账' }).getByRole('button', { name: '复制给顾客' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(rechargeText)
})
