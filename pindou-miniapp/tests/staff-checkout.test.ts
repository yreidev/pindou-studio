import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'

// 结账页：明细没改时一次点击结清；改过明细时先「保存明细」，页面换成服务端算的金额，再点「确认收款 ¥X」。
// 按钮上的数必须是要登记的数——曾经一次点击走完「保存 → 收款」，按钮上却是前端本地加的合计，
// 不含折扣、会员价、积分和余额，店员会多收或少收。
//
// 会员单在同一屏结清（不再跳去「会员与计时 › 结账」）：后端规定「订单带账户 + 门店有已发布规则 → 普通收款
// 一律 409」，会员单要走带 quoteVersion 的 checkout。

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const effects: any[] = []
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
    // useCallback 也得按依赖记住上一次的函数。直接返回 fn 的话它每次渲染都是新身份，
    // 依赖它的 effect 就跟着每次重跑 —— 页面会一遍遍重新载入订单。
    useCallback(fn: any, deps: any[]) {
      const i = cursor++
      const previous = slots[i]
      const changed = !previous || deps.length !== previous.deps.length || deps.some((d, k) => d !== previous.deps[k])
      if (changed) slots[i] = { fn, deps }
      return slots[i].fn
    },
    // ★ 必须比对依赖数组。不比的话每次渲染都重跑所有 effect，页面的「载入订单」
    //   会一遍遍重来，把刚算好的报价清掉，测出来的请求次数是假的。
    useEffect(fn: any, deps?: any[]) {
      const i = cursor++
      const previous = slots[i]
      const changed = !previous || !deps || deps.length !== previous.length || deps.some((d, k) => d !== previous[k])
      slots[i] = deps
      if (changed) effects.push(fn)
    },
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      effects.length = 0
      const tree = fn()
      effects.forEach((effect) => effect())
      return tree
    },
  }
}

// 带一行「1小时 ¥29.90」的草稿单，就是第一批之后后端自动带出来的样子
const draftOrder = (overrides = {}) => ({
  id: 'order-1',
  version: 'v1',
  status: 'draft',
  receivableCents: 2990,
  paidCents: 0,
  lines: [{ name: '1小时', quantity: 1, unitPriceCents: 2990 }],
  ...overrides,
})

class StaffError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

async function checkoutPage({
  order,
  loyaltyCalls = [],
  staffCalls = [],
  quote,
  roles = ['clerk'],
  loyaltyAction,
  session,
  setCustomer,
  updateOrder,
  payOrder,
}: {
  order: any
  /** 收款时怎么回（返回新订单）；默认收齐、订单变已付款。 */
  payOrder?: (current: any, amountCents: number) => any
  loyaltyCalls?: any[]
  staffCalls?: any[]
  quote?: any
  roles?: string[]
  /** 收到 loyalty 动作时怎么回；setOrder 模拟别处同时改了订单（之后读到的就是它）。 */
  loyaltyAction?: (input: any, setOrder: (next: any) => void) => any
  /** 订单所属会话；是 Error 时读会话失败。 */
  session?: any
  /** 换顾客时怎么回（返回新订单，或抛错；setOrder 同上）；默认换成功、版本换新。 */
  setCustomer?: (current: any, accountId: string | null, version: string, setOrder: (next: any) => void) => any
  /** 保存明细时怎么回（返回新订单，或抛错）；默认按明细保存、应收 ¥50.00。 */
  updateOrder?: (current: any, lines: any[], version: string) => any
}) {
  const h = hooks()
  let current = order
  const setOrder = (next: any) => (current = next)
  const modals: any[] = []
  const toasts: string[] = []
  const returns: number[] = []
  const { default: Checkout } = await load('pages/staff/checkout/index.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text', Picker: 'Picker' },
    '@tarojs/taro': {
      default: {
        showToast(options: any) {
          toasts.push(options.title)
        },
        hideToast() {},
        pageScrollTo() {},
        showModal: async (options: any) => {
          modals.push(options)
          return { confirm: true }
        },
      },
      useRouter: () => ({ params: { id: 'order-1' } }),
    },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': { ActionButton: 'Action', Field: 'Field', StaffScreen: 'Screen', Stepper: 'Stepper' },
    '../../../components/customer': { Status: 'Status' },
    '../../../components/staff/member-settlement': { MemberSettlement: 'MemberSettlement' },
    '../../../components/staff/account-search': {
      AccountSearch: 'AccountSearch',
      accountText: (account) => `${account.nickname} · ${account.phoneMasked || '未绑定手机'}`,
    },
    '../../../services/staff': {
      StaffError,
      catalogLabel: (item) => item.name,
      staffApi: {
        getOrder: async () => current,
        listCatalog: async () => [],
        getSession: async (id) => {
          staffCalls.push({ call: 'getSession', id })
          if (session instanceof Error) throw session
          return session
        },
        updateOrder: async (id, lines, version) => {
          staffCalls.push({ call: 'updateOrder', id, lines, version })
          current = updateOrder
            ? updateOrder(current, lines, version)
            : { ...current, version: 'v2', lines, receivableCents: 5000 }
          return current
        },
        setOrderCustomer: async (id, accountId, version) => {
          staffCalls.push({ call: 'setOrderCustomer', id, accountId, version })
          current = setCustomer
            ? setCustomer(current, accountId, version, setOrder)
            : { ...current, version: `${version}+`, accountId: accountId ?? undefined, customer: null }
          return current
        },
        payOrder: async (id, method, amountCents, version, cashReceivedCents) => {
          staffCalls.push({ call: 'payOrder', id, method, amountCents, version, cashReceivedCents })
          if (payOrder) {
            current = payOrder(current, amountCents)
            return current
          }
          return { ...current, status: 'paid', paidCents: amountCents }
        },
        compOrder: async (id, reason, version) => {
          staffCalls.push({ call: 'compOrder', id, reason, version })
          current = {
            ...current,
            version: 'v-comp',
            status: 'paid',
            settlement: 'comp',
            compCents: current.receivableCents,
            payments: [{ id: 'c1', method: 'comp', amountCents: current.receivableCents, reason, createdAt: 'x' }],
          }
          return current
        },
        discountOrder: async (id, data, version) => {
          staffCalls.push({ call: 'discountOrder', id, data, version })
          current = { ...current, version: 'v3', discounts: [{ id: 'd1', ...data, createdAt: '2026-10-05T00:00:00Z' }] }
          return current
        },
      },
    },
    '../../../services/staff-workflow': await load('services/staff-workflow.ts', {
      './format': { money: (cents) => (cents / 100).toFixed(2) },
    }),
    '../../../services/format': {
      ...(await load('services/format.ts')),
      money: (cents) => (cents / 100).toFixed(2),
      basisPoints: (value) => `${value}bp`,
    },
    '../../../hooks/customer': { useCustomer: () => ({ account: { roles } }) },
    '../../../services/membership': {
      loyalty: {
        action: async (input) => {
          loyaltyCalls.push(input)
          if (loyaltyAction) return loyaltyAction(input, setOrder)
          return input.action === 'quote' ? quote : {}
        },
      },
    },
    '../../../services/navigation': {
      navigateApp() {},
      returnToPreviousPage: async () => {
        returns.push(1)
      },
    },
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
  })
  return { render: () => h.render(Checkout), loyaltyCalls, staffCalls, modals, toasts, returns }
}
const action = (tree, startsWith) =>
  nodes(tree, (node) => node.type === 'Action' && label(node).startsWith(startsWith))[0]

// 散客、明细没改：一次点击，一个请求。
test('a walk-in bill is settled with one tap and one request', async () => {
  const page = await checkoutPage({ order: draftOrder() })
  page.render()
  await settle()
  const tree = page.render()

  const button = action(tree, '确认收款')
  assert.ok(button, '按钮上要写金额，店员不用回头看别处')
  assert.match(label(button), /29\.90/)
  assert.equal(nodes(tree, (node) => label(node).includes('保存明细')).length, 0, '明细没改就不用保存')

  button.props.onClick()
  await settle()
  assert.equal(page.staffCalls.length, 1)
  assert.equal(page.staffCalls[0].call, 'payOrder')
  assert.equal(page.staffCalls[0].amountCents, 2990)
})

// 散客、改过明细：先保存（按钮不带金额，只给参考合计），页面换成服务端算的应收，再点「确认收款」。
test('editing a line saves first, then pays the amount the server computed', async () => {
  const page = await checkoutPage({ order: draftOrder() })
  page.render()
  await settle()
  const price = nodes(page.render(), (node) => node.type === 'Field' && /单价/.test(node.props.label))[0]
  price.props.onChange('40.00')
  const edited = page.render()
  assert.equal(action(edited, '确认收款'), undefined, '改过明细时不能直接收款：按钮上的数还不是服务端算的')
  assert.ok(action(edited, '保存明细'), '先保存明细')
  assert.match(label(edited), /改动后合计（未保存，以保存后为准）/)
  assert.match(label(edited), /40\.00/, '参考合计按整数分逐行相乘')

  action(edited, '保存明细').props.onClick()
  await settle()
  assert.deepEqual(
    page.staffCalls.map((c) => c.call),
    ['updateOrder'],
    '这一下只保存，不收款',
  )
  const saved = page.render()
  // 服务端保存后的应收是 ¥50.00（例如还有一笔服务端加上的费用），按钮写的是它而不是本地的 ¥40.00
  assert.match(label(action(saved, '确认收款')), /50\.00/)
  action(saved, '确认收款').props.onClick()
  await settle()
  assert.deepEqual(
    page.staffCalls.map((c) => c.call),
    ['updateOrder', 'payOrder'],
  )
  assert.equal(page.staffCalls[1].version, 'v2', '收款必须用保存后的新版本，否则后端 409')
  assert.equal(page.staffCalls[1].amountCents, 5000, '登记的就是按钮上的数')
})

// 会员单的报价在收款前过期（后端拒收，loyalty_conflict）：作废旧报价、自动重算，等店员核对新金额后再点；不自动重提。
test('a stale member quote is re-quoted and waits for the clerk instead of getting stuck', async () => {
  const quotes = ['q1', 'q2'].map((version, i) => ({
    originalCents: 2990,
    discountCents: 0,
    pointsUsed: 0,
    pointsCents: 0,
    principalCents: 0,
    giftCents: 0,
    offlineCents: 2990 - i * 100,
    earnedPoints: 29,
    version,
  }))
  let quoteIndex = 0,
    rejectOnce = true
  const page = await checkoutPage({
    order: draftOrder({ accountId: 'acct-1' }),
    loyaltyAction: (input) => {
      if (input.action === 'quote') return quotes[Math.min(quoteIndex++, quotes.length - 1)]
      if (input.action === 'checkout' && rejectOnce) {
        rejectOnce = false
        throw new StaffError('loyalty_conflict', '会员资产或权益已变化，请重新预览结账')
      }
      return {}
    },
  })
  page.render()
  await settle()
  page.render()
  await settle()
  action(page.render(), '确认收款').props.onClick()
  await settle()
  page.render()
  await settle()
  const tree = page.render()
  assert.equal(page.loyaltyCalls.filter((c) => c.action === 'checkout').length, 1, '不能自动重提')
  assert.equal(page.loyaltyCalls.filter((c) => c.action === 'quote').length, 2, '旧报价作废后自动重算一份')
  assert.match(label(tree), /已重新计算优惠/)
  assert.match(label(action(tree, '确认收款')), /28\.90/, '按钮换成新报价的线下补付')

  action(tree, '确认收款').props.onClick()
  await settle()
  const paid = page.loyaltyCalls.filter((c) => c.action === 'checkout')
  assert.equal(paid.length, 2)
  assert.equal(paid[1].quoteVersion, 'q2', '店员确认的是新报价')
})

// 会员单：抵扣在同一屏，收款走 checkout（带 quoteVersion），不再跳去另一个页面。
test('a member bill settles on the same screen, no hop to another page', async () => {
  const quote = {
    originalCents: 2990,
    discountCents: 0,
    pointsUsed: 0,
    pointsCents: 0,
    principalCents: 0,
    giftCents: 0,
    offlineCents: 2990,
    earnedPoints: 29,
    version: 'q1',
  }
  const page = await checkoutPage({ order: draftOrder({ accountId: 'acct-1' }), quote })
  page.render()
  await settle()
  page.render()
  await settle()
  const tree = page.render()

  // 打开页面就自动预览过一次（积分 0、不用余额）：店员什么都不选也能直接收线下款
  const quotes = page.loyaltyCalls.filter((c) => c.action === 'quote')
  assert.equal(quotes.length, 1, '自动预览一次，不该让店员多点一下「计算并预览」')
  assert.equal(quotes[0].points, 0)
  assert.equal(quotes[0].useBalance, false)
  assert.equal(nodes(tree, (node) => label(node).includes('会员结账')).length, 0, '跳去另一个页面的那个按钮没有了')
  assert.equal(nodes(tree, (node) => node.type === 'MemberSettlement').length, 1, '抵扣就在这一屏')

  action(tree, '确认收款').props.onClick()
  await settle()
  const paid = page.loyaltyCalls.filter((c) => c.action === 'checkout')
  assert.equal(paid.length, 1, '会员单走 checkout，不走 payOrder —— 后端对会员单的普通收款一律 409')
  assert.equal(paid[0].quoteVersion, 'q1')
  assert.equal(page.staffCalls.length, 0)
})

// 0 价占位行（后端对不上套餐时带的那种）不能直接收款，且要说清为什么点不动。
test('a zero-price placeholder line blocks payment and says why', async () => {
  const page = await checkoutPage({
    order: draftOrder({
      receivableCents: 0,
      lines: [{ name: '计时 45 分钟', quantity: 1, unitPriceCents: 0 }],
    }),
  })
  page.render()
  await settle()
  const tree = page.render()

  assert.equal(action(tree, '确认收款').props.disabled, true)
  assert.match(label(tree), /有明细还没填单价/, '灰着不说话等于让店员猜')
})

// 人工折扣：柜台结账前当场减免，从订单管理页搬到结账页（订单管理去了电脑后台）。只有店长、老板能做。
const field = (tree, text) => nodes(tree, (node) => node.type === 'Field' && node.props.label === text)[0]

test('only managers and owners see manual discounts at checkout', async () => {
  for (const [roles, visible] of [
    [['clerk'], false],
    [['manager'], true],
    [['owner'], true],
  ] as [string[], boolean][]) {
    const page = await checkoutPage({ order: draftOrder(), roles })
    page.render()
    await settle()
    assert.equal(!!action(page.render(), '应用折扣'), visible, `${roles[0]}`)
  }
})

test('a discount saves edited lines first, then applies on the saved version', async () => {
  const page = await checkoutPage({ order: draftOrder(), roles: ['manager'] })
  page.render()
  await settle()
  // 改一行明细的单价（未保存），再填 10% 和原因
  nodes(page.render(), (node) => node.type === 'Field' && /单价/.test(node.props.label))[0].props.onChange('50.00')
  field(page.render(), '减免百分比').props.onChange('10')
  field(page.render(), '折扣原因').props.onChange('老顾客')
  action(page.render(), '应用折扣').props.onClick()
  await settle()
  assert.deepEqual(
    page.staffCalls.map((call) => call.call),
    ['updateOrder', 'discountOrder'],
    '明细先保存再折扣：折扣算在已保存的明细上',
  )
  const discount = page.staffCalls[1]
  assert.deepEqual(JSON.parse(JSON.stringify(discount.data)), {
    kind: 'percentage',
    rateBasisPoints: 1000,
    reason: '老顾客',
  })
  assert.equal(discount.version, 'v2', '折扣用保存明细之后的新版本，否则后端 409')
  assert.equal(field(page.render(), '减免百分比').props.value, '', '成功后清空输入')
})

// 应收为 0 的单收不了款（收款至少 1 分），草稿会一直挂在待结账里。整单不收钱要用免单，后端拒绝把应收减到 0 的
// 人工折扣（409 zero_receivable），这里提交前先说，不发请求。
test('a discount that would take the receivable to zero is refused before the request', async () => {
  for (const [kind, value] of [
    ['减免百分比', '100'],
    ['减免金额（元）', '29.90'],
    ['减免金额（元）', '35'],
  ]) {
    const page = await checkoutPage({ order: draftOrder(), roles: ['owner'] })
    page.render()
    await settle()
    if (kind !== '减免百分比')
      nodes(page.render(), (node) => node.type === 'Button' && label(node) === '固定金额')[0].props.onClick()
    field(page.render(), kind).props.onChange(value)
    field(page.render(), '折扣原因').props.onChange('老顾客')
    action(page.render(), '应用折扣').props.onClick()
    await settle()
    assert.deepEqual(
      page.staffCalls.filter((call) => call.call === 'discountOrder'),
      [],
      `${kind} ${value}`,
    )
    assert.ok(label(page.render()).includes('请用「免单」'), `${kind} ${value}`)
  }
  // 留 1 分照常提交
  const page = await checkoutPage({ order: draftOrder(), roles: ['owner'] })
  page.render()
  await settle()
  nodes(page.render(), (node) => node.type === 'Button' && label(node) === '固定金额')[0].props.onClick()
  field(page.render(), '减免金额（元）').props.onChange('29.89')
  field(page.render(), '折扣原因').props.onChange('老顾客')
  action(page.render(), '应用折扣').props.onClick()
  await settle()
  assert.equal(page.staffCalls.filter((call) => call.call === 'discountOrder').length, 1)
})

test('a discount over 100% is refused before any request', async () => {
  const page = await checkoutPage({ order: draftOrder(), roles: ['owner'] })
  page.render()
  await settle()
  field(page.render(), '减免百分比').props.onChange('120')
  field(page.render(), '折扣原因').props.onChange('写错了')
  action(page.render(), '应用折扣').props.onClick()
  await settle()
  assert.equal(page.staffCalls.length, 0)
  assert.ok(label(page.render()).includes('减免比例不能超过 100%'))
})

// 会员单的报价（线下补付、版本可指定）与按文字找按钮
const memberQuote = (offlineCents = 2990, version = 'q1') => ({
  originalCents: 2990,
  discountCents: 0,
  pointsUsed: 0,
  pointsCents: 0,
  principalCents: 0,
  giftCents: 0,
  offlineCents,
  earnedPoints: 29,
  version,
})
const button = (tree, text) => nodes(tree, (node) => node.type === 'Button' && label(node) === text)[0]

// ---- 缺陷 9：会员扫码入座的套餐订单只读；loyalty_conflict 显示后端原文 ----

test('a package order from a scan-to-seat admission is read-only: no line edits, no discount, no customer change', async () => {
  const page = await checkoutPage({
    order: draftOrder({
      accountId: 'acct-1',
      venueSessionId: 'session-1',
      lines: [{ name: '三小时套餐', quantity: 1, unitPriceCents: 2990 }],
    }),
    session: { id: 'session-1', admissionId: 'admission-1' },
    quote: memberQuote(),
    roles: ['manager'],
  })
  page.render()
  await settle()
  page.render()
  await settle()
  const tree = page.render()
  assert.deepEqual(
    page.staffCalls.filter((call) => call.call === 'getSession'),
    [{ call: 'getSession', id: 'session-1' }],
  )
  assert.match(label(tree), /按购买时的套餐快照结算/)
  assert.match(label(tree), /三小时套餐/)
  assert.equal(nodes(tree, (node) => node.type === 'Field' && /单价/.test(node.props.label)).length, 0, '明细只读')
  assert.equal(nodes(tree, (node) => node.type === 'Picker').length, 0)
  assert.equal(button(tree, '添加明细'), undefined)
  assert.equal(action(tree, '应用折扣'), undefined, '店长也不能给套餐单打折')
  assert.equal(action(tree, '更换顾客'), undefined, '顾客由入座申请决定')
  assert.equal(button(tree, '改为散客'), undefined)
  assert.match(label(tree), /顾客由入座申请决定，不能更换/)
  // 收款照常：会员结账
  assert.match(label(action(tree, '确认收款')), /29\.90/)
})

test('a refused save shows the server reason instead of a made-up member-asset message', async () => {
  const page = await checkoutPage({
    // 会话读不到：照常给改（后端照样会拦）
    order: draftOrder({ venueSessionId: 'session-1' }),
    session: new Error('网络连接失败'),
    updateOrder: () => {
      throw new StaffError('loyalty_conflict', '套餐订单按购买快照结算，其他消费请单独建单')
    },
  })
  page.render()
  await settle()
  nodes(page.render(), (node) => node.type === 'Field' && /单价/.test(node.props.label))[0].props.onChange('40.00')
  action(page.render(), '保存明细').props.onClick()
  await settle()
  const tree = page.render()
  assert.match(label(tree), /套餐订单按购买快照结算，其他消费请单独建单/)
  assert.doesNotMatch(label(tree), /会员资产或权益已变化/)
})

// ---- 缺陷 10：会员结账因订单在别处被改而被拒，给重读入口，不拿旧版本重算报价 ----

test('a member checkout refused because the order changed elsewhere offers a reread instead of re-quoting the old version', async () => {
  const page = await checkoutPage({
    order: draftOrder({ accountId: 'acct-1' }),
    loyaltyAction: (input, setOrder) => {
      if (input.action === 'quote') return memberQuote(2990, `q-${input.expectedVersion}`)
      // 别人刚在手机上加了一项：后端按订单版本不符拒收（会员结账回的是 loyalty_conflict）
      setOrder(draftOrder({ accountId: 'acct-1', version: 'v9', receivableCents: 3990 }))
      throw new StaffError('loyalty_conflict', '订单已变化，请重新读取')
    },
  })
  page.render()
  await settle()
  page.render()
  await settle()
  action(page.render(), '确认收款').props.onClick()
  await settle()
  page.render()
  await settle()
  let tree = page.render()
  assert.match(label(tree), /订单已变化，请重新读取。订单已在别处被修改，请重新读取订单/)
  assert.ok(action(tree, '重新读取订单'), '要给重读的按钮')
  assert.equal(action(tree, '确认收款').props.disabled, true)
  assert.equal(page.loyaltyCalls.filter((call) => call.action === 'quote').length, 1, '不拿旧版本去重算报价')
  assert.equal(page.loyaltyCalls.filter((call) => call.action === 'checkout').length, 1, '不自动重提')

  action(tree, '重新读取订单').props.onClick()
  await settle()
  page.render()
  await settle()
  tree = page.render()
  const quotes = page.loyaltyCalls.filter((call) => call.action === 'quote')
  assert.equal(quotes.length, 2)
  assert.equal(quotes[1].expectedVersion, 'v9', '重读后按新版本报价，由店员核对后再收')
  assert.equal(action(tree, '重新读取订单'), undefined)
})

// ---- 顾客账户：草稿订单绑定、更换或改散客（规则同网页结账页） ----

const wang = { id: 'acct-2', nickname: '小王', phoneMasked: '138****0003' }
const search = (tree) => nodes(tree, (node) => node.type === 'AccountSearch')[0]

test('binding a customer turns a walk-in bill into a member bill, quoted on the new version', async () => {
  const page = await checkoutPage({
    order: draftOrder(),
    quote: memberQuote(),
    setCustomer: (current, accountId) => ({ ...current, version: 'v2', accountId, customer: wang }),
  })
  page.render()
  await settle()
  let tree = page.render()
  assert.match(label(tree), /散客单：没有绑定顾客账户/)
  assert.equal(search(tree), undefined, '先不展开找人')
  action(tree, '绑定顾客账户').props.onClick()
  tree = page.render()
  assert.equal(action(tree, '确认绑定').props.disabled, true, '没选人不能提交')
  search(tree).props.onSelect(wang)
  action(page.render(), '确认绑定').props.onClick()
  await settle()
  page.render()
  await settle()
  tree = page.render()

  const change = page.staffCalls.find((call) => call.call === 'setOrderCustomer')
  assert.deepEqual(change, { call: 'setOrderCustomer', id: 'order-1', accountId: 'acct-2', version: 'v1' })
  assert.match(label(tree), /小王 · 138\*\*\*\*0003/)
  assert.equal(search(tree), undefined, '换好就收起')
  // 换了顾客订单版本变了：按新版本报价，走会员结账
  const quotes = page.loyaltyCalls.filter((call) => call.action === 'quote')
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].expectedVersion, 'v2')
  assert.equal(nodes(tree, (node) => node.type === 'MemberSettlement').length, 1)
})

test('a stale customer change keeps the choice, waits for a reread, then confirms on the new version', async () => {
  let attempts = 0
  const page = await checkoutPage({
    order: draftOrder(),
    quote: memberQuote(),
    setCustomer: (current, accountId, version, setOrder) => {
      attempts++
      if (attempts === 1) {
        // 就在这时，有人在手机上改了明细
        setOrder({ ...current, version: 'v2', receivableCents: 3990 })
        throw new StaffError('order_version_conflict', '订单已被修改，请重新读取并确认')
      }
      return { ...current, version: `${version}+`, accountId, customer: wang }
    },
  })
  page.render()
  await settle()
  action(page.render(), '绑定顾客账户').props.onClick()
  search(page.render()).props.onSelect(wang)
  action(page.render(), '确认绑定').props.onClick()
  await settle()
  let tree = page.render()
  assert.match(label(tree), /订单已被修改/)
  assert.ok(action(tree, '重新读取订单'), '给出重读入口')
  assert.equal(search(tree).props.selected, wang, '选好的人留着')
  assert.equal(action(tree, '确认绑定').props.disabled, true, '重读之前不能再提交')
  assert.equal(page.staffCalls.filter((call) => call.call === 'setOrderCustomer').length, 1, '不自动重提')

  action(tree, '重新读取订单').props.onClick()
  await settle()
  tree = page.render()
  assert.equal(action(tree, '重新读取订单'), undefined)
  action(tree, '确认绑定').props.onClick()
  await settle()
  const changes = page.staffCalls.filter((call) => call.call === 'setOrderCustomer')
  assert.equal(changes.length, 2)
  assert.equal(changes[1].version, 'v2', '店员确认的是重读后的那一版')
  assert.equal(changes[1].accountId, 'acct-2')
})

test('clearing the customer asks first and sends null', async () => {
  const page = await checkoutPage({
    order: draftOrder({
      accountId: 'acct-1',
      customer: { id: 'acct-1', nickname: '小李', phoneMasked: '139****0002' },
    }),
    quote: memberQuote(),
    setCustomer: (current) => ({ ...current, version: 'v2', accountId: undefined, customer: null }),
  })
  page.render()
  await settle()
  page.render()
  await settle()
  let tree = page.render()
  assert.ok(action(tree, '更换顾客'))
  button(tree, '改为散客').props.onClick()
  await settle()
  await settle()
  tree = page.render()
  const change = page.staffCalls.find((call) => call.call === 'setOrderCustomer')
  assert.deepEqual(change, { call: 'setOrderCustomer', id: 'order-1', accountId: null, version: 'v1' })
  assert.match(label(tree), /散客单/)
  assert.equal(nodes(tree, (node) => node.type === 'MemberSettlement').length, 0, '散客单不用会员结账')
  assert.match(label(action(tree, '确认收款')), /29\.90/)
})

// ---- 现金实收与找零 ----

const methodButton = (tree, text) => button(tree, text)
const cashField = (tree) =>
  nodes(tree, (node) => node.type === 'Field' && node.props.label === '实收现金（元，选填）')[0]

test('cash: what the customer handed over shows the change and goes on the payment; wrong amounts block', async () => {
  const page = await checkoutPage({ order: draftOrder() })
  page.render()
  await settle()
  let tree = page.render()
  assert.equal(cashField(tree), undefined, '默认微信：没有实收现金')
  methodButton(tree, '现金').props.onClick()
  tree = page.render()
  assert.ok(cashField(tree), '选现金才填')
  cashField(tree).props.onChange('20')
  tree = page.render()
  assert.equal(action(tree, '确认收款').props.disabled, true)
  assert.match(label(tree), /实收现金不能少于本次收款 ¥29\.90/)
  cashField(tree).props.onChange('2000')
  assert.match(label(page.render()), /找零不能超过 ¥1000\.00/)
  cashField(page.render()).props.onChange('50')
  tree = page.render()
  assert.match(label(tree), /应找零¥20\.10/)
  action(tree, '确认收款').props.onClick()
  await settle()
  const pay = page.staffCalls.find((call) => call.call === 'payOrder')
  assert.equal(pay.method, 'cash')
  assert.equal(pay.amountCents, 2990)
  assert.equal(pay.cashReceivedCents, 5000)
})

test('cash left empty, or another method, sends no tender', async () => {
  for (const method of ['现金', '支付宝']) {
    const page = await checkoutPage({ order: draftOrder() })
    page.render()
    await settle()
    methodButton(page.render(), method).props.onClick()
    action(page.render(), '确认收款').props.onClick()
    await settle()
    const pay = page.staffCalls.find((call) => call.call === 'payOrder')
    assert.equal(pay.cashReceivedCents, undefined, method)
  }
})

test('a member bill paid partly in cash carries the tender on checkout, never on the quote', async () => {
  const page = await checkoutPage({ order: draftOrder({ accountId: 'acct-1' }), quote: memberQuote(2500) })
  page.render()
  await settle()
  page.render()
  await settle()
  methodButton(page.render(), '现金').props.onClick()
  cashField(page.render()).props.onChange('30')
  const tree = page.render()
  assert.match(label(tree), /应找零¥5\.00/, '按线下补付找零')
  action(tree, '确认收款').props.onClick()
  await settle()
  const checkout = page.loyaltyCalls.find((call) => call.action === 'checkout')
  assert.equal(checkout.method, 'cash')
  assert.equal(checkout.cashReceivedCents, 3000)
  assert.ok(page.loyaltyCalls.filter((call) => call.action === 'quote').every((call) => !('cashReceivedCents' in call)))
})

test('cash tender rules: optional, at least the amount due, change at most ¥1,000', async () => {
  const { cashTender } = await load('services/staff-workflow.ts', {
    './format': { money: (cents) => (cents / 100).toFixed(2), storeOffsetMinutes: 480 },
  })
  assert.deepEqual(cashTender('', 2990), {})
  assert.deepEqual(cashTender('50', 2990), { receivedCents: 5000, changeCents: 2010 })
  assert.deepEqual(cashTender('29.9', 2990), { receivedCents: 2990, changeCents: 0 })
  assert.deepEqual(cashTender('1029.90', 2990), { receivedCents: 102990, changeCents: 100000 })
  assert.match(cashTender('1029.91', 2990).error, /找零不能超过/)
  assert.match(cashTender('29.89', 2990).error, /不能少于/)
  for (const bad of ['0', '-1', '1.234', 'abc']) assert.match(cashTender(bad, 2990).error, /大于 0 的金额/)
  assert.deepEqual(cashTender('50', null), { receivedCents: 5000 }, '还没有要收的数时只核对格式')
})

// 计时费：后端按发布的规则算好的（超时加收几块、自由计时几块、陪客费），结账页原样显示，不在本地算。
test('the timing note shows what the server computed, and warns when the timing lines were edited', async () => {
  const timing = {
    kind: 'package',
    summary: '超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块',
    usedSeconds: 5100,
    overtimeSeconds: 1500,
    totalCents: 4490,
    applied: true,
  }
  const page = await checkoutPage({ order: draftOrder({ receivableCents: 4490, timing }) })
  page.render()
  await settle()
  const text = label(page.render())
  assert.ok(text.includes('计时费 ¥44.90（系统按计时算）'))
  assert.ok(text.includes('超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块。'))

  const edited = await checkoutPage({ order: draftOrder({ timing: { ...timing, applied: false } }) })
  edited.render()
  await settle()
  assert.ok(label(edited.render()).includes('计时明细被改过'))
})

// 免单（店长、老板）：必须写原因，先确认（写清不能退款、不能改回），带读到的订单版本；店员没有入口。
test('a manager comps the bill with a reason after confirming; clerks have no comp', async () => {
  const page = await checkoutPage({ order: draftOrder(), roles: ['manager'] })
  page.render()
  await settle()
  const comp = () => action(page.render(), '免单结清')
  assert.ok(comp(), '店长有免单入口')
  assert.equal(comp().props.disabled, true, '没写原因不能点')
  const reason = nodes(page.render(), (node) => node.type === 'Field' && node.props.label === '免单原因')[0]
  reason.props.onChange('老顾客生日')
  comp().props.onClick()
  await settle()
  await settle()
  assert.equal(page.modals.length, 1)
  assert.equal(page.modals[0].confirmText, '确认免单')
  assert.match(page.modals[0].content, /应收 ¥29\.90 将记为免单.*不能退款.*原因：老顾客生日/)
  assert.deepEqual(
    page.staffCalls.filter((call) => call.call === 'compOrder'),
    [{ call: 'compOrder', id: 'order-1', reason: '老顾客生日', version: 'v1' }],
  )
  assert.equal(page.staffCalls.filter((call) => call.call === 'payOrder').length, 0, '免单不登记收款')

  const clerk = await checkoutPage({ order: draftOrder(), roles: ['clerk'] })
  clerk.render()
  await settle()
  assert.equal(action(clerk.render(), '免单结清'), undefined, '店员看不到免单')
})

test('comp rules: reason required, saved lines, non-zero receivable', async () => {
  const { compBlocker, compReasonError, compConfirmContent, timingNote } = await load('services/charge.ts')
  assert.equal(compReasonError('  '), '请填写免单原因')
  assert.equal(compReasonError('字'.repeat(201)), '原因最多 200 字')
  assert.equal(compReasonError('老顾客'), '')
  const order = { status: 'draft', receivableCents: 2990 }
  assert.equal(compBlocker({ order, dirty: false, conflict: false }), '')
  assert.match(compBlocker({ order, dirty: true, conflict: false }), /先保存/)
  assert.match(compBlocker({ order, dirty: false, conflict: true }), /重新读取/)
  assert.match(compBlocker({ order: { ...order, receivableCents: 0 }, dirty: false, conflict: false }), /应收是 0/)
  assert.match(compBlocker({ order: { ...order, status: 'paid' }, dirty: false, conflict: false }), /不是待结账/)
  assert.match(compConfirmContent(2990, ' 生日 '), /应收 ¥29\.90 将记为免单/)
  assert.equal(timingNote(undefined), null)
  const frozen = timingNote({
    kind: 'package',
    summary: '已用 45 分钟（不含暂停），约定 60 分钟，未超时',
    usedSeconds: 2700,
    overtimeSeconds: 0,
    totalCents: 2990,
    frozenAt: '2026-10-06T03:25:00Z',
    applied: true,
  })
  assert.equal(frozen.lines[1], '已停止计时（2026-10-06 11:25），按停止那一刻算，不再变。')
  const companion = timingNote({
    kind: 'companion',
    summary: '陪客不计时，陪客费 ¥20.00',
    usedSeconds: 0,
    overtimeSeconds: 0,
    totalCents: 2000,
    applied: true,
  })
  assert.deepEqual(companion.lines, ['陪客不计时，陪客费 ¥20.00。'])
})

// ---- 分笔付款（多人合付，2026-10-06 业主定） ----
// 一单可以分几笔收：这一笔默认还差的全部，可以改小；没收齐订单是部分付款，留在这一页接着收下一笔；
// 第一笔之后计价与明细冻结，明细只读、不能换顾客打折；店长老板可以对剩余免单。金额都用接口给的数。

const amountField = (tree) =>
  nodes(tree, (node) => node.type === 'Field' && /这一笔收多少|这次收线下款/.test(node.props.label))[0]

// 收到一笔部分付款后的订单（后端给的样子）
const partialOrder = (overrides = {}) =>
  draftOrder({
    version: 'v-p1',
    status: 'partially_paid',
    paidCents: 1000,
    outstandingCents: 1990,
    payments: [{ id: 'p1', method: 'wechat', amountCents: 1000, createdAt: '2026-10-06T02:00:00Z' }],
    ...overrides,
  })

test('a smaller first payment leaves the bill partially paid and stays on the page for the next one', async () => {
  const page = await checkoutPage({
    order: draftOrder({ outstandingCents: 2990 }),
    payOrder: (current, amountCents) =>
      amountCents < current.outstandingCents
        ? partialOrder({ paidCents: amountCents, outstandingCents: current.outstandingCents - amountCents })
        : { ...current, status: 'paid', paidCents: current.paidCents + amountCents, outstandingCents: 0 },
  })
  page.render()
  await settle()
  let tree = page.render()
  assert.ok(amountField(tree), '有「这一笔收多少」')
  assert.match(amountField(tree).props.placeholder, /全部 ¥29\.90/, '默认收还差的全部')
  assert.match(label(action(tree, '确认收款')), /29\.90/)

  amountField(tree).props.onChange('10')
  tree = page.render()
  assert.match(label(action(tree, '确认收款')), /10\.00/, '按钮上的数就是这一笔')
  assert.match(label(tree), /收完订单是部分付款/)
  action(tree, '确认收款').props.onClick()
  await settle()
  assert.equal(page.staffCalls.at(-1).amountCents, 1000)
  assert.equal(page.staffCalls.at(-1).version, 'v1')
  assert.deepEqual(page.returns, [], '没收齐不回上一页')
  assert.equal(page.toasts.at(-1), '已收 ¥10.00，还差 ¥19.90')

  tree = page.render()
  assert.match(label(tree), /已收 1 笔 · ¥10\.00/)
  assert.match(label(tree), /微信/)
  assert.equal(amountField(tree).props.value, '', '收完回到默认的还差全部')
  const next = action(tree, '收下一笔')
  assert.ok(next, '接着收下一笔')
  assert.match(label(next), /19\.90/)
  assert.equal(nodes(tree, (node) => node.type === 'Field' && /单价/.test(node.props.label)).length, 0, '明细只读')
  assert.match(label(tree), /计价与明细已冻结/)
  next.props.onClick()
  await settle()
  assert.equal(page.staffCalls.at(-1).amountCents, 1990)
  assert.equal(page.staffCalls.at(-1).version, 'v-p1', '收下一笔用部分付款之后的新版本')
  // 收齐了：整屏画勾、写明一共收了多少，约 1 秒后自己回上一页，点一下马上回
  const done = nodes(page.render(), (node) => node.props?.className === 'done-overlay')[0]
  assert.match(label(done), /收款成功¥29\.90/)
  assert.deepEqual(page.returns, [])
  done.props.onClick()
  await settle()
  assert.deepEqual(page.returns, [1], '收齐了才回上一页')
})

test('a payment over what is still owed is blocked before any request', async () => {
  const page = await checkoutPage({ order: partialOrder() })
  page.render()
  await settle()
  amountField(page.render()).props.onChange('20')
  const tree = page.render()
  assert.match(label(tree), /这一笔不能超过还差的 ¥19\.90/)
  assert.equal(action(tree, '收下一笔').props.disabled, true)
  action(tree, '收下一笔').props.onClick()
  await settle()
  assert.equal(page.staffCalls.filter((call) => call.call === 'payOrder').length, 0)
  for (const bad of ['0', 'abc', '1.234']) {
    amountField(page.render()).props.onChange(bad)
    assert.match(label(page.render()), /大于 0 的金额/, bad)
  }
})

test('a partially paid bill shows what was received, is read-only, and cash change is per payment', async () => {
  const page = await checkoutPage({
    order: partialOrder({
      accountId: 'acct-1',
      payments: [
        { id: 'b1', method: 'balance', amountCents: 600, member: true, createdAt: '2026-10-06T02:00:00Z' },
        {
          id: 'c1',
          method: 'cash',
          amountCents: 400,
          member: true,
          cashReceivedCents: 500,
          changeCents: 100,
          createdAt: '2026-10-06T02:00:00Z',
        },
      ],
    }),
    roles: ['owner'],
  })
  page.render()
  await settle()
  let tree = page.render()
  const text = label(tree)
  assert.match(text, /已收 2 笔 · ¥10\.00/)
  assert.match(text, /会员结账 · 储值余额/, '会员结账那几条标出来')
  assert.match(text, /实收 ¥5\.00 · 找零 ¥1\.00/)
  assert.match(text, /还差¥19\.90/)
  assert.equal(nodes(tree, (node) => node.type === 'MemberSettlement').length, 0, '部分付款不再会员报价')
  assert.equal(action(tree, '应用折扣'), undefined, '不能打折')
  assert.equal(action(tree, '更换顾客'), undefined, '不能换顾客')
  assert.equal(page.loyaltyCalls.length, 0, '不再报价')
  // 现金：找零按这一笔算
  button(tree, '现金').props.onClick()
  amountField(page.render()).props.onChange('9.90')
  cashField(page.render()).props.onChange('10')
  tree = page.render()
  assert.match(label(tree), /应找零¥0\.10/)
  action(tree, '收下一笔').props.onClick()
  await settle()
  const pay = page.staffCalls.find((call) => call.call === 'payOrder')
  assert.equal(pay.amountCents, 990)
  assert.equal(pay.cashReceivedCents, 1000)
})

test('a manager comps the rest of a partially paid bill after a confirm that says what was received', async () => {
  const page = await checkoutPage({ order: partialOrder(), roles: ['manager'] })
  page.render()
  await settle()
  const comp = () => action(page.render(), '剩余免单')
  assert.ok(comp(), '部分付款的单可以对剩余免单')
  assert.match(label(page.render()), /对剩余免单/)
  nodes(page.render(), (node) => node.type === 'Field' && node.props.label === '免单原因')[0].props.onChange(
    '朋友没带钱',
  )
  comp().props.onClick()
  await settle()
  await settle()
  assert.equal(page.modals.length, 1)
  assert.equal(page.modals[0].title, '对剩余免单 ¥19.90')
  assert.ok([...page.modals[0].confirmText].length <= 4)
  assert.match(page.modals[0].content, /已收 ¥10\.00，剩余 ¥19\.90 将记为免单.*已收的钱照常可以退.*原因：朋友没带钱/)
  assert.deepEqual(
    page.staffCalls.filter((call) => call.call === 'compOrder'),
    [{ call: 'compOrder', id: 'order-1', reason: '朋友没带钱', version: 'v-p1' }],
  )
  const clerk = await checkoutPage({ order: partialOrder(), roles: ['clerk'] })
  clerk.render()
  await settle()
  assert.equal(action(clerk.render(), '剩余免单'), undefined, '店员不能免单')
})

test('a member checkout can take only part of the offline top-up, but must take some money', async () => {
  const page = await checkoutPage({
    order: draftOrder({ accountId: 'acct-1', outstandingCents: 2990 }),
    quote: memberQuote(2990),
    loyaltyAction: (input) => {
      if (input.action === 'quote') return memberQuote(2990)
      return {
        order: partialOrder({ accountId: 'acct-1', paidCents: 1000, outstandingCents: 1990 }),
        quote: memberQuote(),
      }
    },
  })
  page.render()
  await settle()
  page.render()
  await settle()
  let tree = page.render()
  assert.equal(amountField(tree).props.label, '这次收线下款（元，选填）')
  amountField(tree).props.onChange('0')
  tree = page.render()
  assert.match(label(tree), /会员结账这一笔要收到钱/, '不用储值又不收线下款：后端会拒，先说')
  assert.equal(action(tree, '确认收款').props.disabled, true)
  amountField(page.render()).props.onChange('10')
  action(page.render(), '确认收款').props.onClick()
  await settle()
  const checkout = page.loyaltyCalls.find((call) => call.action === 'checkout')
  assert.equal(checkout.offlineCents, 1000, '只收一部分线下补付')
  assert.equal(page.toasts.at(-1), '已收 ¥10.00，还差 ¥19.90')
  assert.deepEqual(page.returns, [])
  assert.ok(action(page.render(), '收下一笔'), '余下的接着收')

  // 不改金额：一次收齐，请求和以前一样不带 offlineCents
  const full = await checkoutPage({ order: draftOrder({ accountId: 'acct-1' }), quote: memberQuote(2990) })
  full.render()
  await settle()
  full.render()
  await settle()
  action(full.render(), '确认收款').props.onClick()
  await settle()
  assert.ok(!('offlineCents' in full.loyaltyCalls.find((call) => call.action === 'checkout')))
})

test('a member can pay only their share with stored value: balanceCents rides on the quote and the checkout', async () => {
  const page = await checkoutPage({
    order: draftOrder({ accountId: 'acct-1', outstandingCents: 2990 }),
    quote: memberQuote(2990),
    loyaltyAction: (input) => {
      if (input.action === 'quote') {
        const used = input.useBalance ? (input.balanceCents ?? 2990) : 0
        return { ...memberQuote(2990 - used, `q-${used}`), principalCents: used }
      }
      return {
        order: partialOrder({ accountId: 'acct-1', paidCents: 1000, outstandingCents: 1990 }),
        quote: memberQuote(1990, 'q-1000'),
      }
    },
  })
  page.render()
  await settle()
  page.render()
  await settle()
  // 会员抵扣一段（MemberSettlement）：打开用储值，填这次用多少
  const settlement = (tree) => nodes(tree, (node) => node.type === 'MemberSettlement')[0]
  assert.equal(settlement(page.render()).props.balance, '')
  settlement(page.render()).props.setUseBalance(true)
  await settle()
  page.render()
  await settle()
  // 格式不对：不报价，就地说明
  const quotesBefore = page.loyaltyCalls.filter((call) => call.action === 'quote').length
  settlement(page.render()).props.setBalance('十块')
  await settle()
  page.render()
  await settle()
  assert.equal(page.loyaltyCalls.filter((call) => call.action === 'quote').length, quotesBefore)
  assert.match(settlement(page.render()).props.balanceError, /储值金额按元填写/)
  // 只用 ¥10 储值，这次不收线下款
  settlement(page.render()).props.setBalance('10')
  await settle()
  page.render()
  await settle()
  const quote = page.loyaltyCalls.filter((call) => call.action === 'quote').at(-1)
  assert.equal(quote.balanceCents, 1000)
  assert.equal(quote.useBalance, true)
  amountField(page.render()).props.onChange('0')
  action(page.render(), '确认收款').props.onClick()
  await settle()
  const checkout = page.loyaltyCalls.find((call) => call.action === 'checkout')
  assert.equal(checkout.balanceCents, 1000, '确认时带和报价一样的储值上限')
  assert.equal(checkout.offlineCents, 0)
  assert.equal(checkout.quoteVersion, 'q-1000')
  assert.equal(page.toasts.at(-1), '已收 ¥10.00，还差 ¥19.90')
})

test('stored value cap: empty means use all, yuan converts to cents, zero allowed, bad text explained', async () => {
  const { balanceCapCents } = await load('services/staff-workflow.ts', {
    './format': { money: (cents) => (cents / 100).toFixed(2), storeOffsetMinutes: 480 },
  })
  assert.deepEqual(balanceCapCents(''), {})
  assert.deepEqual(balanceCapCents(' 30.5 '), { cents: 3050 })
  assert.deepEqual(balanceCapCents('0'), { cents: 0 })
  for (const bad of ['-1', '1.234', 'abc']) assert.match(balanceCapCents(bad).error, /储值金额按元填写/)
})

test('split payment helpers: amount defaults to all, no more than owed; comp wording; payment lines', async () => {
  const { paymentAmount } = await load('services/staff-workflow.ts', {
    './format': { money: (cents) => (cents / 100).toFixed(2), storeOffsetMinutes: 480 },
  })
  assert.deepEqual(paymentAmount('', 2990), { cents: 2990, partial: false })
  assert.deepEqual(paymentAmount('10', 2990), { cents: 1000, partial: true })
  assert.deepEqual(paymentAmount('29.9', 2990), { cents: 2990, partial: false })
  assert.match(paymentAmount('29.91', 2990).error, /不能超过还差的 ¥29\.90/)
  assert.match(paymentAmount('0', 2990).error, /大于 0/)
  assert.deepEqual(paymentAmount('0', 2990, true), { cents: 0, partial: true }, '会员结账这次可以不收线下款')
  const { compBlocker, compConfirmContent, paymentLine } = await load('services/charge.ts')
  assert.equal(
    compBlocker({
      order: { status: 'partially_paid', receivableCents: 2990, outstandingCents: 1990 },
      dirty: false,
      conflict: false,
    }),
    '',
  )
  assert.match(compConfirmContent(1990, '朋友没带钱', 1000), /已收 ¥10\.00，剩余 ¥19\.90 将记为免单/)
  assert.deepEqual(paymentLine({ id: 'p', method: 'wechat', amountCents: 1000, createdAt: '2026-10-06T02:00:00Z' }), {
    title: '微信',
    amount: '¥10.00',
    detail: '2026-10-06 10:00',
  })
  assert.equal(
    paymentLine({ id: 'b', method: 'balance', amountCents: 600, member: true, createdAt: '2026-10-06T02:00:00Z' })
      .title,
    '会员结账 · 储值余额',
  )
  assert.match(
    paymentLine({ id: 'c', method: 'comp', amountCents: 1990, reason: '老顾客', createdAt: '2026-10-06T02:00:00Z' })
      .detail,
    / · 老顾客$/,
  )
})
