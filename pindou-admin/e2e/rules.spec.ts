import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockAccount, type MockHandler } from './mock-api'

// 经营规则：按类别列出生效中与草稿；草稿表单的字段校验与定位；服务端计算示例；
// 老板发布与停用的确认（断言请求体）；店长看不到发布；版本冲突提示重读再确认。

type Rule = Record<string, unknown> & { id: string; kind: string; name: string; enabled: boolean }
type Publication = { id: string; rule: Rule; actorId: string; createdAt: string; impact: string }
type ActionWrite = { action?: string; expectedVersion?: string; key?: string; [field: string]: unknown }

const blank = {
  enabled: false,
  amountCents: 0,
  giftCents: 0,
  points: 0,
  rateBasisPoints: 0,
  maxBasisPoints: 0,
  minimumPoints: 0,
  validDays: 0,
  mode: '',
  scope: '',
  stack: false,
  productId: '',
  quantity: 0,
  perUserLimit: 0,
  durationMinutes: 0,
  renewalMinutes: 0,
  renewalCents: 0,
  pauseLimitMinutes: 0,
  overtime: '',
}

const gold: Rule = {
  ...blank,
  id: 'r-gold',
  kind: 'tier',
  name: '黄金会员',
  enabled: true,
  amountCents: 50000,
  rateBasisPoints: 9000,
  mode: 'cumulative',
  validDays: 365,
}
const silver: Rule = {
  ...blank,
  id: 'r-silver',
  kind: 'tier',
  name: '白银会员',
  amountCents: 20000,
  rateBasisPoints: 9500,
  mode: 'single',
}
const threeHours: Rule = {
  ...blank,
  id: 'r-pack',
  kind: 'package',
  name: '三小时畅玩',
  enabled: true,
  amountCents: 6880,
  durationMinutes: 180,
  overtime: 'manual',
}

/** 照后端规则的模拟：保存、发布、停用都要回传当前 version，不符回 409；每次写入换新 version。 */
function rulesBackend() {
  const state = {
    version: 1,
    drafts: { [gold.id]: { ...gold }, [silver.id]: { ...silver }, [threeHours.id]: { ...threeHours } } as Record<
      string,
      Rule
    >,
    publications: [
      {
        id: 'p2',
        rule: { ...threeHours },
        actorId: 'u-owner',
        createdAt: '2026-10-02T02:00:00Z',
        impact: '新开计时套餐',
      },
      {
        id: 'p1',
        rule: { ...gold },
        actorId: 'u-owner',
        createdAt: '2026-10-01T02:00:00Z',
        impact: '首次启用会员等级',
      },
      {
        id: 'p0',
        rule: { ...gold, id: 'r-trial', name: '试运行等级', enabled: false },
        actorId: 'deadbeef-0000-4000-8000-000000000000',
        createdAt: '2026-09-01T02:00:00Z',
        impact: '试运行结束',
      },
    ] as Publication[],
    // 发布人的称呼由服务端带在每条发布记录上（不在了为 null）
    accounts: [
      { id: 'u-owner', nickname: '阿贝', phoneMasked: '138****0001' },
      { id: 'u-mgr', nickname: '小王', phoneMasked: '139****0002' },
    ],
  }
  const version = () => `v${state.version}`
  const rules = () =>
    Object.values(state.drafts).flatMap((draft) => {
      const latest = state.publications.find((p) => p.rule.id === draft.id)
      return latest?.rule.enabled ? [latest.rule] : []
    })
  const conflict = {
    status: 409,
    body: { code: 'loyalty_conflict', message: '设置已变化，请刷新后重新确认', requestId: 'req' },
  }
  let seq = 0
  const handler: MockHandler = ({ method, path, body }) => {
    if (method === 'GET' && path === '/loyalty/settings')
      return {
        status: 200,
        body: {
          drafts: state.drafts,
          rules: rules(),
          publications: state.publications.map((publication) => ({
            ...publication,
            actor: state.accounts.find((account) => account.id === publication.actorId) ?? null,
          })),
          version: version(),
        },
      }
    if (method === 'GET' && path === '/catalog-items')
      return { status: 200, body: [{ id: 'p-key', name: '拼豆钥匙扣', unitPriceCents: 1500 }] }
    if (method !== 'POST' || path !== '/loyalty/actions') return undefined
    const input = body as { action: string; rule?: Rule; targetId?: string; expectedVersion?: string; reason?: string }
    if (input.action === 'preview_rule') {
      const r = input.rule as Rule
      return {
        status: 200,
        body: { preview: `服务端示例：${r.name}，门槛 ${r.amountCents} 分，计价 ${r.rateBasisPoints} 基点。` },
      }
    }
    if (input.expectedVersion !== version()) return conflict
    if (input.action === 'save_rule') {
      const rule = { ...(input.rule as Rule) }
      if (!rule.id) rule.id = `r-new-${++seq}`
      state.drafts[rule.id] = rule
      state.version++
      return { status: 200, body: rule }
    }
    if (input.action === 'publish' || input.action === 'disable') {
      const draft = state.drafts[input.targetId ?? '']
      const rule = { ...draft, enabled: input.action === 'publish' }
      state.drafts[rule.id] = rule
      const publication = {
        id: `p-${++seq}`,
        rule,
        actorId: 'u-owner',
        createdAt: '2026-10-04T08:00:00Z',
        impact: input.reason ?? '',
      }
      state.publications = [publication, ...state.publications]
      state.version++
      return { status: 200, body: publication }
    }
    return undefined
  }
  return { state, handler }
}

const manager: MockAccount = { id: 'u-mgr', nickname: '小王', roles: ['manager'], phoneVerificationStatus: 'verified' }

async function open(page: Page, account?: MockAccount) {
  const backend = rulesBackend()
  const api = await mockApi(page, { handlers: [backend.handler], ...(account ? { account } : {}) })
  await signIn(page, account ?? { id: 'u-owner' })
  const actions = (): ActionWrite[] =>
    api.writes
      .filter((write) => write.path === '/loyalty/actions')
      .map((write) => ({ ...(write.body as ActionWrite), key: write.idempotencyKey }))
  return { backend, api, actions }
}

test('按类别列出生效中与草稿，未配置的类别显示未配置，发布历史可查', async ({ page }) => {
  const { backend } = await open(page)
  // 黄金会员的草稿改过、还没发布
  backend.state.drafts['r-gold'] = { ...gold, rateBasisPoints: 8800 }
  await page.goto('/rules')

  await expect(page.getByRole('heading', { name: '经营规则' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '会员等级' })).toHaveAttribute('aria-selected', 'true')
  const table = page.locator('.semi-table')
  const goldRow = table.getByRole('row', { name: /黄金会员/ })
  await expect(goldRow.getByText('生效中', { exact: true })).toBeVisible()
  await expect(goldRow.getByText('有未发布的修改')).toBeVisible()
  await expect(goldRow.getByText('累计充值满 ¥500.00 · 会员价为原价的 88% · 等级 365 天内有效')).toBeVisible()
  await expect(goldRow.getByText('生效中：累计充值满 ¥500.00 · 会员价为原价的 90%', { exact: false })).toBeVisible()
  await expect(goldRow.getByText('发布 · 阿贝')).toBeVisible()
  const silverRow = table.getByRole('row', { name: /白银会员/ })
  await expect(silverRow.getByText('未发布', { exact: true })).toBeVisible()
  await expect(silverRow.getByText('单次充值满 ¥200.00 · 会员价为原价的 95% · 等级永久有效')).toBeVisible()

  // 没配置的类别：明确显示未配置，标签页记在网址里
  await page.getByRole('tab', { name: '充值方案' }).click()
  await expect(page).toHaveURL(/tab=recharge/)
  await expect(page.getByText('尚未配置充值方案')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建充值方案' })).toBeVisible()

  await page.getByRole('tab', { name: '计时套餐' }).click()
  await expect(
    page.locator('.semi-table').getByText('180 分钟 ¥68.80 · 不提供续时 · 不能暂停 · 超时提示员工处理'),
  ).toBeVisible()

  await page.getByRole('tab', { name: '发布历史' }).click()
  const history = page.locator('.semi-table')
  await expect(history.getByRole('row', { name: /新开计时套餐/ })).toContainText('三小时畅玩')
  await expect(history.getByRole('row', { name: /首次启用会员等级/ })).toContainText('阿贝')
  await expect(history.getByRole('row', { name: /首次启用会员等级/ })).toContainText('2026-10-01 10:00')
  // 发布人的账户已不在（服务端称呼为 null）：只显示编号
  await expect(history.getByRole('row', { name: /试运行/ })).toContainText('账号 deadbeef')

  // 直接打开网址也落在对应标签页
  await page.goto('/rules?tab=package')
  await expect(page.getByRole('tab', { name: '计时套餐' })).toHaveAttribute('aria-selected', 'true')
})

test('新建草稿：金额、百分比不合法时在字段上报错并定位，改对后看计算示例再保存', async ({ page }) => {
  const { actions } = await open(page)
  await page.goto('/rules')
  await page.getByRole('button', { name: '新建会员等级' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.getByText('新建会员等级草稿')).toBeVisible()

  await sheet.getByLabel('名称').fill('钻石会员')
  await sheet.getByLabel('升级门槛').fill('500.001')
  await sheet.getByLabel('会员价').fill('120%')
  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(sheet.getByText('请输入金额（元），最多两位小数')).toBeVisible()
  await expect(sheet.getByText('须在 0.01% 到 100% 之间')).toBeVisible()
  // 光标落在第一个出错的字段上
  await expect(sheet.getByLabel('升级门槛')).toBeFocused()
  expect(actions()).toHaveLength(0)

  // 改对一项，那一项的错误随即消失，另一项仍在
  await sheet.getByLabel('升级门槛').fill('2000')
  await expect(sheet.getByText('请输入金额（元），最多两位小数')).toHaveCount(0)
  await expect(sheet.getByText('须在 0.01% 到 100% 之间')).toBeVisible()
  await sheet.getByLabel('会员价').fill('85.5%')
  // 按钮式单选的文字盖在 input 上，点看得见的那一块
  await sheet.locator('.semi-radio', { hasText: '按单次充值升级' }).click()
  await expect(sheet.getByRole('radio', { name: '按单次充值升级' })).toBeChecked()

  // 计算示例由服务端给
  await sheet.getByRole('button', { name: '计算示例' }).click()
  await expect(sheet.getByText('服务端示例：钻石会员，门槛 200000 分，计价 8550 基点。')).toBeVisible()

  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText('草稿已保存：钻石会员')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  const bodies = actions().map((write) => {
    const body = { ...write }
    delete body.key
    return body
  })
  expect(bodies).toEqual([
    {
      action: 'preview_rule',
      rule: expect.objectContaining({
        id: '',
        kind: 'tier',
        amountCents: 200000,
        rateBasisPoints: 8550,
        mode: 'single',
      }),
    },
    {
      action: 'save_rule',
      expectedVersion: 'v1',
      rule: expect.objectContaining({
        id: '',
        kind: 'tier',
        name: '钻石会员',
        amountCents: 200000,
        rateBasisPoints: 8550,
        mode: 'single',
        validDays: 0,
      }),
    },
  ])
  expect(actions().every((write) => write.key)).toBe(true)
  await expect(page.locator('.semi-table').getByRole('row', { name: /钻石会员/ })).toContainText('未发布')
})

test('生日福利的两组单选各管各的：选福利内容不清掉领取时间', async ({ page }) => {
  await open(page)
  await page.goto('/rules?tab=birthday')
  await page.getByRole('button', { name: '新建生日福利' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await sheet.locator('.semi-radio', { hasText: '仅生日当天可领' }).click()
  await expect(sheet.getByRole('radio', { name: '仅生日当天可领' })).toBeChecked()
  await sheet.locator('.semi-radio', { hasText: '送礼物' }).click()
  await expect(sheet.getByRole('radio', { name: '送礼物' })).toBeChecked()
  // 两组同名时浏览器把它们当成一组：选了福利内容，领取时间的勾就被取消
  await expect(sheet.getByRole('radio', { name: '仅生日当天可领' })).toBeChecked()
  await sheet.locator('.semi-radio', { hasText: '生日当月可领' }).click()
  await expect(sheet.getByRole('radio', { name: '送礼物' })).toBeChecked()
})

test('有未保存的输入时离开要确认，选择继续编辑则输入保留', async ({ page }) => {
  await open(page)
  await page.goto('/rules')
  await page.getByRole('tab', { name: '充值方案' }).click()
  await expect(page).toHaveURL(/tab=recharge/)
  await page.getByRole('button', { name: '新建充值方案' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await sheet.getByLabel('名称').fill('充 300 送 30')

  // 浏览器后退：被拦下来问一声
  await page.evaluate(() => window.history.back())
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('放弃未保存的修改？')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '继续编辑' }).click()
  await expect(page).toHaveURL(/tab=recharge/)
  await expect(sheet.getByLabel('名称')).toHaveValue('充 300 送 30')

  // 关抽屉同样要确认；放弃后抽屉关闭
  await sheet.getByRole('button', { name: '取消' }).click()
  await page.locator('.semi-modal button', { hasText: '放弃修改' }).click()
  await expect(sheet).toHaveCount(0)
})

test('老板发布：先看服务端计算示例、必填影响说明；停用同样要写影响（断言请求体）', async ({ page }) => {
  const { actions } = await open(page)
  await page.goto('/rules')
  const table = page.locator('.semi-table')

  await table
    .getByRole('row', { name: /白银会员/ })
    .getByRole('button', { name: '发布' })
    .click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('发布会员等级「白银会员」')).toBeVisible()
  await expect(dialog.getByText('已获得的等级、已充值的余额与积分', { exact: false })).toBeVisible()
  await expect(dialog.getByText('服务端示例：白银会员，门槛 20000 分，计价 9500 基点。')).toBeVisible()
  await expect(dialog.getByText('没有生效中的版本')).toBeVisible()

  // 不写影响说明不能发布
  await page.locator('.semi-modal button', { hasText: '确认发布' }).click()
  await expect(dialog.getByText('请填写影响说明')).toBeVisible()
  expect(actions().filter((write) => write.action === 'publish')).toHaveLength(0)

  await dialog.getByLabel('影响说明').fill('新增白银等级，只影响之后的充值')
  await page.locator('.semi-modal button', { hasText: '确认发布' }).click()
  await expect(page.getByText('已发布「白银会员」')).toBeVisible()
  await expect(table.getByRole('row', { name: /白银会员/ })).toContainText('生效中')
  const publish = actions().find((write) => write.action === 'publish')
  expect(publish).toMatchObject({
    action: 'publish',
    targetId: 'r-silver',
    expectedVersion: 'v1',
    reason: '新增白银等级，只影响之后的充值',
  })
  expect(publish?.key).toBeTruthy()

  // 停用：写清停用后果，影响说明随请求提交，版本是发布后重新读到的
  await table
    .getByRole('row', { name: /黄金会员/ })
    .getByRole('button', { name: '停用' })
    .click()
  await expect(dialog.getByText('停用会员等级「黄金会员」')).toBeVisible()
  await expect(dialog.getByText('停用后，顾客看不到这项规则', { exact: false })).toBeVisible()
  await dialog.getByLabel('影响说明').fill('等级调整，已获得的黄金等级照常保留到期')
  await page.locator('.semi-modal button', { hasText: '确认停用' }).click()
  await expect(page.getByText('已停用「黄金会员」')).toBeVisible()
  await expect(table.getByRole('row', { name: /黄金会员/ })).toContainText('已停用')
  expect(actions().find((write) => write.action === 'disable')).toMatchObject({
    action: 'disable',
    targetId: 'r-gold',
    expectedVersion: 'v2',
    reason: '等级调整，已获得的黄金等级照常保留到期',
  })
})

// 计算示例只算不写：它的请求也会推回一条实时事件（模拟最坏情况），页面不能因此重算——
// 以前发布确认框开着时每秒约 3 次「预览 → 广播 → 重读 → 再预览」，循环不止。
test('发布确认框开着时，计算示例只请求一次，不随实时事件循环', async ({ page }) => {
  const { actions } = await open(page)
  await page.goto('/rules')
  await page
    .locator('.semi-table')
    .getByRole('row', { name: /白银会员/ })
    .getByRole('button', { name: '发布' })
    .click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('服务端示例：白银会员，门槛 20000 分，计价 9500 基点。')).toBeVisible()
  await page.waitForTimeout(3000)
  expect(actions().filter((write) => write.action === 'preview_rule')).toHaveLength(1)
})

test('店长能编草稿、看计算示例，看不到发布和停用', async ({ page }) => {
  await open(page, manager)
  await page.goto('/rules')
  await expect(page.getByText('发布和停用由老板操作', { exact: false })).toBeVisible()
  const table = page.locator('.semi-table')
  const goldRow = table.getByRole('row', { name: /黄金会员/ })
  await expect(goldRow.getByRole('button', { name: '编辑' })).toBeVisible()
  await expect(table.getByRole('button', { name: /发布/ })).toHaveCount(0)
  await expect(table.getByRole('button', { name: '停用' })).toHaveCount(0)

  await goldRow.getByRole('button', { name: '计算示例' }).click()
  await expect(
    page.locator('.semi-modal').getByText('服务端示例：黄金会员，门槛 50000 分，计价 9000 基点。'),
  ).toBeVisible()
})

test('发布时设置已被别人改过：提示重新读取，读到最新内容后由老板再次确认，不自动重提', async ({ page }) => {
  const { backend, actions } = await open(page)
  await page.goto('/rules')
  const table = page.locator('.semi-table')
  await table
    .getByRole('row', { name: /白银会员/ })
    .getByRole('button', { name: '发布' })
    .click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('服务端示例：白银会员，门槛 20000 分，计价 9500 基点。')).toBeVisible()

  // 老板看着确认框的时候，店长把白银会员的门槛改成了 300 元
  backend.state.drafts['r-silver'] = { ...silver, amountCents: 30000 }
  backend.state.version++

  await dialog.getByLabel('影响说明').fill('新增白银等级')
  await page.locator('.semi-modal button', { hasText: '确认发布' }).click()
  await expect(dialog.getByText('设置已变化，请刷新后重新确认', { exact: false })).toBeVisible()
  expect(actions().filter((write) => write.action === 'publish')).toHaveLength(1)

  await dialog.getByRole('button', { name: '重新读取' }).click()
  await expect(dialog.getByText('规则在此期间被改过', { exact: false })).toBeVisible()
  await expect(dialog.getByText('单次充值满 ¥300.00', { exact: false })).toBeVisible()
  await expect(dialog.getByText('服务端示例：白银会员，门槛 30000 分，计价 9500 基点。')).toBeVisible()
  // 影响说明保留；没有自动重提
  await expect(dialog.getByLabel('影响说明')).toHaveValue('新增白银等级')
  expect(actions().filter((write) => write.action === 'publish')).toHaveLength(1)

  await page.locator('.semi-modal button', { hasText: '确认发布' }).click()
  await expect(page.getByText('已发布「白银会员」')).toBeVisible()
  expect(
    actions()
      .filter((write) => write.action === 'publish')
      .map((write) => write.expectedVersion),
  ).toEqual(['v1', 'v2'])
})

test('保存草稿时版本冲突：保留输入，重新读取后再保存', async ({ page }) => {
  const { backend, actions } = await open(page)
  await page.goto('/rules')
  await page
    .locator('.semi-table')
    .getByRole('row', { name: /白银会员/ })
    .getByRole('button', { name: '编辑' })
    .click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.getByLabel('升级门槛')).toHaveValue('200.00')
  await expect(sheet.getByLabel('会员价')).toHaveValue('95')

  // 编辑期间别人改了同一条草稿
  backend.state.drafts['r-silver'] = { ...silver, name: '白银会员（新）' }
  backend.state.version++

  await sheet.getByLabel('会员价').fill('92.5')
  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(sheet.getByText('设置已变化，请刷新后重新确认', { exact: false })).toBeVisible()
  await sheet.getByRole('button', { name: '重新读取' }).click()
  await expect(sheet.getByText('这条草稿在你编辑期间被修改过', { exact: false })).toBeVisible()
  await expect(sheet.getByLabel('会员价')).toHaveValue('92.5')

  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText('草稿已保存：白银会员')).toBeVisible()
  const saves = actions().filter((write) => write.action === 'save_rule')
  expect(saves.map((write) => write.expectedVersion)).toEqual(['v1', 'v2'])
  expect(saves[1]).toMatchObject({ rule: { id: 'r-silver', rateBasisPoints: 9250, amountCents: 20000 } })
})

test('计时套餐的超时可选「按续时方案自动加收」：没有续时方案时不能选，选了填宽限（默认 10 分钟）', async ({ page }) => {
  const { actions } = await open(page)
  await page.goto('/rules?tab=package')
  await page.getByRole('button', { name: '新建计时套餐' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await sheet.getByLabel('名称').fill('1小时')
  await sheet.getByLabel('套餐价格').fill('29.9')
  await sheet.getByLabel('时长').fill('60')

  const renewal = sheet.getByRole('radio', { name: /按续时方案自动加收/ })
  await expect(renewal).toBeDisabled()
  await expect(sheet.getByText('要先填每次续时和续时价格')).toBeVisible()
  await expect(sheet.getByLabel('超时宽限')).toHaveCount(0)

  await sheet.getByLabel('每次续时').fill('30')
  await sheet.getByLabel('续时价格').fill('15')
  await expect(renewal).toBeEnabled()
  await sheet.locator('.semi-radio', { hasText: '按续时方案自动加收' }).click()
  await expect(sheet.getByLabel('超时宽限')).toHaveValue('10')
  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText('草稿已保存：1小时')).toBeVisible()
  expect(actions().find((write) => write.action === 'save_rule')).toMatchObject({
    rule: {
      kind: 'package',
      amountCents: 2990,
      durationMinutes: 60,
      renewalMinutes: 30,
      renewalCents: 1500,
      overtime: 'renewal',
      overtimeGraceMinutes: 10,
    },
  })
  await expect(page.locator('.semi-table').getByText(/超时宽限 10 分钟，之后按续时方案自动加收/)).toBeVisible()
})

test('自由计时价与陪客费：填每 30 分钟的价时同时显示折合每小时，块长 30 分钟随规则保存', async ({ page }) => {
  const { actions } = await open(page)
  await page.goto('/rules?tab=free_timing')
  await expect(page.getByRole('tab', { name: '自由计时价' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '新建自由计时价' }).click()
  const sheet = page.locator('.semi-sidesheet')
  await sheet.getByLabel('名称').fill('自由计时')
  await expect(sheet.getByText('填好每块的价后这里显示折合每小时多少。')).toBeVisible()
  await sheet.getByLabel('每 30 分钟').fill('12.5')
  await expect(sheet.getByText('折合每小时 ¥25.00')).toBeVisible()
  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText('草稿已保存：自由计时')).toBeVisible()
  expect(actions().find((write) => write.action === 'save_rule')).toMatchObject({
    rule: { kind: 'free_timing', amountCents: 1250, durationMinutes: 30 },
  })

  await page.getByRole('tab', { name: '陪客费' }).click()
  await page.getByRole('button', { name: '新建陪客费' }).click()
  await sheet.getByLabel('名称').fill('陪客')
  await sheet.getByLabel('陪客费').fill('20')
  await sheet.getByRole('button', { name: '保存草稿' }).click()
  await expect(page.getByText('草稿已保存：陪客')).toBeVisible()
  expect(actions().filter((write) => write.action === 'save_rule')[1]).toMatchObject({
    rule: { kind: 'companion', amountCents: 2000 },
  })
})
