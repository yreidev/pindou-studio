import { expect, test } from '@playwright/test'
import { mockApi, signIn, type MockHandler, type MockResult } from './mock-api'

// 运营与系统：导出直接下载、日期校验；老板的备份创建、下载与恢复（确认流程、409 显示原因）；审计搜索与分页。

// 操作人的称呼（AccountLabel）由服务端带在每条审计上；系统操作和已不在的账户为 null
const accounts = [
  { id: 'u-owner', nickname: '阿贝', phoneMasked: '138****0001' },
  { id: 'u-li', nickname: '小李', phoneMasked: '139****0002' },
]

// 后端按写入顺序返回（旧的在前）
const auditEvents = [
  {
    id: 'a1',
    action: 'role.bootstrap-owner',
    objectId: 'u-owner',
    accountId: 'system',
    requestId: 'req-1',
    createdAt: '2026-10-01T01:00:00Z',
  },
  {
    id: 'a2',
    action: 'order.refunded',
    objectId: 'order-7f3a',
    reason: '顾客不想要了',
    accountId: 'u-li',
    requestId: 'req-2',
    createdAt: '2026-10-02T03:00:00Z',
  },
  {
    id: 'a3',
    action: 'web_login.approved',
    objectId: 'challenge-9',
    reason: 'Mozilla/5.0 Chrome',
    accountId: 'u-owner',
    requestId: 'req-3',
    createdAt: '2026-10-03T05:30:00Z',
  },
]

const withActor = (event: AuditRow) => ({
  ...event,
  actor: accounts.find((account) => account.id === event.accountId) ?? null,
})

type AuditRow = {
  id: string
  action: string
  objectId?: string
  reason?: string
  accountId?: string
  requestId?: string
  createdAt: string
}

/** 模拟 GET /system/audit-events 的服务端筛选与分页（真实口径由 Go 测试覆盖）：q 匹配编号、原因、操作人昵称，
 * actions 是网页按中文动作名换好的动作代码，命中其一即算；新的在前；带 pageSize 时只回那一页。 */
function auditListResult(events: readonly AuditRow[], search: URLSearchParams): MockResult {
  const needle = (search.get('q') ?? '').toLowerCase()
  const actions = new Set((search.get('actions') ?? '').split(',').filter(Boolean))
  const nickname = (id?: string) => accounts.find((account) => account.id === id)?.nickname ?? ''
  const matched = events
    .filter(
      (event) =>
        (!needle && !actions.size) ||
        actions.has(event.action) ||
        (needle !== '' &&
          [
            event.action,
            event.objectId,
            event.requestId,
            event.reason,
            event.accountId,
            nickname(event.accountId),
          ].some((field) => field?.toLowerCase().includes(needle))),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const pageSize = Number(search.get('pageSize'))
  if (!pageSize) return { status: 200, body: matched.map(withActor) }
  const page = Math.min(Math.max(1, Number(search.get('page')) || 1), Math.max(1, Math.ceil(matched.length / pageSize)))
  return {
    status: 200,
    body: matched.slice((page - 1) * pageSize, page * pageSize).map(withActor),
    headers: { 'X-Total-Count': String(matched.length), 'X-Page': String(page) },
  }
}

test('老板：导出带日期校验并直接下载；全部数据导出直接存成文件，失败时显示原因', async ({ page }) => {
  const exports: string[] = []
  let dataExports = 0
  const handler: MockHandler = ({ method, path, search }) => {
    if (method === 'GET' && path === '/system/audit-events') return { status: 200, body: auditEvents.map(withActor) }
    if (method === 'GET' && path.startsWith('/reports/exports/')) {
      exports.push(`${path}?${search.toString()}`)
      return { status: 200, body: 'xlsx' }
    }
    if (method === 'POST' && path === '/system/data-exports') {
      dataExports++
      if (dataExports === 1)
        return { status: 503, body: { code: 'persistence_failed', message: '数据没能保存，请重试', requestId: 'r' } }
      return { status: 200, body: { Users: {} } }
    }
    return undefined
  }
  const api = await mockApi(page, { handlers: [handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/operations')
  await expect(page.getByRole('heading', { name: '运营与系统' })).toBeVisible()

  // ---- 导出：开始晚于结束时拦下，不发请求；库存不按日期，照常可导
  // （只看内容区里的提示：页面顶部「点一下页面任意处开启提示音」也是 alert）
  await page.getByLabel('开始日期').fill('2026-10-05')
  await page.getByLabel('结束日期').fill('2026-10-01')
  await expect(page.locator('.admin-content').getByRole('alert')).toContainText('开始日期不能晚于结束日期')
  await expect(page.getByRole('button', { name: '下载订单 Excel' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '下载库存 Excel' })).toBeEnabled()
  expect(exports).toHaveLength(0)

  await page.getByLabel('结束日期').fill('2026-10-06')
  await expect(page.locator('.admin-content').getByRole('alert')).toHaveCount(0)
  await expect(page).toHaveURL(/from=2026-10-05/)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载订单 Excel' }).click()
  expect((await download).suggestedFilename()).toBe('示例工坊-订单-2026-10-05至2026-10-06.xlsx')
  await expect(page.getByText('订单报表已开始下载')).toBeVisible()
  expect(exports).toEqual(['/reports/exports/orders?from=2026-10-05&to=2026-10-06'])

  // ---- 全部数据：只有一个下载按钮，没有应用内备份和恢复
  await page.getByRole('tab', { name: '数据导出' }).click()
  await expect(page.getByText('含全部账户（包括完整手机号）')).toBeVisible()
  await expect(page.getByRole('button', { name: /恢复/ })).toHaveCount(0)
  // 后端失败：显示原因，不下载
  await page.getByRole('button', { name: '下载 JSON' }).click()
  await expect(page.getByText('数据没能保存，请重试')).toBeVisible()
  // 再点一次成功：浏览器直接存成文件，文件名带门店时区的下载时间
  const dataDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 JSON' }).click()
  expect((await dataDownload).suggestedFilename()).toMatch(/^示例工坊-数据-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.json$/)
  await expect(page.getByText('数据已开始下载')).toBeVisible()
  await expect(page.getByText('数据没能保存，请重试')).toHaveCount(0)
  expect(api.writes.filter((write) => write.path === '/system/data-exports')).toMatchObject([
    { method: 'POST' },
    { method: 'POST' },
  ])
})

test('店长导出库存流水：受日期范围约束，文件名带日期；库存（当时数量）照旧不按日期', async ({ page }) => {
  const exports: string[] = []
  await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长小王', roles: ['manager'], phoneVerificationStatus: 'verified' },
    handlers: [
      ({ method, path, search }) => {
        if (method === 'GET' && path.startsWith('/reports/exports/')) {
          exports.push(`${path}?${search.toString()}`)
          return { status: 200, body: 'xlsx' }
        }
        return undefined
      },
    ],
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长小王', roles: ['manager'] })
  await page.goto('/operations')

  const ledger = page.getByRole('button', { name: '下载库存流水 Excel' })
  await expect(ledger).toBeVisible()
  await expect(page.getByText('按发生日期筛选：采购入库、盘点、销售出库、退款回补、会员出入库逐笔列出')).toBeVisible()

  // 开始晚于结束：流水不能导，库存（不按日期）照常
  await page.getByLabel('开始日期').fill('2026-10-04')
  await page.getByLabel('结束日期').fill('2026-10-01')
  await expect(page.locator('.admin-content').getByRole('alert')).toContainText('开始日期不能晚于结束日期')
  await expect(ledger).toBeDisabled()
  await expect(page.getByRole('button', { name: '下载库存 Excel' })).toBeEnabled()
  expect(exports).toHaveLength(0)

  await page.getByLabel('开始日期').fill('2026-10-01')
  await page.getByLabel('结束日期').fill('2026-10-04')
  await expect(page.locator('.admin-content').getByRole('alert')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await ledger.click()
  expect((await download).suggestedFilename()).toBe('示例工坊-库存流水-2026-10-01至2026-10-04.xlsx')
  await expect(page.getByText('库存流水报表已开始下载')).toBeVisible()

  // 库存导出不带日期
  const stockDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载库存 Excel' }).click()
  expect((await stockDownload).suggestedFilename()).toMatch(/^示例工坊-库存-\d{4}-\d{2}-\d{2}\.xlsx$/)
  expect(exports).toEqual(['/reports/exports/movements?from=2026-10-01&to=2026-10-04', '/reports/exports/inventory?'])
})

test('审计：中文操作名、最新在前、按关键字搜索、分页', async ({ page }) => {
  // 25 条收款记录 + 上面三条，验证分页
  const many = Array.from({ length: 25 }, (_, index) => ({
    id: `pay-${index}`,
    action: 'order.paid',
    objectId: `order-${String(index).padStart(3, '0')}`,
    // 第 12 条的操作人账户已不在：服务端称呼为 null，只显示编号
    accountId: index === 12 ? 'deadbeef-0000-4000-8000-000000000000' : 'u-li',
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  }))
  const auditSearches: URLSearchParams[] = []
  await mockApi(page, {
    handlers: [
      ({ method, path, search }) => {
        if (method !== 'GET' || path !== '/system/audit-events') return undefined
        auditSearches.push(new URLSearchParams(search))
        return auditListResult([...many, ...auditEvents], search)
      },
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/operations?tab=audit')

  const table = page.locator('.semi-table')
  const firstRow = table.getByRole('row').nth(1)
  await expect(firstRow).toContainText('批准电脑登录')
  await expect(firstRow).toContainText('web_login.approved')
  await expect(firstRow).toContainText('阿贝 · 138****0001')
  await expect(firstRow).toContainText('2026-10-03 13:30')
  await expect(page.getByText('共 28 条，最新的在前')).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(21)

  // 分页：第 2 页 8 条，页码写进网址
  await page.locator('.semi-page-item', { hasText: '2' }).click()
  await expect(page).toHaveURL(/page=2/)
  await expect(table.getByRole('row')).toHaveCount(9)

  // 按中文操作名搜：中文名只有网页端知道，换成动作代码交给服务端一起筛
  await page.getByLabel('查找审计记录').fill('退款')
  await expect(page.getByText('找到 1 条，最新的在前')).toBeVisible()
  await expect(page).toHaveURL(/q=/)
  expect(auditSearches.at(-1)?.get('q')).toBe('退款')
  expect(auditSearches.at(-1)?.get('actions')?.split(',')).toContain('order.refunded')
  await expect(table.getByRole('row').nth(1)).toContainText('登记退款')
  await expect(table.getByRole('row').nth(1)).toContainText('顾客不想要了')
  await expect(table.getByRole('row').nth(1)).toContainText('小李 · 139****0002')

  // 按对象编号搜（显示前 8 位，搜完整编号也能找到）
  await page.getByLabel('查找审计记录').fill('order-012')
  await expect(page.getByText('找到 1 条，最新的在前')).toBeVisible()
  await expect(table.getByRole('row').nth(1)).toContainText('确认收款')
  await expect(table.getByRole('row').nth(1)).toContainText('deadbeef')

  // 按原因搜；系统初始化的操作人显示「系统」
  await page.getByLabel('查找审计记录').fill('初始化')
  await expect(table.getByRole('row').nth(1)).toContainText('系统')

  await page.getByLabel('查找审计记录').fill('没有这种记录')
  await expect(page.getByText('没有匹配的记录，换个关键字试试')).toBeVisible()
})

test('店长：只有导出和审计，没有全部数据导出；打开那个链接回到报表导出', async ({ page }) => {
  let dataReads = 0
  await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长小王', roles: ['manager'], phoneVerificationStatus: 'verified' },
    handlers: [
      ({ method, path }) => {
        if (path.startsWith('/system/data-exports')) dataReads++
        if (method === 'GET' && path === '/system/audit-events')
          return { status: 200, body: auditEvents.map(withActor) }
        return undefined
      },
    ],
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长小王', roles: ['manager'] })
  await page.goto('/operations?tab=data')
  await expect(page.getByRole('tab', { name: '报表导出' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: '数据导出' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '下载订单 Excel' })).toBeVisible()
  await page.getByRole('tab', { name: '审计记录' }).click()
  await expect(page.locator('.semi-table').getByText('登记退款')).toBeVisible()
  expect(dataReads).toBe(0)
})

test('店员：侧栏没有运营与系统，直接打开也只看到无权说明', async ({ page }) => {
  await mockApi(page, {
    account: { id: 'u-li', nickname: '小李', roles: ['clerk'], phoneVerificationStatus: 'verified' },
  })
  await signIn(page, { id: 'u-li', nickname: '小李', roles: ['clerk'] })
  await page.goto('/operations')
  await expect(page.getByText('当前账号无权查看')).toBeVisible()
  await expect(page.locator('.semi-layout-sider').getByText('运营与系统')).toHaveCount(0)
  await expect(page.locator('.semi-layout-sider').getByText('桌码')).toBeVisible()
})
