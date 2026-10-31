import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { billingMock } from './helpers/billing'
import { expandNamed } from './helpers/tree'

test('membership mutations preserve idempotency after unknown results and isolate different actions', async () => {
  const calls: any[] = []
  let fail = true
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (args) => {
      calls.push(args)
      if (fail) {
        fail = false
        throw new Error('timeout')
      }
      return { statusCode: 200, data: { balance: { points: 20 } } }
    },
  }
  const staff = await load('services/staff.ts', { '@tarojs/taro': { default: taro } })
  const customer = await load('services/customer.ts')
  const { loyalty } = await load('services/membership.ts', {
    '@tarojs/taro': { default: taro },
    './customer': customer,
    './staff': staff,
  })
  const action = { action: 'recharge', accountId: 'customer', targetId: 'rule', method: 'cash' }
  await assert.rejects(loyalty.action(action))
  await loyalty.action(action)
  assert.equal(calls[0].header['Idempotency-Key'], calls[1].header['Idempotency-Key'])
  await loyalty.action({ ...action, action: 'exchange' })
  assert.notEqual(calls[1].header['Idempotency-Key'], calls[2].header['Idempotency-Key'])
  assert.equal(calls[0].data.accountId, 'customer')
  assert.equal(calls[0].url.endsWith('/loyalty/actions'), true)
})
test('customer membership reads map authorization failures for resource clearing', async () => {
  const customer = await load('services/customer.ts')
  const { loyalty } = await load('services/membership.ts', {
    '@tarojs/taro': { default: {} },
    './customer': customer,
    './staff': {
      request: async () => {
        throw { code: 'forbidden', status: 403, message: 'denied' }
      },
    },
  })
  await assert.rejects(loyalty.me(), (e) => e instanceof customer.CustomerError && (e as any).status === 403)
})
test('table scene and staff checkout survive login navigation without accepting external redirects', async () => {
  const n = await load('services/navigation.ts', { '@tarojs/taro': { default: {} } })
  const scene = '11111111111141118111111111111111'
  assert.equal(
    n.sanitizeTarget(`/pages/customer/experience/index?scene=${scene}`),
    `/pages/customer/experience/index?scene=${scene}`,
  )
  assert.equal(
    n.sanitizeTarget('/pages/staff/membership/index?orderId=order-1&redirect=https://bad.example'),
    '/pages/staff/membership/index?orderId=order-1',
  )
  assert.equal(n.fallbackPage('pages/customer/membership/index'), '/pages/profile/index')
  assert.equal(n.fallbackPage('pages/staff/membership/index'), '/pages/staff/workbench/index')
})
test('balance payment labels and integer money preserve cents', async () => {
  const { money, paymentLabels } = await load('services/format.ts')
  assert.equal(paymentLabels.balance, '储值余额')
  assert.equal(money(10001), '100.01')
  assert.equal(money(-1), '-0.01')
})

async function pageHarness(file: string, resource: any, overrides: Record<string, unknown> = {}) {
  const slots: any[] = []
  let cursor = 0
  const react: any = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (v: any) => (slots[i] = typeof v === 'function' ? v(slots[i]) : v)]
    },
    useRef(initial: any) {
      return this.useState(() => ({ current: initial }))[0]
    },
    useEffect() {},
  }
  // Hook methods must also work when React imports are invoked unbound.
  react.useRef = (initial: any) => react.useState(() => ({ current: initial }))[0]
  const mocks = {
    react,
    '@tarojs/components': { View: 'View', Text: 'Text', Image: 'Image', Picker: 'Picker' },
    '@tarojs/taro': {
      default: {},
      useRouter: () => ({ params: { tableId: 'table' } }),
      useDidShow() {},
      useDidHide() {},
    },
    '../../components/button': { Button: 'Button' },
    '../../components/pagination': {
      PageControls: 'PageControls',
      pageSlice: (items, page) => items.slice(page * 20, (page + 1) * 20),
    },
    '../../components/customer': {
      Screen: 'Screen',
      AuthBoundary: 'Auth',
      Failure: 'Failure',
      RefreshNotice: 'Notice',
      Skeleton: 'Skeleton',
      SectionEmpty: 'SectionEmpty',
    },
    '../../hooks/query': { useCustomerQuery: () => resource },
    '../../services/membership': { loyalty: {}, entryNames: {} },
    '../../services/format': await load('services/format.ts'),
    '../../services/navigation': { navigateApp() {} },
    // 扫桌码抽成了 service（首页主卡和手作页都用它）；真实实现要相机，这里给桩
    '../../services/table-code': { scanTableCode: async () => '', tableIdFromLaunch: (params) => params.tableId || '' },
    '../../components/customer/member-code-sheet': { MemberCodeSheet: 'MemberCodeSheet' },
    '../../components/customer/assets': { assets: { logoWhite: 'brand.png' } },
    './index.scss': {},
    '../membership/index.scss': {},
    '../../hooks/billing': billingMock(),
    '../../hooks/customer': { useCustomer: () => ({ account: { nickname: '小林', phoneMasked: '136****1111' } }) },
    ...overrides,
  }
  const { default: Page } = await load(file, mocks)
  // 手作页的计时卡片（TimingCard，没有 hook）就地展开，看得到桌号、状态和圆环里的字
  return () => {
    cursor = 0
    return expandNamed(Page(), ['TimingCard'])
  }
}
function pageNodes(tree: any): any[] {
  return Array.isArray(tree)
    ? tree.flatMap(pageNodes)
    : tree && typeof tree === 'object'
      ? [tree, ...pageNodes(tree.props?.children)]
      : []
}
function pageText(tree: any): string {
  return Array.isArray(tree)
    ? tree.map(pageText).join('')
    : tree && typeof tree === 'object'
      ? pageText(tree.props?.children)
      : tree == null || typeof tree === 'boolean'
        ? ''
        : String(tree)
}

test('seat selection shows package cost and blocks a stale occupied seat after refresh', async () => {
  const writes: any[] = []
  const data = {
    tables: [{ id: 'table', number: 2, seatCount: 2, occupiedSeats: [2] }],
    member: {
      version: 'v1',
      admissions: [],
      rules: [{ id: 'package', kind: 'package', name: '拼豆体验', durationMinutes: 180, amountCents: 6880 }],
    },
  }
  const resource = { data, refresh: async () => {} }
  const render = await pageHarness('pages/customer/experience/index.tsx', resource, {
    '../../services/membership': { loyalty: { action: async (input) => writes.push(input) } },
    // 呼叫与整桌计时各是一条查询：这位顾客都没有
    '../../hooks/query': { useCustomerQuery: (key) => (key[0] === 'experience' ? resource : { data: [] }) },
  })
  let tree = render()
  const button = (predicate) => pageNodes(tree).find((n) => n.type === 'Button' && predicate(n))
  assert.equal(button((n) => n.props.ariaLabel === '2 号座，已占用').props.disabled, true)
  button((n) => n.props.ariaLabel === '1 号座，可选').props.onClick()
  tree = render()
  button((n) => n.props.ariaLabel?.startsWith('拼豆体验，')).props.onClick()
  tree = render()
  assert.ok(pageText(tree).includes('¥68.80 · 180 分钟'), pageText(tree))
  assert.ok(pageText(tree).includes('2 号桌-1 · 拼豆体验 · ¥68.80'), '底栏写选了哪个座、坐多久、多少钱')
  assert.equal(button((n) => pageText(n) === '申请入座').props.disabled, false)
  data.tables[0].occupiedSeats = [1, 2]
  tree = render()
  assert.equal(button((n) => pageText(n) === '申请入座').props.disabled, true)
  button((n) => pageText(n) === '申请入座').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 0)
  data.tables[0].occupiedSeats = [2]
  tree = render()
  button((n) => pageText(n) === '申请入座').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].seatNumber, 1)
  assert.equal(writes[0].targetId, 'package')
})

test('member sections show a useful empty state when only packages are published', async () => {
  const resource = {
    data: {
      balance: {
        tierName: '普通会员',
        rateBasisPoints: 10000,
        principalCents: 0,
        giftCents: 0,
        points: 0,
        expiringPoints: 0,
      },
      profile: { birthday: '' },
      rules: [{ kind: 'package' }],
      entries: [],
    },
  }
  const render = await pageHarness('pages/customer/membership/index.tsx', resource)
  let tree = render()
  // 空态由共享的 SectionEmpty 渲染，文案是 title prop 而不是子节点。
  const emptyTitles = (t) =>
    pageNodes(t)
      .filter((n) => n.type === 'SectionEmpty')
      .map((n) => n.props.title)
  assert.deepEqual(emptyTitles(tree), ['暂未发布会员活动'])
  assert.equal(
    pageNodes(tree).some((n) => n.type === 'Picker'),
    false,
  )
  pageNodes(tree)
    .find((n) => n.type === 'Button' && pageText(n) === '明细')
    .props.onClick()
  tree = render()
  assert.deepEqual(emptyTitles(tree), ['还没有资产记录'])
  pageNodes(tree)
    .find((n) => n.type === 'Button' && pageText(n) === '生日福利')
    .props.onClick()
  tree = render()
  assert.deepEqual(emptyTitles(tree), ['暂未发布生日福利'])
  assert.equal(pageNodes(tree).filter((n) => n.type === 'Picker').length, 1)
})

test('默认明细保留会员卡，最近入口切回明细并滚到实际导航栏下方，金额保留千分位', async () => {
  const height = 91
  const scrolls: unknown[] = []
  const query = {
    select(selector: string) {
      assert.equal(selector, '.membership-screen .navbar')
      return query
    },
    boundingClientRect: () => query,
    exec: (callback) => callback([{ height }]),
  }
  const render = await pageHarness(
    'pages/customer/membership/index.tsx',
    {
      data: {
        balance: { principalCents: 100000, giftCents: 120000, boardUses: 1, points: 0, tierName: '普通会员' },
        profile: { birthday: '' },
        entries: [
          {
            id: 'consume',
            kind: 'consume',
            principalCents: -100,
            giftCents: 0,
            points: [],
            createdAt: '2026-10-27T02:00:00Z',
          },
        ],
        rules: [{ id: 'recharge', kind: 'recharge', name: '888 送 120', amountCents: 88800, giftCents: 12000 }],
      },
    },
    {
      '@tarojs/taro': {
        default: {
          nextTick: (callback) => callback(),
          createSelectorQuery: () => query,
          pageScrollTo: async (options) => {
            scrolls.push(options)
          },
        },
      },
    },
  )
  let tree = render()
  const selected = () => pageNodes(tree).find((n) => n.props?.className === 'loyalty-tab loyalty-tab-selected')
  assert.equal(pageText(selected()), '明细')
  assert.ok(pageNodes(tree).some((n) => n.props?.className === 'loyalty-member'))
  assert.ok(pageText(tree).includes('余额¥2,200.00'))
  assert.ok(pageText(tree).includes('其中赠送 ¥1,200.00'))
  pageNodes(tree)
    .find((n) => n.type === 'Button' && pageText(n) === '会员权益')
    .props.onClick()
  tree = render()
  assert.ok(pageText(tree).includes('充 ¥888，余额到账 ¥1,008'))
  pageNodes(tree)
    .find((n) => n.props?.className === 'loyalty-latest')
    .props.onClick()
  tree = render()
  assert.equal(pageText(selected()), '明细')
  assert.equal(pageNodes(tree).find((n) => n.props?.className === 'loyalty-tabs').props.id, 'membership-tabs')
  assert.deepEqual(scrolls, [{ selector: '#membership-tabs', offsetTop: -height, duration: 300 }])
})

// 顾客看到的规则说明要和网页后台同一口径：最低使用、是否与会员价同享、有效期、限领次数都要写出来。
test('member benefits spell out limits, stacking and validity', async () => {
  const rule = (kind, extra?) => ({
    id: kind,
    kind,
    name: kind,
    amountCents: 100,
    giftCents: 0,
    points: 10,
    rateBasisPoints: 9500,
    maxBasisPoints: 5000,
    minimumPoints: 100,
    validDays: 30,
    mode: '',
    scope: 'all',
    stack: false,
    perUserLimit: 2,
    ...extra,
  })
  const resource = {
    data: {
      balance: {
        tierName: '普通会员',
        rateBasisPoints: 10000,
        principalCents: 0,
        giftCents: 0,
        points: 0,
        expiringPoints: 0,
      },
      profile: { birthday: '' },
      rules: [
        rule('recharge', { amountCents: 50000, giftCents: 5000 }),
        rule('tier', { mode: 'cumulative', amountCents: 100000, validDays: 0 }),
        rule('earn', { scope: 'goods' }),
        rule('redeem'),
        rule('exchange'),
        rule('birthday', { mode: 'month', scope: 'points', perUserLimit: 1, validDays: 7 }),
      ],
      entries: [],
    },
  }
  const render = await pageHarness('pages/customer/membership/index.tsx', resource)
  const text = pageText(render())
  for (const expected of [
    '10 积分（30 天内有效）',
    '等级永久有效',
    '购买商品的实付每 ¥1.00 获得 10 积分',
    '至少用 100 积分',
    '不与会员价同时享受',
    '每人限 2 次',
  ]) {
    assert.ok(text.includes(expected), `缺少「${expected}」：${text}`)
  }
  // 生日福利单独一栏（2026-10-20）
  assert.equal(text.includes('每年限领'), false, '生日福利不混在会员权益里')
  pageNodes(render())
    .find((n) => n.type === 'Button' && pageText(n) === '生日福利')
    .props.onClick()
  assert.ok(pageText(render()).includes('每年限领 1 次，领取后 7 天内有效'))
})

// 2026-10-27 起手作页「取消申请」先问一句；最近一次申请被店员拒绝、或 30 分钟没人确认失效了的（两小时内），
// 写明结果，不再悄悄消失。结果看接口的 displayStatus。
test('手作页：取消入座申请先问；被拒绝、没等到确认的申请写明结果', async () => {
  const writes: any[] = []
  const modals: any[] = []
  let answer = false
  const pack = { id: 'package', kind: 'package', name: '拼豆体验', durationMinutes: 180, amountCents: 6880 }
  const admission = (id: string, displayStatus: string, minutesAgo: number) => ({
    displayStatus,
    admission: {
      id,
      serviceTableId: 'table',
      seatNumber: 1,
      package: pack,
      status: displayStatus === 'expired' ? 'pending' : displayStatus,
      createdAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    },
  })
  const data: any = {
    tables: [{ id: 'table', number: 2, seatCount: 2, occupiedSeats: [] }],
    member: { version: 'v1', admissions: [admission('wait', 'pending', 1)], rules: [pack] },
  }
  const resource = { data, refresh: async () => {} }
  const render = await pageHarness('pages/customer/experience/index.tsx', resource, {
    '@tarojs/taro': {
      default: {
        showModal: async (option) => {
          modals.push(option)
          return { confirm: answer }
        },
      },
      useRouter: () => ({ params: { tableId: 'table' } }),
      useDidShow() {},
      useDidHide() {},
    },
    '../../services/membership': { loyalty: { action: async (input) => writes.push(input) } },
    '../../hooks/query': { useCustomerQuery: (key) => (key[0] === 'experience' ? resource : { data: [] }) },
  })
  const cancel = () => pageNodes(render()).find((n) => n.type === 'Button' && pageText(n) === '取消申请')
  cancel().props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 0, '点「再等等」不取消')
  assert.equal(modals[0].title, '取消入座申请？')
  assert.equal(modals[0].content, '2 号桌 · 拼豆体验。取消后店员那边也看不到了，想坐的话重新扫码申请。')
  assert.deepEqual([modals[0].confirmText, modals[0].cancelText], ['取消申请', '再等等'])
  answer = true
  cancel().props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].action, 'cancel_request')
  assert.equal(writes[0].targetId, 'wait')

  const card = () => pageNodes(render()).find((n) => n.props?.className === 'experience-unanswered')
  // 店员拒绝了：只看最近一次
  data.member.admissions = [admission('old', 'expired', 50), admission('no', 'rejected', 10)]
  assert.ok(pageText(card()).includes('店员没有通过这次入座申请'), pageText(card()))
  assert.ok(pageText(card()).includes('2 号桌 · 拼豆体验 · '))
  // 没人确认，过期了
  data.member.admissions = [admission('late', 'expired', 40)]
  assert.ok(pageText(card()).includes('入座申请没等到确认，已经失效'))
  // 两小时前的不再提；顾客自己取消的、正在等的也不提
  data.member.admissions = [admission('late', 'expired', 121)]
  assert.equal(card(), undefined)
  data.member.admissions = [admission('mine', 'cancelled', 5)]
  assert.equal(card(), undefined)
  data.member.admissions = [admission('old', 'rejected', 20), admission('wait', 'pending', 1)]
  assert.equal(card(), undefined, '有正在等的申请时不提上一次')
})

// 2026-10-27 起领生日福利、保存生日都先问一句：福利一领就开始算有效期、过期作废，生日一年只能设一次，都撤不回来。
// 今年设过生日的不再给选，免得选好、确认了才被后端拒。
test('生日福利领取与保存生日都先问一句，今年设过的生日不给再改', async () => {
  const writes: any[] = []
  const modals: any[] = []
  let answer = false
  const resource = {
    data: {
      version: 'v1',
      balance: { tierName: '普通会员', principalCents: 0, giftCents: 0, points: 0, boardUses: 0 },
      profile: { birthday: '', birthdayYear: 0 },
      rules: [
        {
          id: 'gift',
          kind: 'birthday',
          name: '生日小挂件',
          mode: 'month',
          scope: 'gift',
          perUserLimit: 1,
          validDays: 7,
        },
      ],
      entries: [],
    },
    refresh: async () => {},
  }
  const render = await pageHarness('pages/customer/membership/index.tsx', resource, {
    '@tarojs/taro': {
      default: {
        showModal: async (option) => {
          modals.push(option)
          return { confirm: answer }
        },
      },
    },
    '../../services/membership': { loyalty: { action: async (input) => writes.push(input) }, entryNames: {} },
  })
  const button = (name: string) => pageNodes(render()).find((n) => n.type === 'Button' && pageText(n) === name)
  button('生日福利').props.onClick()

  button('领取生日福利').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 0, '点「先不领」不领')
  assert.equal(modals[0].title, '现在领取生日福利？')
  assert.equal(
    modals[0].content,
    '生日小挂件：领取后 7 天内有效：到店找店员拿礼物，店员当面核销。不打算这几天来店里的话，可以先不领。',
  )
  assert.deepEqual([modals[0].confirmText, modals[0].cancelText], ['领取', '先不领'])
  answer = true
  button('领取生日福利').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(writes, [{ action: 'claim', targetId: 'gift', expectedVersion: 'v1' }])

  // 选 3 月 8 日再保存：先问，写明一年只能设一次
  pageNodes(render())
    .find((n) => n.type === 'Picker')
    .props.onChange({ detail: { value: [2, 7] } })
  answer = false
  button('保存生日').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.equal(writes.length, 1, '点「再看看」不保存')
  assert.equal(modals.at(-1).content, '生日设为 3 月 8 日。每个自然年只能设置一次，保存后今年就改不了了。')
  answer = true
  button('保存生日').props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(writes.at(-1), { action: 'birthday', birthday: '03-08' })

  // 今年（门店时区）设过了：不给选，也没有保存按钮
  resource.data.profile = { birthday: '03-08', birthdayYear: new Date(Date.now() + 8 * 3600_000).getUTCFullYear() }
  const tree = render()
  assert.equal(pageNodes(tree).find((n) => n.type === 'Picker').props.disabled, true)
  assert.equal(button('保存生日'), undefined)
  assert.ok(pageText(tree).includes('今年已经设置过生日，明年 1 月 1 日起可以再改。'))
  // 去年设的今年还能改一次
  resource.data.profile = { birthday: '03-08', birthdayYear: new Date(Date.now() + 8 * 3600_000).getUTCFullYear() - 1 }
  assert.ok(button('保存生日'))
})

// 系统内收费关着（2026-10-10 起，钱在美团、大众点评收）：套餐不标价；申请时可以选填团购，填得不对不能提交；
// 到打烊的写明用到今天打烊，停了表也不提结账。
test('收费关着：扫码入座不标价、申请带团购，到打烊和停表都不提结账', async () => {
  const writes: any[] = []
  const pack = { id: 'package', kind: 'package', name: '拼豆体验', durationMinutes: 180, amountCents: 6880 }
  const data: any = {
    tables: [{ id: 'table', number: 2, seatCount: 2, occupiedSeats: [] }],
    member: { version: 'v1', admissions: [], rules: [pack] },
  }
  const resource = { data, refresh: async () => {} }
  const render = await pageHarness('pages/customer/experience/index.tsx', resource, {
    '../../services/membership': { loyalty: { action: async (input) => writes.push(input) } },
    '../../hooks/query': { useCustomerQuery: (key) => (key[0] === 'experience' ? resource : { data: [] }) },
    '../../hooks/billing': billingMock(false),
  })
  let tree = render()
  const button = (predicate) => pageNodes(tree).find((n) => n.type === 'Button' && predicate(n))
  const submit = () => button((n) => pageText(n) === '申请入座')
  const coupon = () => pageNodes(tree).find((n) => n.type?.name === 'CouponFields')
  button((n) => n.props.ariaLabel === '1 号座，可选').props.onClick()
  tree = render()
  button((n) => n.props.ariaLabel === '拼豆体验，180 分钟').props.onClick()
  tree = render()
  assert.equal(pageText(tree).includes('¥'), false, `收费关着不该标价：${pageText(tree)}`)
  assert.equal(submit().props.disabled, false)

  // 填了券码没选平台：不能提交，底部写明要先改好
  coupon().props.onChange({ platform: '', code: '1234' })
  tree = render()
  assert.equal(submit().props.disabled, true)
  assert.ok(pageText(tree).includes('团购填得不对，改好后再提交。'))

  coupon().props.onChange({ platform: 'meituan', code: '1234 5678 9012' })
  tree = render()
  submit().props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(writes[0].coupon, { platform: 'meituan', code: '123456789012' }, '券码去掉空格再带')
  tree = render()
  assert.deepEqual(coupon().props.value, { platform: '', code: '' }, '提交后团购清空，下一单不带上一单的')

  // 已确认入座的两条：一条到打烊在计时，一条停了表
  const admission = (id: string, session: Record<string, unknown>) => ({
    displayStatus: 'confirmed',
    admission: { id, serviceTableId: 'table', seatNumber: 1, package: pack, coupon: { platform: 'dianping' } },
    session: { id: `s-${id}`, serviceTableId: 'table', seatNumber: 1, ...session },
    elapsedSeconds: 600,
    remainingSeconds: 0,
  })
  data.member.admissions = [
    admission('close', { status: 'active', untilClose: true }),
    admission('stopped', { status: 'active', stoppedAt: '2026-10-10T08:00:00Z' }),
  ]
  tree = render()
  const states = pageNodes(tree)
    .filter((n) => n.props?.className === 'experience-state')
    .map(pageText)
  assert.deepEqual(states, ['计时中 · 用到今天打烊', '计时已停止'])
  assert.equal(pageText(tree).includes('结账'), false)
  assert.ok(pageText(tree).includes('团购大众点评'))
})
