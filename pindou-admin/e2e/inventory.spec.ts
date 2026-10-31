import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 商品与库存：库存搜索与预警、改预警线、采购入库、盘点（含库存已变化的 409 重读）、流水、商品资料，
// 以及按角色隐藏做不了的操作。
// 接口由这里模拟（写请求的权限与事务由 Go 测试覆盖），断言请求体、幂等键和成功后的重读。

const P_BEADS = '11111111-1111-4111-8111-111111111111'
const P_BOARD = '22222222-2222-4222-8222-222222222222'
const P_LEGACY = '33333333-3333-4333-8333-333333333333'
const P_CLEAR = '44444444-4444-4444-8444-444444444444'
const S_BEADS = 'aaaaaaaa-1111-4111-8111-111111111111'
const S_BOARD = 'aaaaaaaa-2222-4222-8222-222222222222'
const S_LEGACY = 'aaaaaaaa-3333-4333-8333-333333333333'

const clerk = { id: 'u-clerk', nickname: '小林', roles: ['clerk'], phoneVerificationStatus: 'verified' as const }
const manager = { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' as const }

interface Movement {
  id: string
  stockItemId: string
  productId: string
  kind: string
  quantityDelta: number
  createdAt: string
  reason?: string
  referenceId?: string
  supplierName?: string
  note?: string
}

/** 一家店的模拟库存：写请求会真的改数，便于断言「成功后重读到了新数字」。 */
interface Product {
  id: string
  name: string
  unitPriceCents: number
  barcode?: string
}

interface Prefill {
  supplierName?: string
  lastUnitCosts: { productId: string; unitCostCents: number }[]
}

function shop() {
  const state = {
    catalog: [
      { id: P_BEADS, name: '珠光豆 5mm', unitPriceCents: 1200, barcode: '6901234567892' },
      { id: P_BOARD, name: '拼豆板 方形', unitPriceCents: 800 },
      { id: P_LEGACY, name: '', unitPriceCents: 0 },
      { id: P_CLEAR, name: '透明豆 3mm', unitPriceCents: 1000 },
    ] as Product[],
    stock: [
      { id: S_BEADS, productId: P_BEADS, quantity: 30, alertAt: 10, lowStock: false },
      { id: S_BOARD, productId: P_BOARD, quantity: 2, alertAt: 5, lowStock: true },
      { id: S_LEGACY, productId: P_LEGACY, quantity: 0, alertAt: 0, lowStock: true },
    ],
    movements: [
      {
        id: 'm4',
        stockItemId: S_BEADS,
        productId: P_BEADS,
        kind: 'sale',
        quantityDelta: -1,
        createdAt: '2026-10-04T06:00:00Z',
        referenceId: 'order-0004-aaaa',
      },
      {
        id: 'm3',
        stockItemId: S_BEADS,
        productId: P_BEADS,
        kind: 'adjustment',
        quantityDelta: -2,
        createdAt: '2026-10-03T16:30:00Z',
        reason: '月底盘点，受潮 2 包',
        actorId: 'u-owner',
        actorName: '阿贝',
      },
      {
        id: 'm2',
        stockItemId: S_BOARD,
        productId: P_BOARD,
        kind: 'sale',
        quantityDelta: -3,
        createdAt: '2026-10-02T04:00:00Z',
        referenceId: 'order-0002-bbbb',
      },
      {
        id: 'm1',
        stockItemId: S_BEADS,
        productId: P_BEADS,
        kind: 'purchase',
        quantityDelta: 33,
        createdAt: '2026-10-01T02:00:00Z',
        referenceId: 'receipt-1',
        supplierName: '义乌豆子批发',
      },
    ] as Movement[],
    stockReads: 0,
    movementSearches: [] as URLSearchParams[],
    // 入库预填（GET /stock-receipts/prefill）：默认还没入过库；入库成功后和后端一样按这一单更新
    prefill: { lastUnitCosts: [] } as Prefill,
  }
  const lowStock = (item: { quantity: number; alertAt: number }) => item.quantity <= item.alertAt

  const handler: MockHandler = ({ method, path, search, body }) => {
    if (method === 'GET' && path === '/catalog-items') return { status: 200, body: state.catalog }
    if (method === 'GET' && path === '/stock-items') {
      state.stockReads++
      return { status: 200, body: state.stock }
    }
    if (method === 'GET' && path === '/stock-movements') {
      // 筛选在服务端：按商品、类型筛（日期筛选由 Go 测试覆盖）
      state.movementSearches.push(search)
      const item = search.get('stockItemId')
      const kind = search.get('kind')
      const rows = state.movements.filter((row) => (!item || row.stockItemId === item) && (!kind || row.kind === kind))
      return { status: 200, body: rows, headers: { 'X-Total-Count': String(rows.length), 'X-Page': '1' } }
    }
    if (method === 'GET' && path === '/stock-receipts/prefill') return { status: 200, body: state.prefill }
    if (method === 'POST' && path === '/stock-receipts') {
      const input = body as {
        supplierName: string
        items: { productId: string; quantity: number; unitCostCents: number }[]
      }
      state.prefill = {
        supplierName: input.supplierName,
        lastUnitCosts: [
          ...state.prefill.lastUnitCosts.filter(
            (cost) => !input.items.some((line) => line.productId === cost.productId),
          ),
          ...input.items.map((line) => ({ productId: line.productId, unitCostCents: line.unitCostCents })),
        ],
      }
      for (const line of input.items) {
        let item = state.stock.find((row) => row.productId === line.productId)
        if (!item) {
          item = { id: `s-${line.productId}`, productId: line.productId, quantity: 0, alertAt: 0, lowStock: true }
          state.stock.push(item)
        }
        item.quantity += line.quantity
        item.lowStock = lowStock(item)
      }
      return { status: 201, body: { id: 'receipt-new', ...input, createdAt: '2026-10-04T08:00:00Z' } }
    }
    if (method === 'POST' && path === '/stock-adjustments') {
      const input = body as { stockItemId: string; quantityDelta: number; expectedQuantity?: number }
      const item = state.stock.find((row) => row.id === input.stockItemId)
      if (!item) return { status: 404, body: { code: 'not_found', message: 'not_found' } }
      // 和后端一样：带了 expectedQuantity 就和当前库存比，对不上整笔拒绝
      if (input.expectedQuantity !== undefined && input.expectedQuantity !== item.quantity)
        return {
          status: 409,
          body: {
            code: 'stock_quantity_conflict',
            message: `库存已变化（现为 ${item.quantity} 件），请重新核对后再盘点`,
            requestId: 'r',
          },
        }
      item.quantity += input.quantityDelta
      item.lowStock = lowStock(item)
      return { status: 201, body: { id: item.id, quantity: item.quantity } }
    }
    const stockPatch = path.match(/^\/stock-items\/([^/]+)$/)
    if (method === 'PATCH' && stockPatch) {
      const item = state.stock.find((row) => row.id === stockPatch[1])
      if (!item) return { status: 404, body: { code: 'not_found', message: 'not_found' } }
      item.alertAt = (body as { alertAt: number }).alertAt
      item.lowStock = lowStock(item)
      return { status: 200, body: item }
    }
    // 和后端一样：同一条码只能属于一件商品，被占用回 409 barcode_taken 并说清是哪件
    const barcodeTaken = (barcode: string | undefined, self?: string) => {
      const owner = barcode ? state.catalog.find((row) => row.barcode === barcode && row.id !== self) : undefined
      return owner
        ? {
            status: 409,
            body: {
              code: 'barcode_taken',
              message: `条码 ${barcode} 已经登记在「${owner.name}」上，一个条码只能对应一件商品`,
              requestId: 'r',
            },
          }
        : undefined
    }
    if (method === 'POST' && path === '/catalog-items') {
      const input = body as Omit<Product, 'id'>
      const taken = barcodeTaken(input.barcode)
      if (taken) return taken
      const created = { id: '55555555-5555-4555-8555-555555555555', ...input }
      state.catalog.push(created)
      return { status: 201, body: created }
    }
    const patch = path.match(/^\/catalog-items\/([^/]+)$/)
    if (method === 'PATCH' && patch) {
      // 只改带了的字段；barcode 为空串清除
      const input = body as Partial<Omit<Product, 'id'>>
      const taken = barcodeTaken(input.barcode, patch[1])
      if (taken) return taken
      const index = state.catalog.findIndex((row) => row.id === patch[1])
      const next: Product = { ...state.catalog[index], ...input }
      if (!next.barcode) delete next.barcode
      state.catalog[index] = next
      return { status: 200, body: next }
    }
    return undefined
  }
  return { state, handler }
}

const stockTable = (page: Page) => page.locator('.semi-table')
const dataRows = (page: Page) => page.locator('.semi-table tbody tr.semi-table-row')

test('库存：搜索停手后才写进网址，只看预警可叠加，刷新后筛选还在', async ({ page }) => {
  const { handler } = shop()
  await mockApi(page, { handlers: [handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/inventory')

  await expect(page.getByRole('heading', { name: '商品与库存' })).toBeVisible()
  await expect(stockTable(page).getByText('珠光豆 5mm')).toBeVisible()
  await expect(dataRows(page)).toHaveCount(3)
  // 没建资料的历史商品显示「未命名商品 · 编号」
  await expect(stockTable(page).getByText('未命名商品 · 33333333')).toBeVisible()
  await expect(stockTable(page).getByRole('row', { name: /拼豆板 方形/ })).toContainText('库存偏低')

  await page.getByLabel('搜商品名称').fill('拼豆')
  await expect(page).toHaveURL(/q=%E6%8B%BC%E8%B1%86/)
  await expect(dataRows(page)).toHaveCount(1)
  await expect(stockTable(page).getByText('拼豆板 方形')).toBeVisible()

  await page.getByLabel('搜商品名称').fill('')
  await expect(page).not.toHaveURL(/q=/)
  await page.getByText('只看预警').click()
  await expect(page).toHaveURL(/low=true/)
  await expect(dataRows(page)).toHaveCount(2)
  await expect(stockTable(page).getByText('珠光豆 5mm')).toHaveCount(0)

  await page.getByLabel('搜商品名称').fill('未命名')
  await expect(dataRows(page)).toHaveCount(1)
  await expect(page).toHaveURL(/low=true/)

  await page.reload()
  await expect(page.getByLabel('搜商品名称')).toHaveValue('未命名')
  await expect(dataRows(page)).toHaveCount(1)
  await expect(stockTable(page).getByText('未命名商品 · 33333333')).toBeVisible()
})

test('店员采购入库：校验、确认后带幂等键提交，成功后库存重读', async ({ page }) => {
  const { state, handler } = shop()
  const api = await mockApi(page, { account: clerk, handlers: [handler] })
  await signIn(page, clerk)
  await page.goto('/inventory?tab=purchase')

  // 空表单直接提交：前端拦下，不发请求
  await page.getByRole('button', { name: '登记入库' }).click()
  await expect(page.getByText('请填写供应商')).toBeVisible()
  await expect(page.getByText('请选择商品')).toBeVisible()
  await expect(page.getByText('请填写采购单价')).toBeVisible()
  // 错误挂在各自的框上：供应商有可见标题；明细一格一格各自有名字；整张明细是一组「采购明细」
  await expect(page.getByLabel('供应商')).toHaveAccessibleDescription('请填写供应商')
  await expect(page.getByLabel('供应商')).toHaveAttribute('aria-required', 'true')
  const lines = page.getByRole('group', { name: '采购明细' })
  await expect(lines.getByRole('combobox', { name: '第 1 行商品' })).toHaveAccessibleDescription('请选择商品')
  await expect(lines.getByLabel('第 1 行单价')).toHaveAccessibleDescription('请填写采购单价')
  expect(api.writes).toHaveLength(0)

  await page.getByLabel('供应商').fill('义乌豆子批发')
  await page.getByLabel('备注').fill('发票 0921')
  const first = page.locator('[data-line="1"]')
  await first.locator('.semi-select').click()
  await page.getByRole('option', { name: '珠光豆 5mm' }).click()
  // 选中后显示这个商品的当前库存，说明已写进表单
  await expect(first.getByText('当前库存 30 件')).toBeVisible()
  await page.getByLabel('第 1 行数量').fill('12')
  await page.getByLabel('第 1 行单价').fill('0.295')
  await expect(page.getByText('单价按元填写，最多两位小数')).toBeVisible()
  await page.getByLabel('第 1 行单价').fill('0.29')
  await expect(page.getByText('单价按元填写，最多两位小数')).toHaveCount(0)

  await page.getByRole('button', { name: '再加一种商品' }).click()
  const second = page.locator('[data-line="2"]')
  await second.locator('.semi-select').click()
  await page.getByRole('option', { name: '透明豆 3mm' }).click()
  await expect(second.getByText('还没入过库')).toBeVisible()
  await page.getByLabel('第 2 行数量').fill('5')
  await page.getByLabel('第 2 行单价').fill('8')

  const readsBefore = state.stockReads
  await page.getByRole('button', { name: '登记入库' }).click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('供应商：义乌豆子批发')).toBeVisible()
  await expect(dialog.getByText('珠光豆 5mm：入库 12 件，单价 ¥0.29')).toBeVisible()
  await expect(dialog.getByText('透明豆 3mm：入库 5 件，单价 ¥8.00')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认入库' }).click()
  await expect(page.getByText('采购入库成功')).toBeVisible()

  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/stock-receipts',
      body: {
        supplierName: '义乌豆子批发',
        note: '发票 0921',
        items: [
          { productId: P_BEADS, quantity: 12, unitCostCents: 29 },
          { productId: P_CLEAR, quantity: 5, unitCostCents: 800 },
        ],
      },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])
  // 成功后整体过期重读库存，表单清空；供应商按重读到的预填值填上刚用过的这家
  await expect.poll(() => state.stockReads).toBeGreaterThan(readsBefore)
  await expect(page.getByLabel('备注')).toHaveValue('')
  await expect(page.getByLabel('第 1 行单价')).toHaveValue('')
  await expect(page.getByLabel('供应商')).toHaveValue('义乌豆子批发')
  await page.getByRole('tab', { name: '库存' }).click()
  await expect(stockTable(page).getByRole('row', { name: /珠光豆 5mm/ })).toContainText('42')
  await expect(stockTable(page).getByRole('row', { name: /透明豆 3mm/ })).toContainText('5')
})

test('盘点：必须写原因，确认框写清当前、盘点后和变化量；有未提交输入时切标签要确认', async ({ page }) => {
  const { handler } = shop()
  const api = await mockApi(page, { account: manager, handlers: [handler] })
  await signIn(page, manager)
  await page.goto('/inventory')

  // 从库存表的「盘点」进来，商品已预选
  await stockTable(page)
    .getByRole('row', { name: /珠光豆 5mm/ })
    .getByRole('button', { name: '盘点' })
    .click()
  await expect(page).toHaveURL(/tab=adjust/)
  const preview = page.locator('.adjust-preview')
  await expect(preview).toContainText('当前库存30 件')
  // 下拉框用可见标题「商品」作读屏名；填写方式是一组有名字的单选
  await expect(page.getByRole('combobox', { name: '商品', exact: true })).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: '填写方式' })).toBeVisible()

  await page.getByLabel('实盘数量', { exact: true }).fill('27')
  await expect(preview).toContainText('盘点后27 件')
  await expect(preview).toContainText('变化量-3')

  await page.getByRole('button', { name: '提交盘点' }).click()
  await expect(page.getByText('请写明调整原因')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  // 有没提交的输入：切到流水先问，选继续填写留在原地
  await page.getByLabel('调整原因').fill('月底盘点，破损 3 包')
  await page.getByRole('tab', { name: '流水' }).click()
  await expect(page.locator('.semi-modal').getByText('放弃未保存的输入？')).toBeVisible()
  // 会丢输入：确认按钮是危险样式；两个按钮的读屏名就是按钮上的字（Semi 默认写死英文 confirm、cancel）
  await expect(page.getByRole('button', { name: '放弃并离开' })).toHaveClass(/semi-button-danger/)
  await expect(page.getByRole('button', { name: 'cancel' })).toHaveCount(0)
  await page.locator('.semi-modal button', { hasText: '继续填写' }).click()
  await expect(page).toHaveURL(/tab=adjust/)
  await expect(page.getByLabel('调整原因')).toHaveValue('月底盘点，破损 3 包')

  await page.getByRole('button', { name: '提交盘点' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认盘点调整' })
  await expect(dialog.getByText('当前库存：30 件')).toBeVisible()
  await expect(dialog.getByText('盘点后：27 件')).toBeVisible()
  await expect(dialog.getByText('变化量：-3')).toBeVisible()
  await expect(dialog.getByText('原因：月底盘点，破损 3 包')).toBeVisible()
  await dialog.locator('button', { hasText: '确认调整' }).click()
  await expect(page.getByText('库存已调整：珠光豆 5mm 现为 27 件')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/stock-adjustments',
      body: { stockItemId: S_BEADS, quantityDelta: -3, reason: '月底盘点，破损 3 包', expectedQuantity: 30 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])

  // 按变化量：调整后为负的前端先拦下
  await page.locator('.adjust-layout .semi-select').click()
  await page.getByRole('option', { name: '拼豆板 方形' }).click()
  await expect(preview).toContainText('当前库存2 件')
  await page.getByText('按变化量').click()
  await page.getByLabel('变化量', { exact: true }).fill('-5')
  await page.getByLabel('调整原因').fill('报损')
  await page.getByRole('button', { name: '提交盘点' }).click()
  await expect(page.getByText('当前只有 2 件，调整后不能为负数')).toBeVisible()
  expect(api.writes).toHaveLength(1)

  // 选「放弃并离开」才切走
  await page.getByRole('tab', { name: '流水' }).click()
  await page.locator('.semi-modal button', { hasText: '放弃并离开' }).click()
  await expect(page).toHaveURL(/tab=movements/)
})

test('盘点：确认后有人结账（409 库存已变化）时保留输入、重读库存，核对后重新确认才提交', async ({ page }) => {
  const { state, handler } = shop()
  const api = await mockApi(page, { account: manager, handlers: [handler] })
  await signIn(page, manager)
  await page.goto(`/inventory?tab=adjust&item=${S_BEADS}`)

  const preview = page.locator('.adjust-preview')
  await expect(preview).toContainText('当前库存30 件')
  await page.getByLabel('实盘数量', { exact: true }).fill('27')
  await page.getByLabel('调整原因').fill('月底盘点')

  // 页面不知道的时候，收银台卖掉了 2 包
  const beads = state.stock.find((row) => row.id === S_BEADS)!
  beads.quantity = 28
  const readsBefore = state.stockReads

  await page.getByRole('button', { name: '提交盘点' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认盘点调整' })
  await expect(dialog.getByText('当前库存：30 件')).toBeVisible()
  await expect(dialog.getByText('变化量：-3')).toBeVisible()
  await dialog.locator('button', { hasText: '确认调整' }).click()

  // 后端拒绝：提示原因，输入保留，库存重读，核对区按最新库存重算
  await expect(page.getByText('库存已变化（现为 28 件），请重新核对后再盘点')).toBeVisible()
  await expect(page.getByText('这次盘点没有提交')).toBeVisible()
  await expect.poll(() => state.stockReads).toBeGreaterThan(readsBefore)
  await expect(preview).toContainText('当前库存28 件')
  await expect(preview).toContainText('变化量-1')
  await expect(page.getByText('填写期间库存从 30 件变成了 28 件')).toBeVisible()
  await expect(page.getByLabel('实盘数量', { exact: true })).toHaveValue('27')
  await expect(page.getByLabel('调整原因')).toHaveValue('月底盘点')
  await expect(page.getByText(/库存已调整/)).toHaveCount(0)
  expect(beads.quantity).toBe(28)

  // 不会自动重提：再点提交，确认框按最新库存重新列出
  await page.getByRole('button', { name: '提交盘点' }).click()
  const again = page.locator('.semi-modal', { hasText: '确认盘点调整' })
  await expect(again.getByText('当前库存：28 件')).toBeVisible()
  await expect(again.getByText('盘点后：27 件')).toBeVisible()
  await expect(again.getByText('变化量：-1')).toBeVisible()
  await again.locator('button', { hasText: '确认调整' }).click()
  await expect(page.getByText('库存已调整：珠光豆 5mm 现为 27 件')).toBeVisible()

  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/stock-adjustments',
      body: { stockItemId: S_BEADS, quantityDelta: -3, reason: '月底盘点', expectedQuantity: 30 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
    {
      method: 'POST',
      path: '/stock-adjustments',
      body: { stockItemId: S_BEADS, quantityDelta: -1, reason: '月底盘点', expectedQuantity: 28 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])
  // 内容变了，换了新的幂等键
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
})

test('预警线：店长在库存表就地修改，校验、确认后带幂等键提交，成功后重读', async ({ page }) => {
  const { state, handler } = shop()
  const api = await mockApi(page, { account: manager, handlers: [handler] })
  await signIn(page, manager)
  await page.goto('/inventory')

  const row = stockTable(page).getByRole('row', { name: /珠光豆 5mm/ })
  await expect(row).toContainText('正常')
  await row.getByRole('button', { name: '修改珠光豆 5mm的预警线' }).click()
  const input = row.getByLabel('新预警线')
  await expect(input).toHaveValue('10')

  // 前端先拦下，不发请求
  await input.fill('-1')
  await row.getByRole('button', { name: '保存' }).click()
  await expect(row.getByText('预警线填 0 到 1000000 之间的整数')).toBeVisible()
  await input.fill('10')
  await input.press('Enter')
  await expect(row.getByText('和原来的预警线一样，不用修改')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  // 确认框里取消：什么都不发，输入还在
  await input.fill('35')
  await row.getByRole('button', { name: '保存' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '修改预警线' })
  await expect(dialog.getByText('商品：珠光豆 5mm')).toBeVisible()
  await expect(dialog.getByText('预警线：10 件 → 35 件')).toBeVisible()
  await expect(dialog.getByText('当前库存：30 件')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '取消' }).click()
  expect(api.writes).toHaveLength(0)
  await expect(input).toHaveValue('35')

  const readsBefore = state.stockReads
  await row.getByRole('button', { name: '保存' }).click()
  await page.locator('.semi-modal button', { hasText: '确认修改' }).click()
  await expect(page.getByText('珠光豆 5mm 的预警线已改为 35 件')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'PATCH',
      path: `/stock-items/${S_BEADS}`,
      body: { alertAt: 35 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])
  // 是否偏低以接口重读为准
  await expect.poll(() => state.stockReads).toBeGreaterThan(readsBefore)
  await expect(row.getByLabel('新预警线')).toHaveCount(0)
  await expect(row).toContainText('35')
  await expect(row).toContainText('库存偏低')

  // 同一时间只改一行：点另一行的「改」，前一行收起
  await row.getByRole('button', { name: '修改珠光豆 5mm的预警线' }).click()
  const board = stockTable(page).getByRole('row', { name: /拼豆板 方形/ })
  await board.getByRole('button', { name: '修改拼豆板 方形的预警线' }).click()
  await expect(row.getByLabel('新预警线')).toHaveCount(0)
  await expect(board.getByLabel('新预警线')).toHaveValue('5')
  await board.getByRole('button', { name: '取消' }).click()
  await expect(board.getByLabel('新预警线')).toHaveCount(0)
  expect(api.writes).toHaveLength(1)
})

test('流水：时间倒序，按商品、类型、日期筛选并写进网址', async ({ page }) => {
  const { state, handler } = shop()
  await mockApi(page, { account: clerk, handlers: [handler] })
  await signIn(page, clerk)
  await page.goto('/inventory?tab=movements')

  await expect(dataRows(page)).toHaveCount(4)
  await expect(dataRows(page).first()).toContainText('2026-10-04 14:00')
  await expect(dataRows(page).first()).toContainText('销售出库')
  await expect(dataRows(page).first()).toContainText('订单 order-00')
  // 按门店时区显示：UTC 10-03 16:30 是北京时间 10-04 00:30
  await expect(dataRows(page).nth(1)).toContainText('2026-10-04 00:30')
  await expect(dataRows(page).nth(1)).toContainText('月底盘点，受潮 2 包')
  // 操作人由后端换算成昵称；早期流水没有记录，显示「—」
  await expect(dataRows(page).nth(1).locator('td').last()).toHaveText('阿贝')
  await expect(dataRows(page).last().locator('td').last()).toHaveText('—')
  await expect(dataRows(page).last()).toContainText('供应商 义乌豆子批发')
  await expect(dataRows(page).last()).toContainText('+33')

  await page.locator('.toolbar .semi-select').first().click()
  await page.getByRole('option', { name: '珠光豆 5mm' }).click()
  await expect(page).toHaveURL(new RegExp(`item=${S_BEADS}`))
  await expect.poll(() => state.movementSearches.at(-1)?.get('stockItemId')).toBe(S_BEADS)
  await expect(dataRows(page)).toHaveCount(3)
  await expect(stockTable(page).getByText('拼豆板 方形')).toHaveCount(0)

  await page.locator('.toolbar .semi-select').nth(1).click()
  await page.getByRole('option', { name: '盘点调整' }).click()
  await expect(page).toHaveURL(/kind=adjustment/)
  await expect(dataRows(page)).toHaveCount(1)
  await expect(dataRows(page).first()).toContainText('-2')

  // 日期按门店日期交给后端筛
  await page.getByPlaceholder('开始日期').fill('2026-10-03')
  await page.getByPlaceholder('结束日期').fill('2026-10-04')
  await page.getByPlaceholder('结束日期').press('Enter')
  await expect(page).toHaveURL(/from=2026-10-03/)
  await expect(page).toHaveURL(/to=2026-10-04/)
  await expect
    .poll(() => Object.fromEntries(state.movementSearches.at(-1) ?? []))
    .toEqual({
      page: '1',
      pageSize: '50',
      stockItemId: S_BEADS,
      kind: 'adjustment',
      from: '2026-10-03',
      to: '2026-10-04',
    })

  // 从库存表的「流水」进来就是按那个商品筛好的
  await page.goto('/inventory')
  await stockTable(page)
    .getByRole('row', { name: /拼豆板 方形/ })
    .getByRole('button', { name: '流水' })
    .click()
  await expect(page).toHaveURL(new RegExp(`tab=movements.*item=${S_BOARD}|item=${S_BOARD}.*tab=movements`))
  await expect(dataRows(page)).toHaveCount(1)
  await expect(dataRows(page).first()).toContainText('-3')
})

test('商品资料：新增与修改都校验，提交带幂等键', async ({ page }) => {
  const { handler } = shop()
  const api = await mockApi(page, { account: manager, handlers: [handler] })
  await signIn(page, manager)
  await page.goto('/inventory?tab=catalog')

  await expect(stockTable(page).getByRole('row', { name: /拼豆板 方形/ })).toContainText('¥8.00')
  await page.getByRole('button', { name: '新增商品' }).click()
  const modal = page.locator('.semi-modal', { hasText: '新增商品' })
  await modal.locator('button', { hasText: '保存' }).click()
  await expect(modal.getByText('请填写商品名称')).toBeVisible()
  await expect(modal.getByText('请填写参考售价')).toBeVisible()
  // 有个未命名的历史商品，空名称不能被当成重名
  await expect(modal.getByText('已有同名商品')).toHaveCount(0)

  await modal.getByLabel('商品名称').fill(' 珠光豆 5MM ')
  await modal.getByLabel('参考售价').fill('12.345')
  await expect(modal.getByText('已有同名商品')).toBeVisible()
  await expect(modal.getByText('售价按元填写，最多两位小数')).toBeVisible()
  await modal.locator('button', { hasText: '保存' }).click()
  expect(api.writes).toHaveLength(0)

  await modal.getByLabel('商品名称').fill('夜光豆 5mm')
  await modal.getByLabel('参考售价').fill('12.3')
  await modal.locator('button', { hasText: '保存' }).click()
  await expect(page.getByText('商品已新增')).toBeVisible()
  await expect(stockTable(page).getByRole('row', { name: /夜光豆 5mm/ })).toContainText('¥12.30')
  await expect(stockTable(page).getByRole('row', { name: /夜光豆 5mm/ })).toContainText('未入库')

  await stockTable(page)
    .getByRole('row', { name: /拼豆板 方形/ })
    .getByRole('button', { name: '编辑' })
    .click()
  const editor = page.locator('.semi-modal', { hasText: '修改商品资料' })
  await expect(editor.getByLabel('参考售价')).toHaveValue('8.00')
  await editor.getByLabel('参考售价').fill('9.5')
  await editor.locator('button', { hasText: '保存' }).click()
  await expect(page.getByText('商品资料已保存')).toBeVisible()
  await expect(stockTable(page).getByRole('row', { name: /拼豆板 方形/ })).toContainText('¥9.50')

  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/catalog-items',
      body: { name: '夜光豆 5mm', unitPriceCents: 1230 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
    {
      method: 'PATCH',
      path: `/catalog-items/${P_BOARD}`,
      body: { name: '拼豆板 方形', unitPriceCents: 950 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])

  // 填了一半点取消：先确认
  await page.getByRole('button', { name: '新增商品' }).click()
  await page.locator('.semi-modal', { hasText: '新增商品' }).getByLabel('商品名称').fill('草稿')
  await page.locator('.semi-modal', { hasText: '新增商品' }).locator('button', { hasText: '取消' }).click()
  await page.locator('.semi-modal button', { hasText: '放弃并离开' }).click()
  await expect(page.locator('.semi-modal', { hasText: '新增商品' })).toHaveCount(0)
  expect(api.writes).toHaveLength(2)
})

test('商品资料：登记条码；被别的商品占用时条码格上显示后端说的是哪件，换一个再存；表格显示并能按条码搜', async ({
  page,
}) => {
  const { handler } = shop()
  const api = await mockApi(page, { account: manager, handlers: [handler] })
  await signIn(page, manager)
  await page.goto('/inventory?tab=catalog')

  await expect(stockTable(page).getByRole('row', { name: /珠光豆 5mm/ })).toContainText('6901234567892')
  await expect(stockTable(page).getByRole('row', { name: /拼豆板 方形/ })).toContainText('—')
  await stockTable(page)
    .getByRole('row', { name: /拼豆板 方形/ })
    .getByRole('button', { name: '编辑' })
    .click()
  const editor = page.locator('.semi-modal', { hasText: '修改商品资料' })
  const barcode = editor.getByLabel('条码')
  await expect(barcode).toHaveValue('')

  // 格式不对：前端先拦下，不发请求
  await barcode.fill('690 123')
  await editor.locator('button', { hasText: '保存' }).click()
  await expect(editor.getByText('条码只能是 1–64 位英文字母、数字或符号，不能有空格或中文')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  // 已登记在别的商品上：后端 409，原因挂在条码这一格上，不另弹横幅
  await barcode.fill('6901234567892')
  await editor.locator('button', { hasText: '保存' }).click()
  const taken = '条码 6901234567892 已经登记在「珠光豆 5mm」上，一个条码只能对应一件商品'
  await expect(editor.getByText(taken)).toBeVisible()
  await expect(barcode).toHaveAttribute('aria-invalid', 'true')
  await expect(barcode).toHaveAccessibleDescription(new RegExp(taken))
  await expect(editor.locator('.semi-banner')).toHaveCount(0)

  // 改了条码，上次的原因收起；扫码枪带进来的首尾空白去掉
  await barcode.fill(' 6901234567809 ')
  await expect(editor.getByText(taken)).toHaveCount(0)
  await editor.locator('button', { hasText: '保存' }).click()
  await expect(page.getByText('商品资料已保存')).toBeVisible()
  await expect(stockTable(page).getByRole('row', { name: /拼豆板 方形/ })).toContainText('6901234567809')

  // 只改售价：条码没动就不带，请求和以前一样
  await stockTable(page)
    .getByRole('row', { name: /珠光豆 5mm/ })
    .getByRole('button', { name: '编辑' })
    .click()
  const beads = page.locator('.semi-modal', { hasText: '修改商品资料' })
  await expect(beads.getByLabel('条码')).toHaveValue('6901234567892')
  await beads.getByLabel('参考售价').fill('13')
  await beads.locator('button', { hasText: '保存' }).click()
  await expect(page.locator('.semi-modal', { hasText: '修改商品资料' })).toHaveCount(0)

  expect(api.writes).toEqual([
    {
      method: 'PATCH',
      path: `/catalog-items/${P_BOARD}`,
      body: { name: '拼豆板 方形', unitPriceCents: 800, barcode: '6901234567892' },
      idempotencyKey: expect.stringMatching(/.+/),
    },
    {
      method: 'PATCH',
      path: `/catalog-items/${P_BOARD}`,
      body: { name: '拼豆板 方形', unitPriceCents: 800, barcode: '6901234567809' },
      idempotencyKey: expect.stringMatching(/.+/),
    },
    {
      method: 'PATCH',
      path: `/catalog-items/${P_BEADS}`,
      body: { name: '珠光豆 5mm', unitPriceCents: 1300 },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])

  // 搜索框也认条码（整串相同才算）
  await page.getByLabel('搜商品名称或条码').fill('6901234567809')
  await expect(dataRows(page)).toHaveCount(1)
  await expect(stockTable(page).getByText('拼豆板 方形')).toBeVisible()
})

test('采购入库：扫码枪对着商品搜索框扫条码回车即选中；供应商、进价用后端给的上次值预填，不覆盖已填的', async ({
  page,
}) => {
  const { state, handler } = shop()
  state.prefill = {
    supplierName: '义乌豆子批发',
    lastUnitCosts: [
      { productId: P_BEADS, unitCostCents: 29 },
      { productId: P_BOARD, unitCostCents: 500 },
    ],
  }
  const api = await mockApi(page, { account: clerk, handlers: [handler] })
  await signIn(page, clerk)
  await page.goto('/inventory?tab=purchase')

  // 供应商预填最近一次的
  await expect(page.getByLabel('供应商')).toHaveValue('义乌豆子批发')

  // 第 1 行：点开商品框，扫码枪键入条码再回车，直接选中那件商品，进价填上次的
  const first = page.locator('[data-line="1"]')
  await first.locator('.semi-select').click()
  await page.keyboard.type('6901234567892')
  await page.keyboard.press('Enter')
  await expect(first.getByText('当前库存 30 件 · 上次进价 ¥0.29')).toBeVisible()
  await expect(page.getByLabel('第 1 行单价')).toHaveValue('0.29')

  // 第 2 行：按名称搜，没入过库的商品不预填进价；员工自己填的价换商品后也不动
  await page.getByRole('button', { name: '再加一种商品' }).click()
  const second = page.locator('[data-line="2"]')
  await second.locator('.semi-select').click()
  await page.keyboard.type('透明')
  await expect(page.locator('.semi-select-option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(second.getByText('还没入过库')).toBeVisible()
  await expect(page.getByLabel('第 2 行单价')).toHaveValue('')
  await page.getByLabel('第 2 行单价').fill('8')
  await second.locator('.semi-select').click()
  await page.getByRole('option', { name: '拼豆板 方形' }).click()
  await expect(second.getByText('当前库存 2 件 · 上次进价 ¥5.00')).toBeVisible()
  await expect(page.getByLabel('第 2 行单价')).toHaveValue('8')

  // 换个供应商提交
  await page.getByLabel('供应商').fill('本地文具店')
  await page.getByRole('button', { name: '登记入库' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入库' }).click()
  await expect(page.getByText('采购入库成功')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/stock-receipts',
      body: {
        supplierName: '本地文具店',
        items: [
          { productId: P_BEADS, quantity: 1, unitCostCents: 29 },
          { productId: P_BOARD, quantity: 1, unitCostCents: 800 },
        ],
      },
      idempotencyKey: expect.stringMatching(/.+/),
    },
  ])

  // 清空后按入库后重读的预填：供应商是刚用过的这家，不是页面打开时读到的旧值
  await expect(page.getByLabel('供应商')).toHaveValue('本地文具店')
  await expect(page.getByLabel('第 1 行单价')).toHaveValue('')
  // 再扫一次：进价是刚入库的价
  await page.locator('[data-line="1"] .semi-select').click()
  await page.keyboard.type('6901234567892')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('第 1 行单价')).toHaveValue('0.29')
  // 员工清空预填的供应商，不会被再填回去
  await page.getByLabel('供应商').fill('')
  await page.getByLabel('第 1 行数量').fill('2')
  await expect(page.getByLabel('供应商')).toHaveValue('')
})

test('店员看不到盘点和商品资料的修改入口，手输网址也进不去盘点', async ({ page }) => {
  const { handler } = shop()
  await mockApi(page, { account: clerk, handlers: [handler] })
  await signIn(page, clerk)
  await page.goto('/inventory')

  await expect(page.getByRole('tab', { name: '采购入库' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '流水' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '商品资料' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '盘点' })).toHaveCount(0)
  const row = stockTable(page).getByRole('row', { name: /珠光豆 5mm/ })
  await expect(row.getByRole('button', { name: '入库' })).toBeVisible()
  await expect(row.getByRole('button', { name: '盘点' })).toHaveCount(0)
  // 预警线只显示，没有修改入口
  await expect(row).toContainText('10')
  await expect(row.getByRole('button', { name: /预警线/ })).toHaveCount(0)

  await page.goto('/inventory?tab=adjust')
  await expect(page.getByRole('tab', { name: '库存' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '提交盘点' })).toHaveCount(0)
  await expect(dataRows(page)).toHaveCount(3)

  await page.getByRole('tab', { name: '商品资料' }).click()
  await expect(stockTable(page).getByText('珠光豆 5mm')).toBeVisible()
  await expect(page.getByRole('button', { name: '新增商品' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '编辑' })).toHaveCount(0)
})

test('采购入库：手机「扫码给电脑」转来的条码加进明细，同一件再扫数量 +1；没登记的条码只提示；会员码交给全站提示', async ({
  page,
}) => {
  const { state, handler } = shop()
  state.prefill = { supplierName: '义乌豆子批发', lastUnitCosts: [{ productId: P_BEADS, unitCostCents: 29 }] }
  state.catalog[1].barcode = 'BOARD-01'
  const api = await mockApi(page, { account: clerk, handlers: [handler] })
  await signIn(page, clerk)
  await page.goto('/inventory?tab=purchase')
  await expect(page.getByLabel('供应商')).toHaveValue('义乌豆子批发')
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  const relay = (code: string) =>
    api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'scan.relayed', code }))

  // 第一件填进空着的第 1 行，进价按上次的预填
  relay('6901234567892')
  await expect(page.getByText('已加入「珠光豆 5mm」（第 1 行）')).toBeVisible()
  const first = page.locator('[data-line="1"]')
  await expect(first.getByText('当前库存 30 件 · 上次进价 ¥0.29')).toBeVisible()
  await expect(page.getByLabel('第 1 行单价')).toHaveValue('0.29')
  // 同一件再扫：那一行数量 +1，不另起一行
  relay('6901234567892')
  await expect(page.getByLabel('第 1 行数量')).toHaveValue('2')
  await expect(page.locator('[data-line="2"]')).toHaveCount(0)
  // 另一件加在末尾；没入过库的进价留空
  relay('BOARD-01')
  await expect(page.locator('[data-line="2"]').getByText('当前库存 2 件')).toBeVisible()
  await expect(page.getByLabel('第 2 行单价')).toHaveValue('')
  // 没登记的条码：只提示，不加行
  relay('0000000000000')
  await expect(page.getByText('条码 0000000000000 还没登记到商品')).toBeVisible()
  await expect(page.locator('[data-line="3"]')).toHaveCount(0)
  // 会员码在这一页用不上：右下角提示，明细不动
  relay('91234567890123456789')
  await expect(page.locator('.semi-notification-notice', { hasText: '手机扫到' })).toContainText(
    '会员码 91234567890123456789',
  )
  await expect(page.locator('[data-line="3"]')).toHaveCount(0)

  // 补上进价后照常提交，数量是扫出来的
  await page.getByLabel('第 2 行单价').fill('5')
  await page.getByRole('button', { name: '登记入库' }).click()
  await page.locator('.semi-modal button', { hasText: '确认入库' }).click()
  await expect(page.getByText('采购入库成功')).toBeVisible()
  expect(api.writes.at(-1)?.body).toEqual({
    supplierName: '义乌豆子批发',
    items: [
      { productId: P_BEADS, quantity: 2, unitCostCents: 29 },
      { productId: P_BOARD, quantity: 1, unitCostCents: 500 },
    ],
  })
})
