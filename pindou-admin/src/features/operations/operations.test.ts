import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { operationsApi } from '../../api/operations'
import { actionsMatching, auditActor, auditName, auditNames } from './audit'
import { dataExportFilename } from './dataExport'
import { exportFilename, exportOptions, exportRangeError, quickRanges } from './exports'
import { readableError } from './messages'
import { currentTab, operationsSearchSchema, operationsTabs } from './search'

// 后端源码与接口契约：审计动作的中文名要跟上后端新增的动作。测试在 pindou-admin 目录下用 Node 跑，
// 直接读仓库文件（Vite 不允许 import 项目目录以外的文件；网页代码的类型里没有 Node，这里按需动态加载）。
type NodeFs = { readFileSync(path: string, encoding: 'utf8'): string; readdirSync(path: string): string[] }
const fsModule = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsModule)) as NodeFs
const backendDir = '../pindou-backend/internal/app'
const goSources = fs
  .readdirSync(backendDir)
  .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'))
  .map((name) => fs.readFileSync(`${backendDir}/${name}`, 'utf8'))
  .join('\n')
const apiContract = fs.readFileSync('../docs/api.yaml', 'utf8')

function contractEnum(schema: string): string[] {
  const lines = apiContract.split('\n')
  const start = lines.findIndex((line) => line === `    ${schema}:`)
  const enumLine = lines.findIndex((line, index) => index > start && line.trim() === 'enum:')
  const values: string[] = []
  for (const line of lines.slice(enumLine + 1)) {
    const match = /^\s+- (\S+)$/.exec(line)
    if (!match) break
    values.push(match[1])
  }
  return values
}

describe('报表导出', () => {
  it('日期可以不填；开始晚于结束、格式不对都拦下', () => {
    expect(exportRangeError('', '')).toBeNull()
    expect(exportRangeError('2026-10-01', '')).toBeNull()
    expect(exportRangeError('2026-10-01', '2026-10-01')).toBeNull()
    expect(exportRangeError('2026-10-05', '2026-10-01')).toBe('开始日期不能晚于结束日期')
    expect(exportRangeError('2026/10/01', '')).toBe('日期格式应为 年-月-日')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('导出地址只带填了的日期，取回文件内容', async () => {
    const paths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const url = new URL(request.url)
        paths.push(url.pathname + url.search)
        return new Response('xlsx', { status: 200 })
      }),
    )
    const blob = await operationsApi.exportFile('orders', {})
    expect(await blob.text()).toBe('xlsx')
    await operationsApi.exportFile('refunds', { from: '2026-10-01' })
    await operationsApi.exportFile('purchases', { from: '', to: '2026-10-04' })
    await operationsApi.exportFile('movements', { from: '2026-10-01', to: '2026-10-04' })
    expect(paths).toEqual([
      '/api/v2/reports/exports/orders',
      '/api/v2/reports/exports/refunds?from=2026-10-01',
      '/api/v2/reports/exports/purchases?to=2026-10-04',
      '/api/v2/reports/exports/movements?from=2026-10-01&to=2026-10-04',
    ])
  })

  it('文件名带种类和日期范围；库存只写导出日期', () => {
    const orders = exportOptions.find((option) => option.kind === 'orders')!
    const inventory = exportOptions.find((option) => option.kind === 'inventory')!
    const today = '2026-10-04'
    expect(exportFilename(orders, '2026-10-01', '2026-10-04', today)).toBe('示例工坊-订单-2026-10-01至2026-10-04.xlsx')
    expect(exportFilename(orders, '2026-10-02', '2026-10-02', today)).toBe('示例工坊-订单-2026-10-02.xlsx')
    expect(exportFilename(orders, '2026-10-01', '', today)).toBe('示例工坊-订单-2026-10-01起.xlsx')
    expect(exportFilename(orders, '', '2026-10-03', today)).toBe('示例工坊-订单-截至2026-10-03.xlsx')
    expect(exportFilename(orders, '', '', today)).toBe('示例工坊-订单-全部-截至2026-10-04.xlsx')
    expect(exportFilename(inventory, '2026-10-01', '2026-10-03', today)).toBe('示例工坊-库存-2026-10-04.xlsx')
  })

  it('库存流水按日期导出，文件名照同样的规则；库存（当时数量）照旧保留', () => {
    const movements = exportOptions.find((option) => option.kind === 'movements')!
    expect(movements).toMatchObject({ label: '库存流水', usesDates: true })
    expect(exportFilename(movements, '2026-10-01', '2026-10-04', '2026-10-04')).toBe(
      '示例工坊-库存流水-2026-10-01至2026-10-04.xlsx',
    )
    expect(exportFilename(movements, '', '', '2026-10-04')).toBe('示例工坊-库存流水-全部-截至2026-10-04.xlsx')
    expect(exportOptions.map((option) => option.kind)).toEqual([
      'orders',
      'refunds',
      'purchases',
      'movements',
      'inventory',
    ])
  })

  it('导出种类和接口契约的 ExportKind 一致', () => {
    const match = /ExportKind: \{[^\n]*enum: \[([^\]]+)\]/.exec(apiContract)
    expect(match).not.toBeNull()
    const contract = match![1].split(',').map((kind) => kind.trim())
    expect([...exportOptions.map((option) => option.kind)].sort()).toEqual([...contract].sort())
  })

  it('常用范围按门店日期算，跨年的上月也对', () => {
    expect(quickRanges('2026-10-04')).toEqual([
      { label: '今天', from: '2026-10-04', to: '2026-10-04' },
      { label: '本月', from: '2026-10-01', to: '2026-10-04' },
      { label: '上月', from: '2026-09-01', to: '2026-09-30' },
    ])
    expect(quickRanges('2027-01-15')[2]).toEqual({ label: '上月', from: '2026-12-01', to: '2026-12-31' })
    expect(quickRanges('2028-03-01')[2]).toEqual({ label: '上月', from: '2028-02-01', to: '2028-02-29' })
  })
})

describe('审计', () => {
  it('后端写审计的每个动作都有中文名', () => {
    // "loyalty."+动作、"reservation."+动作 这种拼接的前缀不算，下面按契约里的动作枚举逐个查
    const literal = [...goSources.matchAll(/\baudit\([^,]+,\s*"([a-z_.-]+)"/g)]
      .map((match) => match[1])
      .filter((action) => !action.endsWith('.'))
    const webLogin = [...goSources.matchAll(/"(web_login\.[a-z_]+)"/g)].map((match) => match[1])
    // 会员与预约按动作名拼接（loyalty.<action>、reservation.<action>）；只算不写的 quote、refund_quote、preview_rule 不记审计
    const readOnly = new Set(['quote', 'refund_quote', 'preview_rule'])
    const loyalty = contractEnum('LoyaltyAction')
      .filter((action) => !readOnly.has(action))
      .map((action) => `loyalty.${action}`)
    const reservation = contractEnum('ReservationAction').map((action) => `reservation.${action}`)
    expect(literal.length).toBeGreaterThan(10)
    expect(webLogin).toEqual(expect.arrayContaining(['web_login.approved', 'web_login.rejected']))
    expect(loyalty.length).toBeGreaterThan(15)
    expect(reservation.length).toBeGreaterThan(5)
    const missing = [...literal, ...webLogin, ...loyalty, ...reservation].filter((action) => !auditNames[action])
    expect(missing).toEqual([])
  })

  it('没登记的动作照原样显示', () => {
    expect(auditName('order.paid')).toBe('确认收款')
    expect(auditName('something.new')).toBe('something.new')
  })

  // 审计的筛选、排序、分页在服务端；中文动作名只有网页端知道，按名查找时把对上的动作代码一起发过去
  it('操作人用服务端带的称呼；系统动作显示「系统」，账户不在了显示编号前 8 位', () => {
    const li = { id: 'u-li', nickname: '小李', phoneMasked: '139****0002' }
    expect(auditActor({ accountId: 'u-li', actor: li })).toBe('小李 · 139****0002')
    expect(auditActor({ accountId: 'system', actor: null })).toBe('系统')
    expect(auditActor({ accountId: '12345678-gone', actor: null })).toBe('12345678')
    expect(auditActor({ accountId: '', actor: null })).toBe('—')
  })

  it('按中文动作名找出动作代码，不分大小写；空关键字不带', () => {
    expect(actionsMatching('')).toEqual([])
    expect(actionsMatching('  ')).toEqual([])
    expect(actionsMatching('收款')).toEqual(['order.paid', 'order.payment.partial'])
    expect(actionsMatching('电脑登录')).toEqual(
      expect.arrayContaining(['web_login.approved', 'web_login.rejected', 'web_sessions.revoked']),
    )
    expect(actionsMatching('没有这个')).toEqual([])
  })
})

describe('全部数据导出', () => {
  it('文件名用门店时区的下载时间', () => {
    expect(dataExportFilename(new Date('2026-10-04T07:30:00Z'))).toBe('示例工坊-数据-2026-10-04_15-30.json')
  })
})

describe('错误提示', () => {
  it('后端有中文说明就原样显示，只有英文代号的换成中文', () => {
    expect(readableError(new ApiError(400, 'invalid_range', '开始日期不能晚于结束日期'))).toBe(
      '开始日期不能晚于结束日期',
    )
    expect(readableError(new ApiError(403, 'forbidden', 'forbidden'))).toBe('当前账号无权执行此操作')
    expect(readableError(new ApiError(404, 'not_found', 'not_found'))).toBe('要操作的记录不存在，请刷新后重试')
    expect(readableError(new ApiError(500, 'export_failed', 'unexpected end of JSON'), '下载失败')).toBe(
      '下载失败（export_failed）',
    )
    expect(readableError(new TypeError('Failed to fetch'), '导出失败')).toBe('导出失败')
  })
})

describe('网址参数', () => {
  it('数据导出标签只给老板，别人打开那个链接回到报表导出', () => {
    expect(operationsTabs(false).map((tab) => tab.key)).toEqual(['export', 'audit'])
    expect(operationsTabs(true).map((tab) => tab.key)).toEqual(['export', 'audit', 'data'])
    expect(currentTab('data', false)).toBe('export')
    expect(currentTab('data', true)).toBe('data')
    expect(currentTab(undefined, true)).toBe('export')
  })

  it('乱写的参数忽略，页码转成数字', () => {
    expect(operationsSearchSchema.parse({ tab: 'nope', page: '3', q: '收款' })).toEqual({
      tab: undefined,
      page: 3,
      q: '收款',
    })
    expect(operationsSearchSchema.parse({ page: '0' }).page).toBeUndefined()
  })
})
