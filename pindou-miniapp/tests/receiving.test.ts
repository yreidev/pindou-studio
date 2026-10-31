import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes, settle, type Node } from './helpers/tree'

// 手机上的「收货入库」（2026-10-06 业主改定）：扫条码或按名称搜加商品，同一件商品再扫一次数量 +1；
// 扫到没登记的条码，店长、老板可以当场绑定到已有商品，店员只能请他们来绑；进价预填上次的（后端给），
// 没有记录必须填；合计只用整数分；一张入库单一次提交，带幂等键。

const white = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '拼豆 5mm 白',
  unitPriceCents: 1200,
  barcode: '6901234567892',
}
const black = { id: '22222222-2222-4222-8222-222222222222', name: '拼豆 5mm 黑', unitPriceCents: 1200 }
const prefill = { supplierName: '义乌拼豆批发', lastUnitCosts: [{ productId: white.id, unitCostCents: 85 }] }

type Sent = { url: string; method: string; data: any; header: Record<string, string> }

/** 装载 services/receiving.ts；请求经真的 services/staff.ts 发到这里的 Taro.request 替身。 */
async function service(respond: (sent: Sent) => { statusCode: number; data?: unknown } = () => ({ statusCode: 200 })) {
  const sent: Sent[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'token-1' }),
    request: async (options: Sent) => {
      sent.push(options)
      return respond(options)
    },
  }
  const receiving = await load('services/receiving.ts', { '@tarojs/taro': { default: taro } })
  return { ...receiving, sent }
}

test('条码规则与后端一致：去首尾空白，1–64 个可打印 ASCII，不含空格、中文', async () => {
  const { barcodeOf } = await service()
  assert.equal(barcodeOf(' 6901234567892\r\n'), '6901234567892')
  assert.equal(barcodeOf('Ab-12/x.~!'), 'Ab-12/x.~!')
  assert.equal(barcodeOf('7'.repeat(64)), '7'.repeat(64))
  assert.equal(barcodeOf('  '), '')
  for (const bad of ['690 123', '条码123', '６９０１', '7'.repeat(65), 'https://example.com/a b'])
    assert.equal(barcodeOf(bad), null, bad)
})

test('扫码：找到商品、没登记（按角色给不给绑定）、取消、扫不出、扫到的不是条码、查询失败', async () => {
  const { scanProduct, unboundBarcodeMessage } = await service()
  const scan = (result: string) => async () => ({ result })
  const lookups: string[] = []
  const find =
    (items: any[] = []) =>
    async (code: string) => {
      lookups.push(code)
      return items
    }

  // 找到：按规范后的条码查（扫码枪、相机带回的空白去掉）
  const found = await scanProduct(['clerk'], scan(' 6901234567892\n'), find([white]))
  assert.deepEqual(found, { kind: 'found', item: white })
  assert.deepEqual(lookups, ['6901234567892'])

  // 没登记：店员不能绑（请店长或老板），店长、老板可以
  assert.deepEqual(await scanProduct(['clerk'], scan('6900000000001'), find()), {
    kind: 'unknown',
    barcode: '6900000000001',
    canBind: false,
  })
  for (const role of ['manager', 'owner'])
    assert.deepEqual(await scanProduct([role], scan('6900000000001'), find()), {
      kind: 'unknown',
      barcode: '6900000000001',
      canBind: true,
    })
  assert.match(unboundBarcodeMessage, /请店长或老板绑定/)

  // 取消扫码不提示；没扫出来、扫到网址二维码、查询失败都说清楚，且不查商品
  lookups.length = 0
  const cancelled = await scanProduct(['owner'], async () => Promise.reject({ errMsg: 'scanCode:fail cancel' }), find())
  assert.deepEqual(cancelled, { kind: 'cancelled' })
  const failed = await scanProduct(['owner'], async () => Promise.reject({ errMsg: 'scanCode:fail' }), find())
  assert.equal(failed.kind, 'error')
  const qr = await scanProduct(['owner'], scan(`https://example.com/${'x'.repeat(80)}`), find())
  assert.equal(qr.kind, 'error')
  assert.match((qr as any).message, /不是商品条码/)
  assert.deepEqual(lookups, [])
  const offline = await scanProduct(['owner'], scan('6901234567892'), async () =>
    Promise.reject(new Error('网络连接失败，请稍后重试')),
  )
  assert.deepEqual(offline, { kind: 'error', message: '网络连接失败，请稍后重试' })
})

test('加商品：新行数量 1、进价预填上次的；没有记录留空；同一件商品再加一次那一行数量 +1', async () => {
  const { addProduct, lastUnitCost } = await service()
  assert.equal(lastUnitCost(prefill, white.id), 85)
  assert.equal(lastUnitCost(prefill, black.id), undefined)
  assert.equal(lastUnitCost(null, white.id), undefined)

  let step = addProduct([], white.id, prefill)
  assert.equal(step.merged, false)
  assert.deepEqual(step.rows, [{ productId: white.id, quantity: '1', costYuan: '0.85' }])
  step = addProduct(step.rows, black.id, prefill)
  assert.deepEqual(step.rows[1], { productId: black.id, quantity: '1', costYuan: '' })
  // 同一条码再扫一次（或又按名称加了一次）：不另起一行
  step = addProduct(step.rows, white.id, prefill)
  assert.equal(step.merged, true)
  assert.deepEqual(
    step.rows.map((row) => [row.productId, row.quantity]),
    [
      [white.id, '2'],
      [black.id, '1'],
    ],
  )
  // 员工改过的进价不被预填覆盖；数量框里填坏了再扫一次从 1 开始
  const edited = [{ productId: white.id, quantity: 'abc', costYuan: '0.90' }]
  assert.deepEqual(addProduct(edited, white.id, prefill).rows, [
    { productId: white.id, quantity: '1', costYuan: '0.90' },
  ])
})

test('每行校验：数量为 1 起的整数；进价必填、不小于 0、最多两位小数、不超过上限', async () => {
  const { rowErrors } = await service()
  const row = (quantity: string, costYuan: string) => rowErrors({ productId: white.id, quantity, costYuan })
  assert.deepEqual(row('3', '0.85'), {})
  assert.deepEqual(row('1', '0'), {}, '赠品进价可以是 0')
  assert.match(row('1', '').cost!, /请填写进价/)
  assert.match(row('1', '  ').cost!, /请填写进价/)
  for (const bad of ['-1', '1.234', 'abc', '1e2']) assert.match(row('1', bad).cost!, /不小于 0 的金额/, bad)
  assert.match(row('1', '1000000.01').cost!, /不能超过/)
  for (const bad of ['0', '-1', '1.5', '', '1000001']) assert.match(row(bad, '1').quantity!, /数量须为/, bad)
})

test('合计只用整数分：数量 × 进价逐行相乘再相加；填错的行不计入并标出', async () => {
  const { receiptTotals } = await service()
  // 0.10 × 3 用浮点会得 0.30000000000000004；19.99 × 7 = 139.93
  const rows = [
    { productId: white.id, quantity: '3', costYuan: '0.10' },
    { productId: black.id, quantity: '7', costYuan: '19.99' },
  ]
  assert.deepEqual(receiptTotals(rows), { quantity: 10, cents: 30 + 13993, complete: true })
  assert.deepEqual(receiptTotals([...rows, { productId: 'x', quantity: '2', costYuan: '' }]), {
    quantity: 10,
    cents: 14023,
    complete: false,
  })
  assert.deepEqual(receiptTotals([]), { quantity: 0, cents: 0, complete: true })
})

test('请求体：供应商去首尾空白且必填，备注选填，每行换成整数件数与整数分', async () => {
  const { receiptBody } = await service()
  const rows = [
    { productId: white.id, quantity: '2', costYuan: '0.85' },
    { productId: black.id, quantity: '10', costYuan: '12.5' },
  ]
  assert.deepEqual(receiptBody(' 义乌拼豆批发 ', '  ', rows), {
    supplierName: '义乌拼豆批发',
    items: [
      { productId: white.id, quantity: 2, unitCostCents: 85 },
      { productId: black.id, quantity: 10, unitCostCents: 1250 },
    ],
  })
  assert.equal(receiptBody('甲', ' 到货单 A-17 ', rows).note, '到货单 A-17')
  assert.throws(() => receiptBody('  ', '', rows), /请填写供应商/)
  assert.throws(() => receiptBody('甲'.repeat(101), '', rows), /最多 100 个字/)
  assert.throws(() => receiptBody('甲', '注'.repeat(201), rows), /最多 200 个字/)
  assert.throws(() => receiptBody('甲', '', []), /添加要入库的商品/)
  assert.throws(
    () => receiptBody('甲', '', [rows[0], { productId: black.id, quantity: '1', costYuan: '' }], [white, black]),
    /第 2 行（拼豆 5mm 黑）：请填写进价/,
  )
})

test('按名称（包含、不分大小写）或条码开头找商品；没输关键字不列', async () => {
  const { searchCatalog } = await service()
  const catalog = [
    white,
    black,
    { id: '33333333-3333-4333-8333-333333333333', name: 'Pegboard 方板', unitPriceCents: 0 },
  ]
  assert.deepEqual(searchCatalog(catalog, ''), [])
  assert.deepEqual(
    searchCatalog(catalog, '5mm').map((item) => item.name),
    ['拼豆 5mm 白', '拼豆 5mm 黑'],
  )
  assert.deepEqual(
    searchCatalog(catalog, 'pegBOARD').map((item) => item.name),
    ['Pegboard 方板'],
  )
  assert.deepEqual(
    searchCatalog(catalog, '690123').map((item) => item.name),
    ['拼豆 5mm 白'],
  )
})

test('接口：按条码查是只读的 GET；绑条码只带 barcode；入库单带幂等键，结果未知时原样重发、改了内容先确认上一张', async () => {
  let fail = true
  const s = await service((sent) => {
    if (sent.method === 'POST' && fail) throw new Error('timeout')
    return { statusCode: sent.method === 'POST' ? 201 : 200, data: sent.method === 'GET' ? [] : {} }
  })
  await s.receiving.findByBarcode('Ab/12 x')
  assert.equal(s.sent[0].method, 'GET')
  assert.match(s.sent[0].url, /\/catalog-items\?barcode=Ab%2F12%20x$/)
  assert.equal(s.sent[0].header['Idempotency-Key'], undefined)

  await s.receiving.bindBarcode(black.id, '6900000000001')
  assert.equal(s.sent[1].method, 'PATCH')
  assert.match(s.sent[1].url, new RegExp(`/catalog-items/${black.id}$`))
  assert.deepEqual(s.sent[1].data, { barcode: '6900000000001' })
  assert.ok(s.sent[1].header['Idempotency-Key'])

  const body = { supplierName: '义乌拼豆批发', items: [{ productId: white.id, quantity: 2, unitCostCents: 85 }] }
  await assert.rejects(s.receiving.submit(body), /网络连接失败/)
  const first = s.sent[2]
  assert.equal(first.method, 'POST')
  assert.match(first.url, /\/stock-receipts$/)
  assert.deepEqual(first.data, body)
  // 再点一次同一张单：同一个幂等键，后端重放上次的结果，不会入两次库
  fail = false
  await s.receiving.submit(body)
  assert.equal(s.sent[3].header['Idempotency-Key'], first.header['Idempotency-Key'])

  // 又一张单结果未知，员工改了数量再点：先把上一张原样重发，它其实入了库就提示「上次已生效」，不提交这一张
  fail = true
  await assert.rejects(s.receiving.submit(body), /网络连接失败/)
  const unknownKey = s.sent.at(-1)!.header['Idempotency-Key']
  fail = false
  const changed = { ...body, items: [{ ...body.items[0], quantity: 3 }] }
  await assert.rejects(s.receiving.submit(changed), (error: any) => error.code === 'previous_applied')
  assert.deepEqual(s.sent.at(-1)!.data, body)
  assert.equal(s.sent.at(-1)!.header['Idempotency-Key'], unknownKey)
})

// ---------- 页面 ----------

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const effects: (() => void)[] = []
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
    useEffect(fn: () => void, deps?: unknown[]) {
      const i = cursor++
      const previous = slots[i]
      const changed = !previous || !deps || deps.some((dep, k) => dep !== previous[k])
      slots[i] = deps
      if (changed) effects.push(fn)
    },
  }
  return {
    api,
    render(fn: () => unknown) {
      cursor = 0
      effects.length = 0
      const tree = fn()
      effects.splice(0).forEach((effect) => effect())
      return tree
    },
  }
}

async function page(role: 'clerk' | 'manager' | 'owner', scanned: string[]) {
  const h = hooks()
  const calls: any[] = []
  const sent: Sent[] = []
  const catalog = [white, black]
  const taro = {
    getStorageSync: () => ({ accessToken: 'token-1' }),
    scanCode: async () => ({ result: scanned.shift() }),
    showToast: (options: any) => calls.push(['toast', options.title]),
    showModal: async () => ({ confirm: true }),
    request: async (options: Sent) => {
      sent.push(options)
      if (options.method === 'GET') {
        const code = decodeURIComponent(options.url.split('barcode=')[1] || '')
        return { statusCode: 200, data: catalog.filter((item: any) => item.barcode === code) }
      }
      if (options.method === 'PATCH') {
        const item = catalog.find((entry) => options.url.endsWith(entry.id))!
        return { statusCode: 200, data: { ...item, ...options.data } }
      }
      return { statusCode: 201, data: { id: 'receipt-1', supplierName: options.data.supplierName, items: [] } }
    },
  }
  const { default: Receiving } = await load('pages/staff/receiving/index.tsx', {
    react: h.api,
    '@tarojs/taro': { default: taro },
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': {
      StaffScreen: 'Screen',
      ActionButton: 'ActionButton',
      Field: 'Field',
      Stepper: 'Stepper',
      useStaffEvents: () => ({ connection: 'connected', refetchInterval: false }),
      useStaffQuery: (key: unknown[]) => {
        assert.equal(key[0], 'stock-receipts')
        return {
          data: [catalog, [{ id: 's1', productId: white.id, quantity: 3, alertAt: 0, lowStock: false }], prefill],
          loading: false,
          error: null,
          refresh() {},
        }
      },
    },
    '../../../hooks/customer': { useCustomer: () => ({ account: { nickname: '员工', roles: [role] } }) },
    '../../../hooks/leave-guard': { useLeaveGuard: (dirty: boolean) => calls.push(['dirty', dirty]) },
    '../../../hooks/query': { useRefreshAll: () => () => calls.push(['refresh']) },
    './index.scss': {},
  })
  let tree: unknown = h.render(Receiving)
  const render = () => (tree = h.render(Receiving))
  render()
  const find = (predicate: (n: Node) => boolean, what: string) => {
    const hit = nodes(tree, predicate)[0]
    assert.ok(hit, `页面上应当有${what}：${label(tree)}`)
    return hit
  }
  const field = (name: string) => find((n) => n.type === 'Field' && n.props.label === name, `「${name}」输入框`)
  const action = (name: string) => find((n) => n.type === 'ActionButton' && label(n) === name, `「${name}」按钮`)
  const button = (aria: string) => find((n) => n.type === 'Button' && n.props.ariaLabel === aria, `「${aria}」`)
  const click = async (node: Node) => {
    node.props.onClick()
    for (let i = 0; i < 5; i++) await settle()
    render()
  }
  return { render, tree: () => tree, field, action, button, click, calls, sent }
}

test('页面（店员）：扫到已登记的条码加一行，再扫一次数量 +1；没登记的条码只提示请店长或老板绑定', async () => {
  const p = await page('clerk', ['6901234567892', '6901234567892', '6900000000001'])
  // 供应商预填最近一次入库的
  assert.equal(p.field('供应商').props.value, '义乌拼豆批发')
  await p.click(p.action('扫商品条码'))
  assert.equal(p.field('拼豆 5mm 白 · 进价（元）').props.value, '0.85')
  assert.match(label(p.tree()), /当前库存 3 件（参考）/)
  await p.click(p.action('扫商品条码'))
  const quantity = nodes(p.tree(), (n) => n.type === 'Stepper')
  assert.equal(quantity.length, 1, '同一条码再扫不另起一行')
  assert.equal(quantity[0].props.value, '2')
  assert.match(label(p.tree()), /合计 2 件/)
  assert.match(label(p.tree()), /¥1\.70/)

  await p.click(p.action('扫商品条码'))
  assert.match(label(p.tree()), /条码 6900000000001：这个条码还没登记到商品，请店长或老板绑定/)
  assert.equal(
    nodes(p.tree(), (n) => n.type === 'Field' && n.props.label === '搜索要绑定的商品').length,
    0,
    '店员不能绑定条码',
  )
  assert.equal(
    p.sent.some((sent) => sent.method === 'PATCH'),
    false,
  )
})

test('页面（店长、老板）：没登记的条码当场绑到已有商品再加进来；没有上次进价的必须填；确认后一张单提交、清空', async () => {
  for (const role of ['manager', 'owner'] as const) {
    const p = await page(role, ['6900000000001'])
    await p.click(p.action('扫商品条码'))
    assert.match(label(p.tree()), /条码 6900000000001：还没登记到商品。可以绑定到一件已有商品/)
    p.field('搜索要绑定的商品').props.onChange('黑')
    p.render()
    await p.click(p.button('把条码 6900000000001 绑定到拼豆 5mm 黑'))
    const patch = p.sent.find((sent) => sent.method === 'PATCH')!
    assert.match(patch.url, new RegExp(`/catalog-items/${black.id}$`))
    assert.deepEqual(patch.data, { barcode: '6900000000001' })
    assert.match(label(p.tree()), /条码 6900000000001 已登记到「拼豆 5mm 黑」/)
    // 黑色没有入库记录：进价留空，必须填
    const cost = p.field('拼豆 5mm 黑 · 进价（元）')
    assert.equal(cost.props.value, '')
    assert.match(cost.props.help, /第一次进货，要填进价/)

    // 按名称搜白色加进来，进价预填上次的
    p.field('按名称搜索').props.onChange('白')
    p.render()
    await p.click(p.button('加入拼豆 5mm 白，当前库存 3 件'))
    assert.equal(p.field('拼豆 5mm 白 · 进价（元）').props.value, '0.85')

    // 没填进价就提交：不发请求，标出哪一行
    await p.click(p.action('确认入库'))
    assert.equal(
      p.sent.some((sent) => sent.method === 'POST'),
      false,
    )
    assert.match(label(p.tree()), /第 1 行（拼豆 5mm 黑）：请填写进价/)
    assert.match(p.field('拼豆 5mm 黑 · 进价（元）').props.error, /请填写进价/)

    p.field('拼豆 5mm 黑 · 进价（元）').props.onChange('12.5')
    p.field('备注（选填）').props.onChange('到货单 A-17')
    p.render()
    assert.match(label(p.tree()), /合计 2 件/)
    assert.match(label(p.tree()), /¥13\.35/)
    await p.click(p.action('确认入库'))
    const post = p.sent.find((sent) => sent.method === 'POST')!
    assert.match(post.url, /\/stock-receipts$/)
    assert.ok(post.header['Idempotency-Key'])
    assert.deepEqual(post.data, {
      supplierName: '义乌拼豆批发',
      note: '到货单 A-17',
      items: [
        { productId: black.id, quantity: 1, unitCostCents: 1250 },
        { productId: white.id, quantity: 1, unitCostCents: 85 },
      ],
    })
    // 成功：提示、清空明细、整页重读（库存以接口为准）
    assert.ok(p.calls.some((call) => call[0] === 'toast' && call[1] === '已入库'))
    assert.ok(p.calls.some((call) => call[0] === 'refresh'))
    assert.equal(nodes(p.tree(), (n) => n.type === 'Stepper').length, 0)
    assert.equal(p.field('备注（选填）').props.value, '')
    assert.equal(p.field('供应商').props.value, '义乌拼豆批发')
  }
})
