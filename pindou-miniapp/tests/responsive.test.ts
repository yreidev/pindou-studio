import assert from 'node:assert/strict'
import { test } from 'vitest'
import layout from '../../layout/store-layout.json'
import { load } from './helpers/load'
import { label as text, nodes, settle } from './helpers/tree'
import { billingMock } from './helpers/billing'

// TEST-RESPONSIVE-001: platform events and component handlers, without a browser.
function hooks() {
  const slots: any[] = [],
    cleanups: any[] = []
  let cursor = 0,
    effects: any[] = []
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
    useMemo(factory: () => any) {
      return factory()
    },
    useEffect(effect: () => any, deps: any[]) {
      const i = cursor++
      if (!slots[i] || deps.some((value, j) => !Object.is(value, slots[i][j]))) {
        effects.push(() => {
          cleanups[i]?.()
          cleanups[i] = effect()
        })
        slots[i] = deps
      }
    },
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      const tree = fn()
      const pending = effects
      effects = []
      pending.forEach((effect) => effect())
      return tree
    },
    unmount() {
      cleanups.forEach((cleanup) => cleanup?.())
    },
  }
}
const classNodes = (tree, name) => nodes(tree, (node) => (node.props?.className || '').split(' ').includes(name))
const components = {
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Input: 'Input',
  Picker: 'Picker',
  MovableArea: 'MovableArea',
  MovableView: 'MovableView',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
}
const navigation = await load('services/staff-navigation.ts')

test('desktop destinations isolate roles and task pages select their parent section', () => {
  assert.equal(navigation.staffDestinations([]).length, 0)
  // 三个员工角色看到同一套现场入口；订单退款、商品资料、盘点、权限、报表、桌码在电脑后台。
  // 收货入库 2026-10-06 回到手机（货到时扫条码），店员也有
  for (const role of ['clerk', 'manager', 'owner']) {
    const pages = Array.from(navigation.staffDestinations([role]), (item: any) => item.page)
    assert.deepEqual(pages, ['workbench', 'tables', 'reservations', 'membership', 'orders', 'receiving', 'web-login'])
    for (const moved of ['inventory', 'operations', 'roles', 'table-codes'])
      assert.ok(!pages.includes(moved), `${moved} 已搬去电脑后台`)
    // 连电脑（扫码登录、手机当扫码枪）是偶尔用一次的，不占底部四格
    assert.ok(pages.indexOf('web-login') >= 4, `连电脑不该占常驻标签位：${pages.join(',')}`)
    assert.ok(pages.indexOf('receiving') >= 4, `收货入库不该占常驻标签位：${pages.join(',')}`)
  }
  assert.equal(navigation.activeStaffPage('/pages/staff/checkout/index'), 'orders')
  assert.equal(navigation.activeStaffPage('pages/staff/booking/index'), 'reservations', '代客登记归在预约下')
  assert.equal(navigation.activeStaffPage('/pages/profile/index'), '')
})

test('window resizing uses logical width, crosses both directions, and removes only its listener', async () => {
  const h = hooks(),
    listeners = new Set<() => void>(),
    unrelated = () => {}
  let width = 390,
    unavailable = false
  listeners.add(unrelated)
  const { useWideLayout, isWideWindow } = await load('hooks/viewport.ts', {
    react: h.api,
    '@tarojs/taro': {
      default: {
        getWindowInfo() {
          if (unavailable) throw new Error('not ready')
          return { windowWidth: width }
        },
        onWindowResize: (callback) => listeners.add(callback),
        offWindowResize: (callback) => listeners.delete(callback),
      },
    },
  })
  for (const [value, expected] of [
    [390, false],
    [820, false],
    [1023, false],
    [1024, true],
    [1280, true],
    [1440, true],
    [NaN, false],
  ])
    assert.equal(isWideWindow(value), expected)
  assert.equal(h.render(useWideLayout), false)
  for (const [value, expected] of [
    [1280, true],
    [820, false],
    [1024, true],
    [390, false],
  ] as [number, boolean][]) {
    width = value
    listeners.forEach((callback) => callback())
    assert.equal(h.render(useWideLayout), expected)
    assert.equal(listeners.size, 2)
  }
  unavailable = true
  listeners.forEach((callback) => callback())
  assert.equal(h.render(useWideLayout), false)
  h.unmount()
  assert.deepEqual([...listeners], [unrelated])
})

test('custom header remeasures the native capsule on resize and accepts a zero desktop status bar', async () => {
  const h = hooks(),
    listeners = new Set<() => void>(),
    statusText: string[] = []
  let top = 0,
    capsule = { top: 8, height: 32 }
  const { Screen } = await load('components/customer/index.tsx', {
    '../developer-status': { DeveloperStatus: 'DeveloperStatus' },
    react: h.api,
    '@tarojs/components': components,
    '../button': { Button: 'Button' },
    '@tarojs/taro': {
      default: {
        getWindowInfo: () => ({ statusBarHeight: top }),
        getMenuButtonBoundingClientRect: () => capsule,
        onWindowResize: (cb) => listeners.add(cb),
        offWindowResize: (cb) => listeners.delete(cb),
        setNavigationBarColor: ({ frontColor }) => statusText.push(frontColor),
      },
    },
    '../../hooks/customer': {},
    '../../services/navigation': {},
    '../../services/customer': {},
    '../../services/format': {},
    './assets': { assets: {} },
  })
  let tree = h.render(() => Screen({ title: '工作台' }))
  assert.equal(classNodes(tree, 'navbar')[0].props.style.paddingTop, '0px')
  top = 24
  capsule = { top: 32, height: 32 }
  listeners.forEach((cb) => cb())
  tree = h.render(() => Screen({ title: '工作台' }))
  assert.equal(classNodes(tree, 'navbar')[0].props.style.paddingTop, '24px')
  assert.equal(classNodes(tree, 'navbar-content')[0].props.style.minHeight, '48px')
  // 状态栏的字跟着顶栏：浅色顶栏黑字，换成深色顶栏时换白字
  h.render(() => Screen({ title: '工作台', dark: true }))
  assert.deepEqual(statusText, ['#000000', '#ffffff'])
  h.unmount()
  assert.equal(listeners.size, 0)
})

test('sidebar navigation retains dirty and submitting guards, including the active parent of a task page', async () => {
  const h = hooks(),
    calls: any[] = []
  let dirty = true,
    busy = false,
    confirmed = false
  const taro = {
    getCurrentPages: () => [{ route: 'pages/staff/checkout/index' }],
    showModal: async () => ({ confirm: confirmed }),
    showToast: () => {},
    redirectTo: async ({ url }) => calls.push(url),
    switchTab: async ({ url }) => calls.push(url),
  }
  const transport = await load('services/navigation.ts', { '@tarojs/taro': { default: taro } })
  transport.registerLeaveGuard('/pages/staff/checkout/index', () => ({ dirty, busy }))
  const { StaffNav } = await load('components/staff.tsx', {
    react: h.api,
    '@tarojs/components': components,
    './button': { Button: 'Button' },
    '@tarojs/taro': { default: taro, useRouter: () => ({ path: 'pages/staff/checkout/index' }) },
    '../hooks/customer': { useCustomer: () => ({ account: { roles: ['clerk'], nickname: '店员' } }) },
    '../services/format': await load('services/format.ts'),
    '../hooks/viewport': { useWideLayout: () => true },
    '../services/staff-navigation': navigation,
    '../hooks/billing': billingMock(),
    './customer': {},
    '../services/staff': {},
    '../hooks/query': {},
    '../hooks/staff-overview': {
      useStaffOverview: () => ({ data: null }),
      useOpenServiceCalls: () => ({ data: [] }),
      staffBadges: () => ({}),
    },
    '../hooks/clock': { useNow: () => 0 },
    '../services/navigation': transport,
  })
  const tree = h.render(StaffNav),
    sidebar = classNodes(tree, 'staff-sidebar')[0]
  assert.equal(classNodes(sidebar, 'staff-sidebar-item').length, 7)
  assert.deepEqual(classNodes(tree, 'staff-nav-item').map(text), ['现场', '桌位', '预约', '会员'], '手机底部四格')
  const orders = classNodes(sidebar, 'staff-sidebar-current')[0]
  assert.equal(text(orders), '待结账')
  orders.props.onClick()
  await settle()
  assert.equal(calls.length, 0)
  confirmed = true
  busy = true
  orders.props.onClick()
  await settle()
  assert.equal(calls.length, 0)
  busy = false
  orders.props.onClick()
  await settle()
  assert.deepEqual(calls, ['/pages/staff/orders/index'])
  confirmed = false
  classNodes(sidebar, 'staff-sidebar-return')[0].props.onClick()
  await settle()
  assert.equal(calls.length, 1)
  dirty = false
  classNodes(sidebar, 'staff-sidebar-return')[0].props.onClick()
  await settle()
  assert.equal(calls.at(-1), '/pages/index/index')
})

// 桌位页：默认平面图、点位置从底部弹出开台或会话、停用只在列表里且只发 enabled。
//
// ★★ 2026-09-19 重排前这一页是「布局管理」工具（建区域、拖格子、改座位数、按平面图同步），
//    那些已整块删除。按店员真实用法重排成：默认平面图、一行四项筛选（带张数）、点图直接开台、
//    停用收进列表方块下面的小按钮。2026-10-20 起开台、会话是这一页的底部弹层，不再跳页。
test('the tables page defaults to the plan, opens a sheet on tap and keeps disable out of the way', async () => {
  const h = hooks()
  const patches: any[] = []
  const modals: any[] = []
  let answer = true
  const tables = layout.tables.map((table) => ({
    id: `db-${table.code}`,
    code: table.code,
    zone: table.zone,
    floorAreaId: `area-${table.zone}`,
    number: table.number,
    seatCount: table.seatCount,
    wholeTable: table.wholeTable,
    // B3 停用、C1 整桌使用中、A2 按座使用中、A4 停止计时等结账（停的时候已超时），其余空闲 —— 让筛选和着色都有得验
    enabled: table.code !== 'B3',
    occupancy: ['C1', 'A2', 'A4'].includes(table.code) ? 'occupied' : 'idle',
    seatBased: table.code === 'A2',
    ...(table.code === 'A4' ? { stopped: true, timingStatus: 'overdue' } : {}),
  }))
  const { default: Tables } = await load('pages/staff/tables/index.tsx', {
    '../../hooks/billing': billingMock(),
    react: h.api,
    '@tarojs/components': components,
    '../../../components/button': { Button: 'Button' },
    '../../../services/seatmap': await load('services/seatmap.ts'),
    '@tarojs/taro': {
      default: {
        showModal: async (option) => {
          modals.push(option)
          return { confirm: answer }
        },
        showToast: () => {},
      },
      useRouter: () => ({ params: {} }),
    },
    '../../../components/staff': {
      StaffScreen: 'StaffScreen',
      useStaffEvents: () => ({ connection: 'connected', refetchInterval: 30000 }),
      useStaffQuery: (key: string[]) =>
        key[0] === 'service-tables'
          ? { data: tables, loading: false, refresh: () => {} }
          : { data: [], loading: false, refresh: () => {} },
    },
    '../../../components/staff/table-sheet': { TableSheet: 'TableSheet' },
    '../../../hooks/clock': { useNow: () => Date.now() },
    '../../../services/staff': {
      staffApi: {
        listTables: async () => tables,
        listLiveSessions: async () => [],
        updateTable: async (id, body) => {
          patches.push([id, body])
        },
      },
      staffMessage: String,
    },
    '../../../hooks/customer': { useCustomer: () => ({ account: { roles: ['owner'] } }) },
  })
  let tree = h.render(Tables)

  // 默认就是平面图：每个位置全画出来，列表不在
  const hits = classNodes(tree, 'tables-hit')
  assert.equal(hits.length, layout.tables.length, '默认视图是平面图，每个位置都要画')
  assert.equal(classNodes(tree, 'table-tile').length, 0, '默认不该是列表')
  // 筛选只有一行四项，带张数；不再有区域筛选
  const free = layout.tables.length - 4
  assert.deepEqual(classNodes(tree, 'tables-filter').map(text), [
    `全部 ${layout.tables.length}`,
    `空闲 ${free}`,
    '使用中 3',
    '需关注 1',
  ])
  // 状态着色：空闲绿、使用中深色、停用斜纹
  const hit = (code: string) => classNodes(h.render(Tables), 'tables-hit').find((n) => text(n).startsWith(code))!
  assert.ok(hit('A1').props.className.includes('tables-hit-free'))
  assert.ok(hit('C1').props.className.includes('tables-hit-busy'))
  assert.ok(hit('B3').props.className.includes('tables-hit-off'))
  assert.match(text(hit('A4')), /停/, '停了表的写「停」，不按停止那一刻的超时催')

  // 点图上一个位置 = 从底部弹出这张桌（空的开台、使用中的看会话），一步到位；按座使用中的也一样
  const sheet = () => nodes(h.render(Tables), (n) => n.type === 'TableSheet')[0]
  for (const code of ['A1', 'C1', 'A2']) {
    hit(code).props.onClick()
    assert.equal(sheet()?.props.table.id, `db-${code}`, code)
    sheet().props.onClose()
    assert.equal(sheet(), undefined)
  }
  // 点停用的 = 问要不要启用（弹窗默认确认），发的是 enabled:true
  hit('B3').props.onClick()
  await settle()
  assert.equal(patches.length, 1)
  assert.equal(patches[0][0], 'db-B3')
  assert.deepEqual(Object.keys(patches[0][1]), ['enabled'], '只能发 enabled，多一个字段后端就 400')
  assert.equal(patches[0][1].enabled, true)
  assert.equal(sheet(), undefined, '停用的桌不弹开台')

  // 筛「空闲」：停用和使用中的位置压暗且不可点
  classNodes(tree, 'tables-filter')
    .find((n) => text(n).startsWith('空闲'))!
    .props.onClick()
  tree = h.render(Tables)
  const dimmed = classNodes(tree, 'tables-hit').filter((n) => n.props.className.includes('tables-hit-dim'))
  assert.equal(dimmed.length, 4, 'B3（停用）与 C1、A2、A4（使用中）该被压暗')
  assert.ok(
    dimmed.every((n) => n.props.disabled),
    '压暗的位置不可点',
  )

  // ★「需关注」要把**已停用**也算进去。店员扫一眼这个筛选就该看到所有「不正常」的桌：
  //   超时、快到期、停用。停用若不在里面，一张坏桌可以在图上躺很久没人发现 ——
  //   顾客那边它是不可选的，员工端却没有任何一个视图会把它单独拎出来。
  classNodes(tree, 'tables-filter')
    .find((n) => text(n).startsWith('需关注'))!
    .props.onClick()
  tree = h.render(Tables)
  const flagged = classNodes(tree, 'tables-hit').filter((n) => !n.props.className.includes('tables-hit-dim'))
  assert.deepEqual(
    flagged.map((n) => n.props.ariaLabel.split('，')[0]).sort(),
    ['B3'],
    '「需关注」要包含已停用的 B3（C1 只是使用中，A4 停止计时等结账、不再按停止那一刻的超时催，都不算）',
  )

  // 切到列表：紧凑方块，停用/启用是方块下面的小按钮，不和开台并排
  classNodes(tree, 'tables-filter')
    .find((n) => text(n).startsWith('全部'))!
    .props.onClick()
  nodes(h.render(Tables), (n) => n.type === 'Button' && text(n).startsWith('看列表'))[0].props.onClick()
  tree = h.render(Tables)
  assert.equal(classNodes(tree, 'table-tile').length, layout.tables.length)
  assert.equal(classNodes(tree, 'tables-hit').length, 0)
  const toggles = classNodes(tree, 'table-toggle')
  assert.equal(toggles.length, layout.tables.length, '老板每张桌都有停用/启用')
  // 已停用的那张写「启用」，其余写「停用」
  const tiles = classNodes(tree, 'table-tile')
  const at = (code) => tiles.findIndex((tile) => text(tile).startsWith(code))
  assert.ok(at('B3') >= 0, '列表里应当有 B3')
  assert.equal(text(toggles[at('B3')]), '启用', 'B3 已停用，按钮该写「启用」')
  assert.equal(text(toggles[at('A1')]), '停用')
  // 停止计时等结账的桌写「待结账」，不写停止那一刻的「已超时」
  assert.match(text(tiles[at('A4')]), /待结账/)
  assert.doesNotMatch(text(tiles[at('A4')]), /已超时/)

  // 停用先问一句（2026-10-27 起）：停了就开不了台、约不了，点错了顾客当场坐不下；点「再看看」什么都不发
  answer = false
  toggles[at('A1')].props.onClick()
  await settle()
  assert.equal(patches.length, 1, '点「再看看」不停用')
  assert.equal(modals.at(-1).title, '停用 A1？')
  assert.deepEqual([modals.at(-1).confirmText, modals.at(-1).cancelText], ['停用', '再看看'])
  answer = true
  classNodes(h.render(Tables), 'table-toggle')[at('A1')].props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(patches.at(-1))), ['db-A1', { enabled: false }])
  h.unmount()
})
