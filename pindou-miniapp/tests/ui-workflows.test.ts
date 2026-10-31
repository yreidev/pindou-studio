import assert from 'node:assert/strict'
import { test } from 'vitest'
// 会员体系的名字从品牌文案取：改名时不该回头改测试。
import { membershipName } from '../src/brand'
import { load } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'
import { billingMock } from './helpers/billing'

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (next: any) => {
          slots[i] = typeof next === 'function' ? next(slots[i]) : next
        },
      ]
    },
    useRef(initial: any) {
      return api.useState(() => ({ current: initial }))[0]
    },
    // 每次渲染都跑一遍：页面里的副作用只看启动参数，重复跑结果一样
    useEffect(effect: () => void) {
      effect()
    },
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      return fn()
    },
  }
}
const flow = await load('services/staff-workflow.ts', {
  './format': { money: (cents) => (cents / 100).toFixed(2), storeOffsetMinutes: 8 * 60 },
})

// 现场页（原工作台）的数据各角色一样；billing 是门店的「系统内收费」开关
const workbenchOverview = () => ({
  tables: [
    { id: 't1', code: 'A1', number: 1, enabled: true, occupancy: 'idle' },
    { id: 't2', code: 'A2', number: 2, enabled: true, occupancy: 'occupied' },
    { id: 't3', code: 'B1', number: 3, enabled: false, occupancy: 'idle' },
  ],
  sessions: [],
  shift: {
    // ★ 第四条是**过期**的：它的 admission.status 仍然是 'pending'
    //   （过期没人点，状态不会自己变），只有 displayStatus 说了实话。
    //   拿 status 计数的话这一行会挂着一条永远处理不了的申请。
    admissions: [
      { displayStatus: 'pending', admission: { id: 'ad1', status: 'pending' } },
      { displayStatus: 'pending', admission: { id: 'ad2', status: 'pending' } },
      { displayStatus: 'confirmed', admission: { id: 'ad3', status: 'confirmed' } },
      { displayStatus: 'expired', admission: { id: 'ad4', status: 'pending' } },
    ],
    tables: [],
  },
  reservations: [
    { displayStatus: 'pending', reservation: { id: 'r1', startAt: at(15) }, tableNumber: 3, customerName: '小林' },
    { displayStatus: 'confirmed', reservation: { id: 'r2', startAt: at(16) } },
    { displayStatus: 'expired', reservation: { id: 'r3', startAt: at(10) } },
  ],
  orders: [{ status: 'draft' }, { status: 'paid' }],
})
async function workbenchPage(role: string, calls: any[], billing = true) {
  const h = hooks()
  const { default: Workbench } = await load('pages/staff/workbench/index.tsx', {
    '../../hooks/billing': billingMock(billing),
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '@tarojs/taro': { default: {} },
    '../../../components/button': { Button: 'Button' },
    '../../../hooks/customer': { useCustomer: () => ({ account: { nickname: '阿贝', roles: [role] } }) },
    '../../../hooks/clock': { useNow: () => Date.now() },
    '../../../hooks/query': { usePageVisible: () => true, useRefreshAll: () => async () => {} },
    '../../../hooks/staff-overview': {
      useStaffOverview: (enabled: boolean, interval: number) => {
        // 收费关着时不拉待结账的单；定时刷新的间隔来自 useStaffEvents，原样交给查询
        assert.equal(enabled, billing)
        assert.equal(interval, 30000)
        return { data: workbenchOverview(), refresh() {} }
      },
    },
    '../../../services/navigation': { navigateApp: (...args) => calls.push(args) },
    '../../../services/staff': { staffMessage: String },
    '../../../components/staff': {
      roleNames: { clerk: '店员', manager: '店长', owner: '老板' },
      StaffScreen: 'Screen',
      useStaffQuery: () => ({ data: [], refresh() {} }),
      useStaffEvents: (interval) => {
        assert.equal(interval, 5000)
        return { connection: 'connected', refetchInterval: 30000 }
      },
    },
    '../../../components/staff/admission-row': { AdmissionRow: 'AdmissionRow' },
    '../../../components/staff/table-sheet': { TableSheet: 'TableSheet' },
    './index.scss': {},
  })
  return () => h.render(Workbench)
}

// 2026-10-20 起老板、店长、店员看到的现场页一样（docs/plan-page-redesign.md 第 2 节）：标题都叫「现场」，名字旁标角色，
// 不再按角色换顺序。低频的规则、权限、盘点、报表都在电脑后台，现场页只留现场要用的。
for (const role of ['clerk', 'manager', 'owner'])
  test(`现场页三种角色一样：等你处理、计时开台、收货入库和连电脑（${role}）`, async () => {
    const calls: any[] = []
    const tree = (await workbenchPage(role, calls))()
    const buttons = nodes(tree, (n) => n.type === 'Button')
    const named = (text: string) => buttons.find((button) => button.props.ariaLabel === text || label(button) === text)
    assert.equal(tree.props.title, '现场')
    assert.equal(
      label(nodes(tree, (n) => n.props.className === 'workbench-role')[0]),
      { clerk: '店员', manager: '店长', owner: '老板' }[role],
    )
    // 顶上三个数：空闲、使用中、需关注（停用的桌也算需关注），点了都去桌位
    assert.deepEqual(nodes(tree, (n) => n.props.className === 'workbench-count-value').map(label), ['1', '1', '1'])
    named('空闲 1 张，去桌位')!.props.onClick()
    assert.deepEqual(calls.at(-1), ['/pages/staff/tables/index', true])
    // 顾客扫码选好套餐后必须店员确认计时才开始，30 分钟不确认就作废：申请直接列在「等你处理」里当场确认。
    // 只列还能处理的：已确认的不该再催，**已过期的更不该催**。
    const admissions = nodes(tree, (n) => n.type === 'AdmissionRow')
    assert.deepEqual(
      admissions.map((n) => n.props.entry.admission.id),
      ['ad1', 'ad2'],
    )
    assert.equal(admissions[0].props.billing, true)
    for (const [name, target] of [
      ['1 单待结账，去收款', ['/pages/staff/orders/index', false]],
      ['1 条预约过了时间还没来，去预约', ['/pages/staff/reservations/index', true]],
      ['1 条预约等确认，去预约', ['/pages/staff/reservations/index', true]],
      // 开台只有一个地方：桌位页
      ['客人到店，计时开台，去平面图点一张空桌', ['/pages/staff/tables/index', true]],
      // 收货入库 2026-10-06 回到手机：货到时扫条码入库，三个角色都有
      ['收货入库', ['/pages/staff/receiving/index', false]],
      // 电脑上的员工后台靠扫码登录：「连电脑」一页里扫码登录、扫码给电脑
      ['连电脑', ['/pages/staff/web-login/index', false]],
    ] as const) {
      const hit = named(name)
      assert.ok(
        hit,
        `${role} 的现场页上应当有「${name}」：${buttons.map((b) => b.props.ariaLabel || label(b)).join(' | ')}`,
      )
      hit.props.onClick()
      assert.deepEqual(calls.at(-1), target)
    }
    const pending = named('1 条预约等确认，去预约')!
    assert.equal(
      label(nodes(pending, (n) => n.props.className === 'workbench-row-meta')[0]),
      '最早 今天 15:00 · 3 号桌 · 小林',
    )
    // 搬去电脑后台的入口、合进别处的旧入口，哪个角色都不该在现场页上再看到
    for (const moved of ['员工权限', '经营规则', '商品库存', '订单与退款', '会员与计时', '扫码登录电脑', '预约到店'])
      assert.equal(
        buttons.some((button) => label(button) === moved),
        false,
        `${role} 的现场页不该再有「${moved}」`,
      )
    assert.equal(label(tree).includes('现在没有要处理的事'), false)
    assert.match(label(nodes(tree, (n) => n.props.className === 'workbench-spirit')[0]), /版本/)
  })

const scannedTable = 'tbl-1'
// 首页里的小组件（状态卡、上新、门店行）没有钩子：直接调用展开，好在整棵树里找按钮
const expand = (tree: any): any => {
  if (Array.isArray(tree)) return tree.map(expand)
  if (!tree || typeof tree !== 'object') return tree
  if (typeof tree.type === 'function') return expand(tree.type(tree.props))
  return tree.props?.children === undefined
    ? tree
    : { ...tree, props: { ...tree.props, children: expand(tree.props.children) } }
}
const homeBrand = await load('brand.ts')
const homeReservations = await load('services/reservations.ts', {
  './customer': { CustomerError: class extends Error {} },
  './staff': { request: async () => ({}) },
  './format': await load('services/format.ts'),
})
const homeStorefront = await load('services/storefront.ts', {
  '@tarojs/taro': { default: {} },
  './api-base': { apiBase: 'https://shop.test/api/v2' },
  './reservations': homeReservations,
  '../brand': homeBrand,
})
const homeCalls = await load('services/service-calls.ts', {
  './customer': { CustomerError: class extends Error {}, messageForCode: () => '' },
  './staff': { request: async () => ({}), StaffError: class extends Error {} },
})
const pattern = (id: string, isNew = false) => ({
  id,
  name: `图纸${id}`,
  categoryId: null,
  published: true,
  isNew,
  firstPublishedAt: null,
  width: 600,
  height: 600,
  updatedAt: '2026-10-20T02:00:00Z',
  imagePath: `/pattern-images/${id}/full?v=1`,
  thumbnailPath: `/pattern-images/${id}/thumb?v=1`,
})
const at = (hour: number) => homeReservations.storeInstant(homeReservations.storeDate(0), hour * 60).toISOString()
const shopFront = (over: Record<string, unknown> = {}) => ({
  announcement: { body: '周三店休一天\n周四照常营业' },
  contact: {
    phone: '0571-8888 6666',
    wechat: 'examplebrand_pindou',
    address: '杭州市西湖区某路 1 号',
    latitude: 30.2,
    longitude: 120.1,
  },
  today: { date: '2026-10-20', status: 'open', opensAt: '10:00', closesAt: '22:00' },
  selfService: true,
  slots: [
    { startAt: at(14), remaining: 3 },
    { startAt: at(15), remaining: 0 },
    { startAt: at(18), remaining: 5 },
  ],
  featured: [pattern('p1', true), pattern('p2'), pattern('p3')],
  ...over,
})

type HomeOptions = {
  billing?: boolean
  params?: Record<string, string>
  /** 窗口高度：375×667 的 iPhone SE 底部栏页约 618 */
  windowHeight?: number
  storefront?: Record<string, unknown> | null
  visit?: unknown
  reservations?: unknown[]
  serviceCalls?: unknown[]
  /** 底部栏改名（setTabBarItem）记在这里 */
  tabs?: unknown[]
}
async function homePage(role: string, calls: any[], h: ReturnType<typeof hooks>, options: HomeOptions = {}) {
  const authenticated = role !== 'guest'
  const employee = ['clerk', 'manager', 'owner'].includes(role)
  const { default: Home } = await load('pages/index/index.tsx', {
    '../../hooks/billing': billingMock(options.billing ?? true),
    react: h.api,
    '@tarojs/taro': {
      default: {
        getWindowInfo: () => ({ windowHeight: options.windowHeight ?? 618 }),
        onWindowResize() {},
        offWindowResize() {},
        showModal: async (modal) => calls.push(['modal', modal]),
        showToast: async (toast) => calls.push(['toast', toast.title]),
        openLocation: async (place) => calls.push(['location', place]),
        makePhoneCall: async (phone) => calls.push(['phone', phone.phoneNumber]),
        setClipboardData: async (data) => calls.push(['copy', data.data]),
        setTabBarItem: async (item) => options.tabs?.push(item),
      },
      useRouter: () => ({ params: options.params ?? {} }),
      useDidShow() {},
      useShareAppMessage() {},
      useShareTimeline() {},
    },
    '@tarojs/components': { View: 'View', Text: 'Text', Image: 'Image' },
    '../../components/button': { Button: 'Button' },
    // 状态栏 20 + 品牌头 60
    '../../components/customer': { Screen: 'Screen', navbarHeight: () => 80 },
    '../../components/customer/assets': { assets: { logoWhite: 'logo' } },
    '../../hooks/clock': { useNow: () => Date.now() },
    '../../hooks/customer': {
      useCustomer: () => ({
        status: authenticated ? 'authenticated' : 'anonymous',
        account: { nickname: '小林', roles: employee ? [role] : [], developerMode: role },
      }),
    },
    '../../hooks/query': {
      usePublicQuery: () => ({
        data: options.storefront === null ? null : shopFront(options.storefront),
        error: null,
        refresh() {},
      }),
      useCustomerQuery: (key: string[], _load: unknown, query: { enabled?: boolean } = {}) => {
        if (!authenticated || query.enabled === false) return { data: null, refresh: async () => {} }
        if (key[0] === 'home') return { data: options.visit ?? null, refresh: async () => {} }
        if (key[0] === 'reservations')
          return { data: { reservations: options.reservations ?? [] }, refresh: async () => {} }
        return { data: options.serviceCalls ?? [], updatedAt: Date.now(), refresh: async () => {} }
      },
    },
    '../../brand': homeBrand,
    '../../services/customer': { errorMessage: (error: Error) => error.message },
    '../../services/membership': { loyalty: {} },
    '../../services/navigation': {
      navigateApp: (url) => calls.push(url),
      beginLogin: (target) => calls.push(['login', target]),
    },
    '../../services/reservations': homeReservations,
    '../../services/service-calls': {
      ...homeCalls,
      serviceCalls: { mine: async () => [], call: async (id) => calls.push(['call', id]) },
    },
    '../../services/storefront': homeStorefront,
    // 首页主卡直接扫码：扫到什么由这里给，页面自己不碰相机
    '../../services/table-code': {
      scanTableCode: async () => scannedTable,
      tableIdFromLaunch: (launch) => (launch.q ? decodeURIComponent(launch.q).split('tableId=')[1] || '' : ''),
    },
    '../../services/whole-table': { wholeTableSessions: async () => [] },
    ...Object.fromEntries(
      [
        'right',
        'tables-ink',
        'reserve-active',
        'business-active',
        'profile-active',
        'orders-active',
        'notice-active',
        'location-active',
        'phone-active',
        'wechat-gold',
      ].map((name) => [`../../assets/staff/${name}.png`, name]),
    ),
    './index.scss': {},
  })
  return () => expand(h.render(Home))
}
const byClass = (tree, name: string) =>
  nodes(tree, (node) =>
    String(node.props?.className || '')
      .split(' ')
      .includes(name),
  )

// 微信「扫普通链接二维码打开小程序」的规则万一配到了首页：带着网页桌码里的桌位转去手作页；没有 q 就不跳
test('a web table code opened on the home page goes on to the table', async () => {
  const calls: any[] = []
  const h = hooks()
  const link = encodeURIComponent('https://pindou.example.invalid/t?tableId=tbl-9')
  ;(await homePage('customer', calls, h, { params: { q: link, scancode_time: '1760000000' } }))()
  assert.deepEqual(calls, ['/pages/customer/experience/index?tableId=tbl-9'])
  const plain: any[] = []
  const g = hooks()
  ;(await homePage('customer', plain, g))()
  assert.deepEqual(plain, [])
})

for (const role of ['guest', 'customer', 'clerk', 'manager', 'owner'])
  test(`home puts the visit first and never shows employee entries to ${role}`, async () => {
    const calls: any[] = []
    const authenticated = role !== 'guest'
    const employee = ['clerk', 'manager', 'owner'].includes(role)
    const render = await homePage(role, calls, hooks())
    const tree = render()
    assert.equal(byClass(tree, 'home-staff-entry').length, employee ? 1 : 0)
    byClass(tree, 'home-start')[0].props.onClick()
    // 主卡直接扫码，是异步的：等一拍再看跳到哪儿；没登录的人先去登录，手作要记在账户上
    await settle()
    assert.deepEqual(
      calls,
      authenticated
        ? [`/pages/customer/experience/index?tableId=${scannedTable}`]
        : [['login', '/pages/customer/experience/index']],
    )
    calls.length = 0
    // 三个入口没登录也能点：进去的页面自己要求登录
    byClass(tree, 'home-action').forEach((button) => button.props.onClick())
    assert.deepEqual(calls, [
      '/pages/customer/reservations/index',
      '/pages/orders/index',
      '/pages/customer/membership/index',
    ])
    assert.equal(label(byClass(tree, 'home-actions')[0]).includes(membershipName), true)
    if (employee) {
      byClass(tree, 'home-staff-entry')[0].props.onClick()
      assert.equal(calls.at(-1), '/pages/staff/workbench/index')
    }
    // 游客也看得到今天还能约、上新和门店
    assert.equal(byClass(tree, 'home-slot').length, 3)
    assert.equal(byClass(tree, 'home-store').length, 1)
  })

// 今天还能约：点格子带着那个整点进预约页（Unix 秒，导航白名单只收字母数字）；约满的点不了；18 点起是夜校
test("today's open hours link to the booking page at that hour", async () => {
  const calls: any[] = []
  const tree = (await homePage('guest', calls, hooks()))()
  const cells = byClass(tree, 'home-slot')
  assert.deepEqual(cells.map(label), ['14:00余 3 座', '15:00已满', `18:00${homeBrand.nightSchoolName}`])
  assert.equal(cells[1].props.disabled, true)
  assert.ok(byClass(cells[2], 'home-slot-night').length || String(cells[2].props.className).includes('home-slot-night'))
  cells[0].props.onClick()
  assert.equal(calls.at(-1), `/pages/customer/reservations/index?at=${homeReservations.slotParam(at(14))}`)
  // 关了自助预约整块不显示；今天一个格子都没有时说明原因、给「去预约」
  assert.equal(
    byClass((await homePage('guest', [], hooks(), { storefront: { selfService: false, slots: [] } }))(), 'home-slots')
      .length,
    0,
  )
  const empty = (
    await homePage('guest', [], hooks(), {
      storefront: { slots: [], today: { date: '2026-10-21', status: 'day_off', opensAt: '10:00', closesAt: '22:00' } },
    })
  )()
  assert.match(label(byClass(empty, 'home-slots')[0]), /今天店休.*去预约/)
})

test('the announcement shows its first line and opens in full; the store row dials, copies and navigates', async () => {
  const calls: any[] = []
  const tree = (await homePage('customer', calls, hooks()))()
  const notice = byClass(tree, 'home-notice')[0]
  assert.equal(label(notice), '周三店休一天')
  notice.props.onClick()
  assert.deepEqual(calls.at(-1), [
    'modal',
    { title: '门店公告', content: '周三店休一天\n周四照常营业', showCancel: false, confirmText: '知道了' },
  ])
  const store = byClass(tree, 'home-store')[0]
  assert.match(label(store), /营业中 · 10:00–22:00.*杭州市西湖区/)
  const actions = byClass(store, 'home-store-button')
  assert.deepEqual(
    actions.map((node) => node.props.ariaLabel),
    ['导航到门店', '拨打门店电话 0571-8888 6666', '复制门店微信号 examplebrand_pindou'],
  )
  actions.forEach((node) => node.props.onClick())
  await settle()
  assert.deepEqual(calls.find((call) => call[0] === 'location')[1], {
    latitude: 30.2,
    longitude: 120.1,
    name: 'Example示例工坊·拼豆·手作研究室',
    address: '杭州市西湖区某路 1 号',
    scale: 17,
  })
  assert.deepEqual(
    calls.find((call) => call[0] === 'phone'),
    ['phone', '057188886666'],
  )
  assert.deepEqual(
    calls.find((call) => call[0] === 'copy'),
    ['copy', 'examplebrand_pindou'],
  )
  // 没填经纬度、电话、微信的不给按钮；没公告不画公告行
  const bare = (
    await homePage('customer', [], hooks(), {
      storefront: {
        announcement: null,
        contact: { phone: '', wechat: '', address: '', latitude: null, longitude: null },
      },
    })
  )()
  assert.equal(byClass(bare, 'home-store-button').length, 0)
  assert.equal(byClass(bare, 'home-notice').length, 0)
})

// 一屏分档：iPhone SE 放一行上新，iPhone 14 放三张大图；高屏登录了加问候
test('the home page picks the pattern block that fits the phone', async () => {
  const size = async (windowHeight: number, role = 'customer') => {
    const tree = (await homePage(role, [], hooks(), { windowHeight }))()
    return {
      featured: ['home-featured-row', 'home-featured-small', 'home-featured-large'].find(
        (name) => byClass(tree, name).length,
      ),
      greeting: label(byClass(tree, 'home-greeting')[0]),
      fit: byClass(tree, 'home-main-fit').length === 1,
    }
  }
  assert.deepEqual(await size(618), { featured: 'home-featured-row', greeting: '', fit: true })
  assert.deepEqual(await size(734), { featured: 'home-featured-large', greeting: '', fit: true })
  assert.match((await size(800)).greeting, /，小林$/)
  // 放不下就照常滚动
  assert.equal((await size(400)).fit, false)
  // 点上新进详情，「全部图纸」去底部「图纸」
  const calls: any[] = []
  const tree = (await homePage('guest', calls, hooks(), { windowHeight: 734 }))()
  byClass(tree, 'home-featured-card')[0].props.onClick()
  byClass(byClass(tree, 'home-featured')[0], 'home-block-more')[0].props.onClick()
  assert.deepEqual(calls, ['/pages/customer/pattern/index?id=p1', '/pages/patterns/index'])
})

// 底部第二格（2026-10-28 业主定）：「今天来示例工坊拼什么？」有图就说明店里有上架的图纸，叫「图纸」；一张都没有叫「做图纸」
test('home names the second tab by whether the shop has published patterns', async () => {
  for (const [featured, text] of [
    [[pattern('p1')], '图纸'],
    [[], '做图纸'],
  ] as const) {
    const tabs: unknown[] = []
    const tree = (await homePage('guest', [], hooks(), { storefront: { featured }, tabs }))()
    assert.deepEqual(tabs.at(-1), { index: 1, text })
    assert.equal(byClass(tree, 'home-featured').length, featured.length ? 1 : 0)
  }
  // 首页内容还没读到：不动，保持 app.config.ts 里的「做图纸」
  const tabs: unknown[] = []
  ;(await homePage('guest', [], hooks(), { storefront: null, tabs }))()
  assert.deepEqual(tabs, [])
})

// 正在店里：状态卡换掉「本次手作」，写在哪桌、拼了多久，能叫店员；今天还能约不再显示
test('a customer in the shop sees the visit card and can call staff from the home page', async () => {
  const calls: any[] = []
  const visit = {
    table: 'C1 桌 · 2 号座',
    pending: false,
    startedAt: at(13),
    free: true,
    minutes: 42,
    remaining: null,
    overdue: 0,
    state: '计时中',
    callSessionId: 'session-1',
  }
  const tree = (await homePage('customer', calls, hooks(), { visit }))()
  assert.equal(byClass(tree, 'home-start').length, 0)
  assert.equal(byClass(tree, 'home-slots').length, 0)
  const card = byClass(tree, 'home-card-dark')[0]
  assert.match(label(card), /小林，正在拼 · C1 桌 · 2 号座13:00 入座 · 自由计时已拼 42 分钟/)
  byClass(card, 'home-card-button-gold')[0].props.onClick()
  await settle()
  assert.deepEqual(calls.slice(0, 2), [
    ['call', 'session-1'],
    ['toast', '已呼叫，店员马上就到'],
  ])
  byClass(card, 'home-card-button-ghost')[0].props.onClick()
  assert.equal(calls.at(-1), '/pages/customer/experience/index')
  // 已经叫过、店员还没到：按钮写「已呼叫」，点不了
  const waiting = (
    await homePage('customer', [], hooks(), {
      visit,
      serviceCalls: [
        { id: 'c', venueSessionId: 'session-1', displayStatus: 'pending', createdAt: at(13), cooldownSeconds: 0 },
      ],
    })
  )()
  const button = byClass(waiting, 'home-card-button-gold')[0]
  assert.equal(label(button), '已呼叫')
  assert.equal(button.props.disabled, true)
})

// 今天有预约：状态卡写几点到几点、在哪、还有多久；收费关着时「查看预约」去底部第三格
test('a customer with a booking today sees it on the home page', async () => {
  const calls: any[] = []
  // 渲染时的「现在」比这里晚几毫秒，倒数向上取整正好是 80 分钟
  const start = new Date(Date.now() + 80 * 60000)
  const entry = {
    reservation: { id: 'r1', startAt: start.toISOString(), seatNumber: 1, status: 'confirmed' },
    displayStatus: 'confirmed',
    endAt: new Date(start.getTime() + 120 * 60000).toISOString(),
    tableNumber: 3,
  }
  // 今天快结束时这条会落到明天，就不在首页了：只在门店今天之内的钟点里断言
  const sameDay =
    homeReservations.isoDate(homeReservations.storeDate(0)) ===
    homeReservations.isoDate(homeReservations.storeDate(0, start))
  const tree = (await homePage('customer', calls, hooks(), { billing: false, reservations: [entry] }))()
  if (!sameDay) {
    assert.equal(byClass(tree, 'home-card-light').length, 0)
    return
  }
  const card = byClass(tree, 'home-card-light')[0]
  assert.match(label(card), /今天的预约还有 1 小时 20 分钟/)
  assert.match(label(card), /3 号桌 · 1 号座 · 已确认/)
  byClass(card, 'home-card-button-plain')[0].props.onClick()
  assert.equal(calls.at(-1), '/pages/orders/index')
  assert.equal(label(tree).includes('消费订单'), false, '收费关着时入口写「我的预约」')
})

// 系统内收费关着（2026-10-10 起，钱在美团、大众点评收）：没有消费订单可看。
// 工作台不给「订单收款」和待结账订单，「计时开台」独占一行。
test('收费关着：现场页不列待结账的单，扫码入座的申请照旧', async () => {
  const calls: any[] = []
  const tree = (await workbenchPage('clerk', calls, false))()
  const buttons = nodes(tree, (n) => n.type === 'Button')
  assert.equal(
    buttons.some((b) => String(b.props.ariaLabel || '').includes('待结账')),
    false,
  )
  const admissions = nodes(tree, (n) => n.type === 'AdmissionRow')
  assert.equal(admissions.length, 2)
  assert.equal(admissions[0].props.billing, false, '确认时不写价格')
  assert.ok(buttons.find((b) => b.props.ariaLabel === '客人到店，计时开台，去平面图点一张空桌'))
})

test('line errors identify bad fields without accepting fractional quantities or excess money precision', () => {
  assert.deepEqual(
    Object.keys(flow.draftLineErrors({ name: '', productId: '', quantity: '1.5', unitPriceYuan: '2.001' })),
    ['name', 'quantity', 'price'],
  )
  assert.equal(
    Object.keys(flow.draftLineErrors({ name: '服务', productId: '', quantity: '2', unitPriceYuan: '0.00' })).length,
    0,
  )
  assert.equal(
    flow.draftLineErrors({ name: '服务', productId: '', quantity: '9007199254740992', unitPriceYuan: '1' }).quantity,
    '数量须为大于零的整数',
  )
})

test('paged views expose all results and clamp after a filter shrinks the list', async () => {
  const { pageSlice } = await load('components/pagination.tsx', { '@tarojs/components': {}, './button': {} })
  const items = Array.from({ length: 47 }, (_, i) => i)
  assert.deepEqual(Array.from(pageSlice(items, 0)), items.slice(0, 20))
  assert.deepEqual(Array.from(pageSlice(items, 1)), items.slice(20, 40))
  assert.deepEqual(Array.from(pageSlice(items, 2)), items.slice(40))
  assert.deepEqual(Array.from(pageSlice(items.slice(0, 5), 2)), items.slice(0, 5))
  assert.equal(pageSlice([], 4).length, 0)
})

// ★★ 账户读不出来时，「我的」页不能整页塌掉。
//
//   原来的结构是「加载中 / 整屏 Failure / account && 全部内容」三选一，有个死锁：
//   账户接口一挂，**「退出登录」也一起消失** —— 而账户数据出问题时重新登录恰恰是用户
//   唯一的自救手段（uni 版 2026-09-19 真机验收记的第一个缺陷，Taro 版是同一份祖本）。
//   同时消失的还有隐私协议（微信要求可达的合规入口）和五个纯导航入口，它们根本不需要
//   account。而 account 为 null 又没有 error 时三个分支全不命中，整页是空白的。
//
//   现在只降级依赖 account 的区块：头像区换成一行「错误文案 + 重试」，手机号换成占位，
//   其余永远在。这条用例把两种状态一起跑，防的是有人再把它改回整屏三选一。
type ProfileData = { account?: unknown; loyalty?: unknown; reservations?: unknown[]; messages?: unknown }
async function profilePage(
  scenario: string,
  navigations: any[],
  refreshes: any[],
  billing = true,
  data: ProfileData = {},
) {
  const { default: Profile } = await load('pages/profile/index.tsx', {
    '../../hooks/billing': billingMock(billing),
    '@tarojs/components': { View: 'View', Text: 'Text', Image: 'Image' },
    '@tarojs/taro': {
      default: {
        navigateTo: ({ url }) => navigations.push(url),
        switchTab: ({ url }) => navigations.push(['tab', url]),
        redirectTo: ({ url }) => navigations.push(['redirect', url]),
        showModal: () => Promise.resolve({ confirm: false }),
      },
    },
    '../../components/button': { Button: 'Button' },
    '../../components/customer': Object.fromEntries(
      ['AuthBoundary', 'RefreshNotice', 'Screen', 'Skeleton'].map((name) => [name, name]),
    ),
    '../../components/customer/avatar': { AccountAvatar: 'Avatar' },
    '../../components/customer/store-contact': {
      chooseStoreContact: (contact) => navigations.push(['contact', contact.phone]),
    },
    '../../hooks/query': {
      useCustomerQuery: (key: string[]) =>
        key[0] === 'account'
          ? {
              data: data.account ?? null,
              loading: false,
              error: scenario === '账户读取失败' ? new Error('账户加载失败') : undefined,
              refresh: () => refreshes.push(1),
            }
          : key[0] === 'loyalty'
            ? { data: data.loyalty ?? null, refresh() {} }
            : key[0] === 'messages-preview'
              ? { data: data.messages ?? { items: [], unreadCount: 0 }, refresh() {} }
              : { data: { reservations: data.reservations ?? [], tables: [] }, refresh() {} },
      // 门店信息用首页那一份（公开接口）
      usePublicQuery: () => ({
        data: {
          contact: {
            phone: '0571-8888 6666',
            wechat: 'examplebrand_pindou',
            address: '',
            latitude: 30.2,
            longitude: 120.1,
          },
        },
        refresh() {},
      }),
    },
    '../../services/platform': { customer: { refreshAccount() {}, logOut() {} }, openPrivacy() {} },
    '../../services/customer': { errorMessage: () => '暂时读不到你的账户信息' },
    '../../services/membership': { loyalty: {} },
    '../../services/reservations': { friendlyStamp: (value) => `F(${value})`, reservations: {} },
    '../../services/storefront': { nextReservation: (list) => list[0] || null, storefront: {} },
    '../../theme': { nativeColors: { danger: '#c00' } },
    ...Object.fromEntries(
      ['profile-active', 'reserve-active', 'phone', 'privacy', 'location-active', 'business-active', 'right'].map(
        (name) => [`../../assets/staff/${name}.png`, name],
      ),
    ),
    './index.scss': {},
  })
  return Profile
}

for (const scenario of ['账户读取失败', '账户为空但没有报错'])
  test(`the profile page keeps sign-out, privacy and navigation reachable when ${scenario}`, async () => {
    const navigations: any[] = []
    const refreshes: any[] = []
    const Profile = await profilePage(scenario, navigations, refreshes)
    const tree = Profile()
    const buttons = nodes(tree, (node) => node.type === 'Button')
    const labels = buttons.map(label)

    // 自救手段与合规入口必须在
    assert.ok(labels.includes('退出登录'), `缺「退出登录」，实际按钮：${labels.join('／')}`)
    assert.ok(labels.includes('隐私协议'), `缺「隐私协议」，实际按钮：${labels.join('／')}`)
    // 两格纯导航入口都不依赖 account；「本次手作」「预约座位」首页就有，这里不再重复
    for (const entry of [membershipName, '我的预约'])
      assert.ok(
        labels.some((text) => text.startsWith(entry)),
        `缺导航入口「${entry}」`,
      )
    for (const gone of ['本次手作', '预约座位', '我的订单'])
      assert.equal(
        labels.some((text) => text.startsWith(gone)),
        false,
        `「我的」页不该再有「${gone}」`,
      )
    assert.ok(labels.includes('我的预约还没有要来的预约'), labels.join('／'))
    // 联系门店用首页那份门店信息：电话、微信、导航有几样写几样
    const contact = buttons.find((node) => label(node).startsWith('联系门店'))!
    assert.equal(label(contact), '联系门店电话 · 微信 · 导航')
    contact.props.onClick()
    assert.deepEqual(navigations.at(-1), ['contact', '0571-8888 6666'])
    // 降级成一行，不是整屏空状态
    const failed = nodes(tree, (node) => node.props.className === 'profile-header-failed')
    assert.equal(failed.length, 1, '头像区应降级成一行「错误 + 重试」')
    const retry = buttons.find((node) => node.props.className === 'profile-retry')
    assert.ok(retry, '降级那一行要有重试按钮')
    retry.props.onClick()
    assert.equal(refreshes.length, 1, '重试要真的触发刷新')
    // 手机号那一行不能整行消失
    assert.equal(label(nodes(tree, (node) => node.props.className === 'profile-phone-placeholder')[0]), '暂时无法读取')
    // 依赖 account 的区块确实不渲染
    assert.equal(nodes(tree, (node) => node.props.className === 'profile-header').length, 0)
    assert.equal(nodes(tree, (node) => node.props.className === 'profile-workbench').length, 0)

    // 顺带确认导航入口点下去去的是分包后的新路径
    buttons.find((node) => label(node).startsWith(membershipName))!.props.onClick()
    assert.equal(navigations.at(-1), '/pages/customer/membership/index')
    buttons.find((node) => label(node).startsWith('我的预约'))!.props.onClick()
    assert.equal(navigations.at(-1), '/pages/customer/my-reservations/index')
  })

test('「我的」页：头部写等级、点进编辑资料；两格写积分和下一场预约；员工多一行工作台', async () => {
  const navigations: any[] = []
  const tree = (
    await profilePage('', navigations, [], true, {
      account: {
        nickname: '小林',
        roles: ['manager'],
        phoneMasked: '138****0000',
        phoneVerificationStatus: 'verified',
      },
      loyalty: { balance: { tierName: '银卡', principalCents: 80810, giftCents: 12000, boardUses: 1, points: 120 } },
      reservations: [{ reservation: { startAt: '2026-10-20T06:00:00Z' }, tableNumber: 3 }],
    })
  )()
  const buttons = nodes(tree, (node) => node.type === 'Button')
  const header = nodes(tree, (node) => node.props.className === 'profile-header')[0]
  assert.equal(header.props.ariaLabel, '小林，编辑资料')
  assert.equal(label(nodes(header, (node) => node.props.className === 'profile-tier')[0]), '银卡')
  header.props.onClick()
  assert.equal(navigations.at(-1), '/pages/customer/profile-edit/index')
  const labels = buttons.map(label)
  assert.ok(labels.includes(`${membershipName}余额 ¥928.10豆板 1 次 · 积分 120`), labels.join('／'))
  assert.ok(labels.includes('我的预约10月20日 14:003 号桌'), labels.join('／'))
  assert.ok(label(tree).includes('138****0000已验证'))
  const staff = nodes(tree, (node) => node.props.className === 'profile-workbench')[0]
  assert.equal(label(staff), '店长工作台只有员工看得到这一行')
  staff.props.onClick()
  assert.deepEqual(navigations.at(-1), ['redirect', '/pages/staff/workbench/index'])
})

test('「我的」消息在第一行、摘要金额和99+未读数可见，点击进入消息页', async () => {
  const navigations: any[] = []
  const tree = (
    await profilePage('', navigations, [], false, {
      messages: {
        unreadCount: 101,
        items: [
          {
            id: 'entry:1',
            kind: 'loyalty',
            at: '2026-10-27T10:00:00Z',
            unread: true,
            entry: {
              id: '1',
              kind: 'consume',
              principalCents: -7990,
              giftCents: 0,
              boardUses: 0,
              points: [],
              balanceAfter: { principalCents: 80810, giftCents: 12000, boardUses: 1 },
            },
          },
        ],
      },
    })
  )()
  const list = nodes(tree, (n) => n.props.className === 'profile-list')[0]
  const first = nodes(list, (n) => n.type === 'Button')[0]
  assert.match(label(first), /^消息消费 ¥79.90，余额 ¥928.1099\+/)
  first.props.onClick()
  assert.equal(navigations.at(-1), '/pages/customer/messages/index')
})

// 收费关着：底部第三格就是我的预约，「我的预约」格切过去，不再另开一页
test('收费关着：「我的」页的「我的预约」切到底部第三格', async () => {
  const navigations: any[] = []
  const tree = (await profilePage('账户为空但没有报错', navigations, [], false))()
  const buttons = nodes(tree, (n) => n.type === 'Button')
  assert.equal(buttons.filter((b) => label(b).startsWith('我的预约')).length, 1)
  buttons.find((b) => label(b).startsWith('我的预约'))!.props.onClick()
  assert.deepEqual(navigations.at(-1), ['tab', '/pages/orders/index'])
})

// ---- 2026-09-19 走查第一批：订单要能分出先后、文案对着正确的人说 ----

const orderCardMocks = (format) => ({
  react: { useEffect() {}, useState: (v) => [v, () => {}] },
  '@tarojs/components': { View: 'View', Text: 'Text', Image: 'Image' },
  '../button': { Button: 'Button' },
  '@tarojs/taro': { default: {}, useRouter: () => ({ path: '', params: {} }) },
  '../../hooks/customer': {},
  '../../services/navigation': {},
  '../../services/customer': { CustomerError: class extends Error {}, errorMessage: String },
  '../../services/format': format,
  './assets': { assets: {} },
  '../developer-status': { DeveloperStatus: 'DeveloperStatus' },
  '../../assets/staff/orders-active.png': 'draft.png',
  '../../assets/staff/paid-active.png': 'paid.png',
})

// 三张「测试1 ¥20.00 已付款」分不出先后：卡片和无障碍标签都要带下单时间。
test('customer order card shows when the order was made', async () => {
  const { orderAmount, moneyText } = await load('services/format.ts')
  const { OrderCard } = await load(
    'components/customer/index.tsx',
    orderCardMocks({
      moneyText,
      orderAmount,
      orderLabels: { paid: '已付款' },
      orderTitle: () => '计时收费',
      dateTime: (value) => `T(${value})`,
    }),
  )
  const stamped = OrderCard({
    order: {
      id: 'o1',
      status: 'paid',
      paidCents: 123450,
      receivableCents: 123450,
      createdAt: '2026-09-19T13:00:00.000Z',
    },
  })
  assert.ok(label(stamped).includes('¥1,234.50'), '给顾客看的金额带千分位')
  assert.ok(label(stamped).includes('T(2026-09-19T13:00:00.000Z)'), '卡片上要有下单时间')
  assert.ok(stamped.props.ariaLabel.includes('T(2026-09-19T13:00:00.000Z)'), '读屏也要念出时间')
  // 老数据没有时间：不显示「--」占位
  const bare = OrderCard({ order: { id: 'o2', status: 'paid', paidCents: 2990, receivableCents: 2990 } })
  assert.equal(label(bare).includes('T('), false)
  assert.equal(nodes(bare, (n) => n.props?.className?.includes('order-time')).length, 0)
})

// 待结账（收费打开时）：分「可以收了」「还在计时」两段，按桌号排；已付款的历史订单不在这里，退款、查询在电脑后台。
test('the staff order page splits open bills into ready and still timing, and opens checkout', async () => {
  const h = hooks()
  const calls: any[] = []
  const orders = [
    {
      id: 'aaaaaaaa-1',
      version: 'v',
      status: 'paid',
      receivableCents: 2990,
      paidCents: 2990,
      createdAt: '2026-10-20T03:00:00.000Z',
      lines: [{ name: '计时收费', quantity: 1 }],
    },
    {
      id: 'bbbbbbbb-2',
      version: 'v',
      status: 'draft',
      receivableCents: 1300,
      paidCents: 0,
      accountId: 'member-1',
      customer: { nickname: '小林' },
      venueSessionId: 's-A3',
      createdAt: '2026-10-20T06:00:00.000Z',
      lines: [{ name: '2 小时', quantity: 1 }],
    },
    {
      id: 'dddddddd-4',
      version: 'v',
      status: 'draft',
      receivableCents: 5800,
      paidCents: 0,
      venueSessionId: 's-B1',
      createdAt: '2026-10-20T05:00:00.000Z',
      lines: [
        { name: '1 小时', quantity: 1 },
        { name: '豆子', quantity: 2 },
        { name: '挂件', quantity: 1 },
      ],
    },
    // 分笔付款收了一部分的单也是待结账：写「部分付款 · 还差」和接口给的还差的数
    {
      id: 'cccccccc-3',
      version: 'v',
      status: 'partially_paid',
      receivableCents: 5000,
      paidCents: 2000,
      outstandingCents: 3000,
      createdAt: '2026-10-20T04:00:00.000Z',
      lines: [{ name: '三人计时', quantity: 1 }],
    },
  ]
  const byKey: Record<string, unknown> = {
    'sales-orders': orders,
    'venue-sessions': [
      { id: 's-A3', serviceTableId: 't-A3', startedAt: '2026-10-20T06:00:00.000Z' },
      {
        id: 's-B1',
        serviceTableId: 't-B1',
        startedAt: '2026-10-20T05:00:00.000Z',
        stoppedAt: '2026-10-20T06:00:00.000Z',
      },
    ],
    'service-tables': [
      { id: 't-A3', code: 'A3' },
      { id: 't-B1', code: 'B1' },
    ],
  }
  const { default: Orders } = await load('pages/staff/orders/index.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text', Input: 'Input' },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': {
      StaffScreen: 'Screen',
      useStaffQuery: (key: string[]) => ({ data: byKey[key[0]], refresh() {} }),
      useStaffEvents: () => ({ connection: 'connected', refetchInterval: false }),
    },
    '../../../services/navigation': { navigateApp: (...args) => calls.push(args) },
    '../../../services/format': { ...(await load('services/format.ts')), money: String },
    '../../../services/reservations': { storeClock: (value) => `C(${value})` },
    '../../../services/staff': { staffApi: {} },
    './index.scss': {},
  })
  const groups = () => nodes(h.render(Orders), (n) => n.props.className === 'staff-orders-group')
  const tables = (group) => nodes(group, (n) => n.props.className === 'staff-order-table').map(label)
  let [ready, timing] = groups()
  assert.equal(label(nodes(ready, (n) => n.props.className === 'staff-orders-title')[0]), '可以收了 · 2')
  assert.equal(label(nodes(timing, (n) => n.props.className === 'staff-orders-title')[0]), '还在计时 · 1')
  // 已停表的、没有计时的（部分付款）在「可以收了」，按桌号排，没桌的排最后
  assert.deepEqual(tables(ready), ['B1', '无桌'])
  assert.deepEqual(tables(timing), ['A3'])
  const [stopped, partial] = nodes(ready, (n) => n.props.className === 'staff-order')
  assert.ok(label(stopped).includes('散客 · C(2026-10-20T05:00:00.000Z) 开始'), label(stopped))
  assert.ok(label(stopped).includes('1 小时 ×1、豆子 ×2 · 共 3 项'), label(stopped))
  assert.ok(label(partial).includes('部分付款 · 还差') && label(partial).includes('3000'), label(partial))
  assert.match(
    nodes(partial, (n) => n.type === 'Button')[0].props.ariaLabel,
    /^去收款，订单 cccccccc，部分付款，还差 30\.00 元$/,
  )
  const running = nodes(timing, (n) => n.props.className === 'staff-order')[0]
  assert.ok(label(running).includes('小林 · C(2026-10-20T06:00:00.000Z) 开始'), label(running))
  const pay = nodes(running, (n) => n.type === 'Button')[0]
  assert.equal(pay.props.className, 'staff-order-button ')
  pay.props.onClick()
  assert.deepEqual(calls.at(-1), ['/pages/staff/checkout/index?id=bbbbbbbb-2', true])

  // 搜索按桌号、顾客、订单编号、商品名
  const tree = h.render(Orders)
  assert.equal(tree.props.title, '待结账')
  assert.ok(label(tree).includes('电脑后台'), '要说清历史订单和退款去哪了')
  nodes(tree, (n) => n.type === 'Input')[0].props.onInput({ detail: { value: 'b1' } })
  ;[ready, timing] = groups()
  assert.deepEqual(tables(ready), ['B1'])
  assert.ok(label(timing).includes('没有还在计时的待结账单'))
  nodes(h.render(Orders), (n) => n.type === 'Input')[0].props.onInput({ detail: { value: '小林' } })
  ;[ready, timing] = groups()
  assert.ok(label(ready).includes('没有匹配的订单'))
  assert.deepEqual(tables(timing), ['A3'])
})

// 员工找顾客 / 会员的共用列表：结果来自服务端（useServerSearch），这里只验证摆法。
async function accountSearch(result) {
  const h = hooks()
  const searches: any[] = []
  const { AccountSearch } = await load('components/staff/account-search.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '../button': { Button: 'Button' },
    '../staff': { Field: 'Field' },
    '../pagination': { PageControls: 'Pages' },
    '../../services/staff': { staffApi: { searchAccounts: async () => ({ items: [], total: 0, page: 1 }) } },
    '../../hooks/server-search': {
      useServerSearch: (_resource, read, keyword, options) => {
        searches.push({ read, keyword, ...options })
        return { retry() {}, ...result }
      },
    },
  })
  return { render: (props) => h.render(() => AccountSearch(props)), searches }
}

test('the shared account search lists the guest choice, keeps the chosen one visible and says when it cut the list', async () => {
  const picked: any[] = []
  const loads: any[] = []
  const view = await accountSearch({
    items: [{ id: 'a1', nickname: '小林', phoneMasked: '138****8000' }],
    total: 30,
    page: 1,
    loading: false,
    error: '',
    ready: true,
  })
  const props = {
    guest: true,
    limit: 8,
    keyword: '林',
    onKeyword() {},
    selected: { id: 'old', nickname: '老顾客', phoneMasked: '139****0000' },
    onSelect: (value) => picked.push(value),
    load: async (...args) => loads.push(args),
  }
  const tree = view.render(props)
  const rows = nodes(tree, (n) => n.type === 'Button')
  assert.deepEqual(
    rows.map((row) => label(row)),
    ['散客不关联账户', '老顾客139****0000', '小林138****8000'],
    '散客在最前；换了关键字后不在结果里的已选顾客仍钉在列表里',
  )
  assert.match(label(tree), /共 30 位，只列出前 1 位/)
  rows[0].props.onClick()
  rows[2].props.onClick()
  assert.equal(picked[0], null, '选散客就是不关联账户')
  assert.equal(picked[1].id, 'a1')
  // 一次只要 limit 位
  await view.searches.at(-1).read('林', 1)
  assert.deepEqual(loads[0], ['林', 1, 8])
})

test('the paged member list turns pages on the server and goes back to page one on a new keyword', async () => {
  const view = await accountSearch({ items: [], total: 45, page: 2, loading: false, error: '', ready: true })
  const typed: any[] = []
  const props = { paged: true, keyword: '', onKeyword: (v) => typed.push(v), selected: null, onSelect() {} }
  let tree = view.render(props)
  const pager = nodes(tree, (n) => n.type === 'Pages')[0]
  assert.equal(pager.props.page, 1, '页码以服务端返回的为准（从 0 起给翻页控件）')
  assert.equal(pager.props.total, 45)
  pager.props.onChange(2)
  view.render(props)
  assert.equal(view.searches.at(-1).page, 3)
  tree = view.render(props)
  nodes(tree, (n) => n.type === 'Field')[0].props.onChange('林')
  view.render({ ...props, keyword: '林' })
  assert.equal(view.searches.at(-1).page, 1)
  assert.deepEqual(typed, ['林'])
  assert.match(label(tree), /没有匹配|还没有注册/, '一页都没有时要说清楚')
})
