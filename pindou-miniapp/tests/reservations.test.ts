import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import storeLayout from '../../layout/store-layout.json'
import { load } from './helpers/load'
import { expandNamed, nodes as findNodes, label as text, settle } from './helpers/tree'
import { billingMock } from './helpers/billing'
import { expandSheets, sheetModule } from './helpers/sheet'

// 门店桌位夹具：布局固定之后，库里就是 layout/store-layout.json 里那 20 张
// （后端 ReconcileLayout 启动时保证）。测试不必再自己拼一套。
const layoutTables = (overrides: Record<string, any> = {}) =>
  storeLayout.tables.map((table) => ({
    id: `db-${table.code}`,
    code: table.code,
    zone: table.zone,
    number: table.number,
    seatCount: table.seatCount,
    wholeTable: table.wholeTable,
    occupiedSeats: [],
    floorAreaId: `area-${table.zone.toLowerCase()}`,
    floorAreaName: `${table.zone} 区`,
    ...(overrides[table.code] || {}),
  }))

// 页面里的定时器不真的走时间，由测试显式推进，
// 这样「依赖里忘了放时间」这类缺陷才有办法在测试里暴露。
// 只接管 setInterval（页面每分钟推一次的计时）；setImmediate、setTimeout、Date 照常。
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
const advance = () => vi.advanceTimersByTime(60000)

function hooks() {
  const slots: any[] = []
  let cursor = 0,
    effects: any[] = []
  const api = {
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === 'function' ? next(slots[i]) : next
        },
      ]
    },
    useRef(initial) {
      return api.useState(() => ({ current: initial }))[0]
    },
    useMemo(factory, deps) {
      const i = cursor++
      const cell = slots[i]
      if (!cell || !deps || cell.deps.length !== deps.length || deps.some((v, j) => !Object.is(v, cell.deps[j]))) {
        slots[i] = { deps: deps || [], value: factory() }
      }
      return slots[i].value
    },
    useEffect(effect, deps) {
      const i = cursor++
      if (!slots[i] || deps.some((value, j) => !Object.is(value, slots[i][j]))) {
        effects.push(effect)
        slots[i] = deps
      }
    },
  }
  return {
    api,
    render(fn) {
      cursor = 0
      const tree = fn()
      const pending = effects
      effects = []
      pending.forEach((effect) => effect())
      return tree
    },
  }
}
// 找到的节点按 any 用：用例里直接 .find(...).props.onClick()，找不到就让它当场报错
const nodes = (tree, predicate: (node: any) => boolean): any[] => findNodes(tree, predicate)
const buttons = (tree) => nodes(tree, (node) => node.type === 'Button')
const components = {
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  Input: 'Input',
  Picker: 'Picker',
  Textarea: 'Textarea',
  Switch: 'Switch',
}
const service = await load('services/reservations.ts', {
  './customer': { CustomerError: class extends Error {} },
  './staff': { request: async () => ({}) },
  './format': await load('services/format.ts'),
})
const settings = {
  enabled: true,
  openMinute: 540,
  closeMinute: 1320,
  slotMinutes: 30,
  advanceDays: 7,
  leadMinutes: 30,
  graceMinutes: 30,
}

// The shop keeps one set of opening hours; a device left on another timezone
// must still see and book those hours, not its own.
test('store slots follow the shop timezone whatever the device is set to', () => {
  const day = { year: 2026, month: 9, day: 14 }
  assert.equal(service.storeInstant(day, 14 * 60).toISOString(), '2026-09-14T06:00:00.000Z')
  assert.equal(service.storeInstant(day, 9 * 60).toISOString(), '2026-09-14T01:00:00.000Z')
  assert.equal(service.storeClock('2026-09-14T06:00:00.000Z'), '14:00')
  assert.equal(service.storeStamp('2026-09-13T23:30:00.000Z'), '09-14 07:30')
  assert.equal(service.minuteLabel(1320), '22:00')
  // A booking made just before midnight UTC still belongs to the next shop day.
  assert.equal(service.storeDayLabel('2026-09-13T16:00:00.000Z'), '09-14')
})

// 按日期查已结束的预约：哪天算今天、昨天按门店时区。门店 10-06 凌晨 1 点时，UTC 还是 10-05，
// 跟着手机（或 UTC）走就会把 10-05 叫成「今天」。
test('the ended-booking date filter names days by the store calendar, not the device one', () => {
  const now = new Date('2026-10-05T17:00:00.000Z') // 门店 2026-10-06 01:00
  assert.equal(service.isoDate(service.storeDate(0, now)), '2026-10-06')
  assert.equal(service.isoDate(service.storeDate(-1, now)), '2026-10-05')
  assert.equal(service.isoDate(service.storeDate(-6, now)), '2026-09-30', '跨月往回数')
  assert.deepEqual({ ...service.parseDate('2026-10-05') }, { year: 2026, month: 10, day: 5 })
  assert.equal(service.relativeDayLabel('2026-10-06', now), '10-06 周二 · 今天')
  assert.equal(service.relativeDayLabel('2026-10-05', now), '10-05 周一 · 昨天')
  assert.equal(service.relativeDayLabel('2026-10-04', now), '10-04 周日')
  assert.equal(service.relativeDayLabel('2026-10-08', now), '10-08 周四 · 后天')
  assert.equal(service.relativeDayLabel('2026-10-12', now), '10-12 周一')
})

test('open slots respect opening hours, package length and the lead time', () => {
  const now = new Date('2026-09-14T02:00:00.000Z')
  const slots = service.openSlots(settings, { year: 2026, month: 9, day: 14 }, 180, now)
  const clocks = slots.map(service.storeClock)
  assert.equal(
    clocks[0],
    '11:00',
    'the first slot must be strictly past the 30 minute lead time, as the API also requires',
  )
  assert.equal(clocks.at(-1), '19:00', 'a 180 minute package must finish by 22:00')
  assert.ok(!clocks.includes('10:15'), 'slots follow the configured grid')
  assert.equal(service.openSlots(settings, { year: 2026, month: 9, day: 14 }, 0, now).length, 0)
})

test('a seat is only free when no held window overlaps the requested one', () => {
  const busy = [
    { serviceTableId: 'db-B1', seatNumber: 1, startAt: '2026-09-14T06:00:00.000Z', endAt: '2026-09-14T09:00:00.000Z' },
  ]
  const free = (seat, iso) => service.seatFree(busy, 'db-B1', seat, new Date(iso), 180)
  assert.equal(free(1, '2026-09-14T07:00:00.000Z'), false)
  assert.equal(free(1, '2026-09-14T09:00:00.000Z'), true, 'a window starting when the previous one ends is free')
  assert.equal(free(2, '2026-09-14T07:00:00.000Z'), true, 'another seat is unaffected')
  assert.equal(service.seatFree(busy, 't2', 1, new Date('2026-09-14T07:00:00.000Z'), 180), true)
})

test('an unknown result reuses one idempotency key and different actions do not share it', async () => {
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
      return { statusCode: 200, data: { reservations: [] } }
    },
  }
  const staff = await load('services/staff.ts', { '@tarojs/taro': { default: taro } })
  const client = await load('services/reservations.ts', {
    './customer': await load('services/customer.ts'),
    './staff': staff,
    './format': await load('services/format.ts'),
  })
  const input = {
    action: 'book',
    serviceTableId: 'db-B1',
    seatNumber: 1,
    packageId: 'pkg',
    startAt: '2026-09-14T06:00:00.000Z',
  }
  await assert.rejects(client.reservations.action(input))
  await client.reservations.action(input)
  assert.equal(calls[0].header['Idempotency-Key'], calls[1].header['Idempotency-Key'])
  await client.reservations.action({ ...input, action: 'cancel' })
  assert.notEqual(calls[2].header['Idempotency-Key'], calls[1].header['Idempotency-Key'])
})

// 「我的预约」与选座页共用同一份 reservations.me 数据。内容在 components/customer/my-reservations.tsx：
// 独立的「我的预约」页和收费关着时的底部第二格都渲染它，这里直接测内容。
// 取消用的弹层（cancel-reservation-sheet）和它的外壳在树里就地摊开，用例直接点里面的按钮。
async function myReservationsPage(
  view,
  submitted: any[] = [],
  billing = true,
  extra: Record<string, unknown> = {},
  refresh: () => Promise<void> = async () => {},
) {
  const h = hooks()
  const { MyReservationsContent: MyReservations } = await load('components/customer/my-reservations.tsx', {
    '../../hooks/billing': billingMock(billing),
    react: h.api,
    '@tarojs/components': components,
    '@tarojs/taro': { default: { navigateTo: async () => {}, showToast: async () => {} } },
    '../../components/button': { Button: 'Button' },
    '../sheet': sheetModule,
    '../../components/customer': Object.fromEntries(
      ['AuthBoundary', 'Failure', 'RefreshNotice', 'Screen', 'SectionEmpty', 'Skeleton'].map((name) => [name, name]),
    ),
    '../../hooks/query': {
      useCustomerQuery: () => ({ loading: false, data: view, error: null, refresh }),
    },
    '../../services/format': {
      money: (cents) => (cents / 100).toFixed(2),
      moneyText: (cents) => (cents / 100).toFixed(2),
      storeOffsetMinutes: 8 * 60,
    },
    '../../services/reservations': {
      ...service,
      reservations: {
        me: async () => view,
        action: async (input) => {
          submitted.push(input)
        },
      },
    },
    ...extra,
  })
  return {
    render: () => expandNamed(h.render(MyReservations), ['CancelReservationSheet', 'SheetFrame']),
    submitted,
  }
}

let modalAnswer = true
// serviceOverrides：替换 services/reservations 里的个别函数（比如让 openSlots 对「今天」返回空），
// 用来摆出真实时钟摆不出来的局面，而不必去动 Date。
// options.action 换掉提交（比如让它被后端拒绝）；options.taro 补上页面用到的其他 Taro 接口。
async function customerPage(
  view,
  submitted: any[] = [],
  serviceOverrides = {},
  options: {
    action?: (input: any) => Promise<unknown>
    taro?: Record<string, unknown>
    billing?: boolean
    params?: Record<string, string>
    /** 其余要换掉的依赖（比如 services/notices）。 */
    mocks?: Record<string, unknown>
  } = {},
) {
  const h = hooks()
  // 页面登记的转发处理（右上角「转发」时微信调它）
  const share: { card?: () => { title: string; path: string } } = {}
  const { default: Reservations } = await load('pages/customer/reservations/index.tsx', {
    '../../hooks/billing': billingMock(options.billing ?? true),
    react: h.api,
    '@tarojs/components': components,
    // 提交前会弹「预约须知」，测试里默认点确认；要测「再想想」时改 modalAnswer
    '@tarojs/taro': {
      default: { showModal: async () => ({ confirm: modalAnswer }), ...options.taro },
      useRouter: () => ({ params: options.params ?? {} }),
      useShareAppMessage: (fn: () => { title: string; path: string }) => (share.card = fn),
    },
    '../../components/button': { Button: 'Button' },
    '../../components/customer': Object.fromEntries(
      ['AuthBoundary', 'Failure', 'RefreshNotice', 'Screen', 'SectionEmpty', 'Skeleton', 'Status'].map((name) => [
        name,
        name,
      ]),
    ),
    '../../hooks/query': {
      useCustomerQuery: () => ({ loading: false, data: view, error: null, refresh: async () => {} }),
    },
    '../../services/format': {
      money: (cents) => (cents / 100).toFixed(2),
      moneyText: (cents) => (cents / 100).toFixed(2),
      storeOffsetMinutes: 8 * 60,
    },
    // 用真实的对照表：门店桌位对不上平面图时页面必须退回桌位列表，这正是下面几条要验的。
    '../../services/seatmap': await load('services/seatmap.ts'),
    // 标题与标语走真实的品牌文案，字体子集测试也是从这里取字
    '../../brand': await load('brand.ts'),
    '../../services/reservations': {
      ...service,
      ...serviceOverrides,
      reservations: {
        me: async () => view,
        action:
          options.action ??
          (async (input) => {
            submitted.push(input)
          }),
      },
    },
    '../../../components/sheet': sheetModule,
    ...options.mocks,
  })
  return { render: () => expandSheets(h.render(Reservations)), submitted, share: () => share.card!() }
}
const pack = { id: 'pkg', kind: 'package', name: '三小时', durationMinutes: 180, amountCents: 10000 }
// 被别人占住整段时间的座位：B1（单座）。图上它不会出现可点的热区。
const held = {
  serviceTableId: 'db-B1',
  seatNumber: 1,
  startAt: '2026-01-01T00:00:00.000Z',
  endAt: '2099-01-01T00:00:00.000Z',
}

const cls = (node) => node.props?.className || ''
const dayButtons = (tree) => buttons(tree).filter((node) => cls(node).split(' ').includes('plan-day'))
const slotButtons = (tree) => buttons(tree).filter((node) => cls(node).split(' ').includes('plan-slot'))
/**
 * 在「几点开始」里点一个时段（默认第一个还有空的；给了 start 就点那个钟点）。
 * 2026-10-20 起先选坐多久、几点开始，图上才框出那时空着、可以点的座位。
 */
const pickSlot = (page, start?: string) => {
  const slot = slotButtons(page.render()).find(
    (node) => !node.props.disabled && (!start || text(node).startsWith(start)),
  )
  assert.ok(slot, `找不到能点的时段 ${start || ''}`)
  slot.props.onClick()
  return slot
}
const submitButton = (tree) => buttons(tree).find((node) => text(node) === '提交预约')

test('a customer books a free seat on the plan and never sees a held one as available', async () => {
  const submitted: any[] = []
  const page = await customerPage(
    {
      reservations: [],
      busy: [held],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    submitted,
  )
  let tree = page.render()
  // ★ 先换到明天再断言：今天还剩几个时段取决于测试运行的钟点，
  //   傍晚跑的话今天一个可约时段都没有，整张图会全是灰的。
  const strip = dayButtons(tree)
  assert.equal(strip.length, settings.advanceDays, '七天一行，含今天')
  strip[1].props.onClick()
  const slot = pickSlot(page)
  tree = page.render()

  // ★ 图上只给**这个时段还空着**的位置画可点热区，被占满的干脆不渲染按钮 ——
  //   比渲染一个 disabled 的按钮更清楚，顾客不会反复去戳一个点不动的东西。
  //   held 覆盖 2026→2099，B1 永远被占，所以是 20 个而不是 21 个。
  const hits = buttons(tree).filter((node) => cls(node).includes('seatmap-hit'))
  assert.equal(hits.length, 20, '被占满的 B1 不该出现可点热区')
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('B1')),
    false,
    '被别人占着的位置不能让顾客点开',
  )
  // 图上仍然画着 21 个位置，只是 B1 压成已约满：顾客看得见它存在。
  assert.equal(nodes(tree, (node) => cls(node).includes('seatmap-mark')).length, 21)
  assert.equal(nodes(tree, (node) => cls(node).includes('seatmap-mark-pick')).length, 20, '空着的框金边')

  hits.find((node) => (node.props.ariaLabel || '').startsWith('B2')).props.onClick()
  tree = page.render()

  // 确认层指向刚点的那个位置和顶上选的那一天；里面没有第二条日期、也没有第二套时段
  const sheet = nodes(tree, (node) => cls(node) === 'plan-sheet')[0]
  assert.ok(sheet, '点座位后应弹出确认层')
  assert.ok(text(sheet).includes('B2'))
  assert.ok(text(sheet).includes('明天'), '确认层要写明是哪一天')
  assert.equal(dayButtons(sheet).length, 0, '确认层里不该再有一条日期')
  assert.equal(slotButtons(sheet).length, 0, '时段在页面上选好了，确认层里不再选')

  submitButton(page.render()).props.onClick()
  await settle()
  assert.equal(submitted.length, 1)
  const input = submitted[0]
  assert.equal(input.action, 'book')
  assert.equal(input.serviceTableId, 'db-B2')
  // ★ 顾客订的永远是 1 号座，它代表整个可约单位（双人位有 2 个物理座，后端锁全桌）。
  assert.equal(input.seatNumber, 1)
  assert.equal(input.packageId, 'pkg')
  assert.ok(text(slot).startsWith(service.storeClock(input.startAt)), '提交的开始时间就是所选时段的起点')

  // 提交成功：确认层不关，换成勾和摘要（docs/plan-interaction.md 第 3 节），点「好的」才关
  const done = nodes(page.render(), (node) => cls(node) === 'plan-sheet')[0]
  assert.ok(nodes(done, (node) => node.type?.name === 'DoneMark').length, '画出勾')
  assert.match(text(done), /已提交，等店员确认/)
  assert.match(text(done), /B2 · \d+ 月 \d+ 日/)
  assert.ok(buttons(done).some((node) => text(node) === '看我的预约'))
  assert.equal(submitButton(page.render()), undefined, '不能再提交一次')
  buttons(done)
    .find((node) => text(node) === '好的')
    .props.onClick()
  assert.equal(nodes(page.render(), (node) => cls(node) === 'plan-sheet').length, 0)
})

test('nothing can be submitted before a slot is chosen', async () => {
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  let tree = page.render()
  assert.equal(submitButton(tree), undefined, '没点座位时不该有提交按钮')
  // 换到明天：今天还剩几个时段取决于测试运行的钟点，傍晚跑的话一个时段都没有。
  dayButtons(tree)[1].props.onClick()
  tree = page.render()
  assert.equal(hitsOf(tree).length, 0, '还没选几点开始时，图上不给点')
  assert.ok(text(tree).includes('先在上面选几点开始'), '要告诉顾客先选时间')
  pickSlot(page)
  hitsOf(page.render())[0].props.onClick()
  const submit = submitButton(page.render())
  assert.ok(submit)
  assert.equal(!!submit.props.disabled, false, '选了时段、点了座位就能提交')
})

test('a customer sees their own booking and can only cancel one that is still open', async () => {
  const entry = (status) => ({
    reservation: {
      id: `r-${status}`,
      serviceTableId: 'db-B1',
      seatNumber: 1,
      packageId: 'pkg',
      packageName: '三小时',
      durationMinutes: 180,
      amountCents: 10000,
      startAt: '2026-09-14T06:00:00.000Z',
      status,
      createdBy: 'me',
      createdAt: '2026-09-13T00:00:00.000Z',
    },
    displayStatus: status,
    endAt: '2026-09-14T09:00:00.000Z',
    tableNumber: 1,
  })
  const view = {
    reservations: [entry('confirmed'), entry('cancelled'), entry('expired')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  // 选座页不再放列表：打开就是图，我的预约在个人页单独一页
  assert.equal(text((await customerPage(view)).render()).includes('我的预约'), false, '选座页上不该出现预约列表')
  const tree = (await myReservationsPage(view)).render()
  assert.equal(buttons(tree).filter((node) => text(node) === '取消预约').length, 1)
  const body = text(tree)
  assert.ok(body.includes('已确认') && body.includes('已取消') && body.includes('已过期'))
  assert.ok(body.includes('到店后付 ¥100.00'), '预约本身不收费，只展示到店应付')
})

test('self-service booking disappears while the shop has it switched off', async () => {
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings: { ...settings, enabled: false },
    settingsVersion: 'v',
    version: 'r',
  })
  const tree = page.render()
  assert.equal(
    buttons(tree).some((node) => text(node) === '提交预约'),
    false,
  )
  assert.ok(nodes(tree, (node) => node.type === 'Status').some((node) => node.props.title === '自助预约暂未开放'))
})

// 员工「预约」页（2026-10-20 重做）：今天 / 明天 / 以后的时间线，过了时间没来的置顶成红卡；
// 每条一个主按钮（确认预约或到店了，开台），取消、爽约收进「⋯」；「代客登记」单独一页。
// modalAnswers：按顺序回答页面弹出的 showModal（取消／爽约时问原因）。每一项是 {confirm, content}；用完了就一律按「再想想」处理。
// sheetPicks：按顺序回答「⋯」弹出的 showActionSheet（tapIndex）；用完了就当顾客点了取消。
// ended：「已结束」那一页（scope=ended 的服务端分页结果）。
const minutesText = (minutes: number) =>
  minutes < 60
    ? `${minutes} 分钟`
    : minutes % 60
      ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
      : `${minutes / 60} 小时`
async function staffPage(
  view,
  submitted: any[] = [],
  modalAnswers: any[] = [],
  ended: { items: any[]; total: number; page: number } = { items: [], total: 0, page: 1 },
  sheetPicks: number[] = [],
) {
  const h = hooks()
  const asked: any[] = []
  const sheets: string[][] = []
  const pages: string[] = []
  // 页面两次 useStaffQuery：还要处理的（open）与已结束的当前页（ended + 日期 + 页码）。按查询键区分。
  // endedPages 记每次真去读的页码，endedReads 连同日期一起记（不限日期时 date 为空串）。
  const endedPages: any[] = []
  const endedReads: { page: number; date: string }[] = []
  const endedLoads: any[] = []
  const api = {
    staffOpen: async () => view,
    staffEnded: async (page, date = '') => {
      endedPages.push(page)
      endedReads.push({ page, date })
      return ended
    },
    action: async (input) => {
      submitted.push(input)
    },
  }
  const { default: StaffReservations } = await load('pages/staff/reservations/index.tsx', {
    '../../hooks/billing': billingMock(),
    react: { ...h.api, useCallback: (fn) => fn },
    '@tarojs/components': components,
    '@tarojs/taro': {
      default: {
        showModal: async (option) => {
          asked.push(option)
          return modalAnswers.shift() || { confirm: false }
        },
        showActionSheet: async ({ itemList }) => {
          sheets.push(itemList)
          if (!sheetPicks.length) throw new Error('cancel')
          return { tapIndex: sheetPicks.shift() }
        },
      },
    },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': {
      DateField: 'DateField',
      StaffScreen: 'StaffScreen',
      useStaffQuery: (key, read, options) => {
        if (key[1] === 'open') return { loading: false, data: view, error: null, refresh() {}, updatedAt: 0 }
        // 已结束的键：['reservations', 'ended', 日期或 'all', 页码]；placeholder 是翻页时留不留上一页
        endedLoads.push({ date: key[2], page: key[3], read, placeholder: options?.placeholderData })
        return { loading: false, data: ended, error: null, refresh() {}, updatedAt: 0 }
      },
      useStaffEvents: () => ({ connection: 'connected', polling: true, refetchInterval: 30000 }),
    },
    '../../../components/staff/table-sheet': { CustomerPick: 'CustomerPick', StaffSheet: 'StaffSheet', minutesText },
    '../../../components/pagination': { PageControls: 'PageControls' },
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../../hooks/query': { keepPreviousData: 'keep', useRefreshAll: () => async () => {} },
    '../../../services/format': {
      money: (cents) => (cents / 100).toFixed(2),
      moneyText: (cents) => (cents / 100).toFixed(2),
      storeOffsetMinutes: 8 * 60,
    },
    '../../../services/navigation': { navigateApp: async (url: string) => pages.push(url) },
    '../../../services/staff': { StaffError: class extends Error {} },
    '../../../services/reservations': { ...service, reservations: api },
  })
  const render = () => h.render(StaffReservations)
  // 「已结束的预约」平时收着，点开才读
  const openEnded = () =>
    buttons(render())
      .find((node) => text(node).startsWith('已结束的预约'))
      .props.onClick()
  return { render, openEnded, submitted, asked, sheets, pages, endedPages, endedReads, endedLoads }
}
const staffEntry = (id, status, accountId) => ({
  reservation: {
    id,
    accountId,
    guestName: accountId ? '' : '张阿姨',
    serviceTableId: 'db-B1',
    seatNumber: 1,
    packageId: 'pkg',
    packageName: '三小时',
    durationMinutes: 180,
    amountCents: 10000,
    startAt: '2026-09-14T06:00:00.000Z',
    status,
    createdBy: 'staff',
    createdAt: '2026-09-13T00:00:00.000Z',
  },
  displayStatus: status,
  endAt: '2026-09-14T09:00:00.000Z',
  tableNumber: 1,
  customerName: accountId ? '顾客' : '张阿姨',
  phoneMasked: accountId ? '138****8000' : '',
})

test('staff see bookings grouped by what still needs doing', async () => {
  const view = {
    reservations: [staffEntry('r1', 'pending', 'a1'), staffEntry('r2', 'confirmed', 'a1')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  // 已结束的由服务端分页：这里是 21 条里的第 1 页（只摆一条足够）
  const page = await staffPage(view, [], [], {
    items: [staffEntry('r3', 'cancelled', 'a1')],
    total: 21,
    page: 1,
  })
  let tree = page.render()
  const body = text(tree)
  assert.ok(body.includes('今天 · 2') && body.includes('明天 · 0') && body.includes('以后 · 0'), body)
  assert.equal(nodes(tree, (node) => cls(node).includes('booking-missed')).length, 0, '没有过时未处理的预约时不占地方')
  // 每条只有一个主按钮：待确认的是「确认预约」，确认过的是「到店了，开台」；取消、爽约收进「⋯」
  assert.equal(buttons(tree).filter((node) => text(node) === '确认预约').length, 1)
  assert.equal(buttons(tree).filter((node) => text(node) === '到店了，开台').length, 1)
  assert.equal(buttons(tree).filter((node) => text(node) === '⋯').length, 2)
  assert.ok(body.includes('B1 · 顾客'), '写座位和顾客')
  assert.ok(body.includes('尾号 8000 · 3 小时 · 没填团购 · 到店应收 ¥100.00'), body)
  // 代客登记单独一页
  buttons(tree)
    .find((node) => text(node) === '+ 代客登记')
    .props.onClick()
  assert.deepEqual(page.pages, ['/pages/staff/booking/index'])

  // 已结束的平时收着；点开后翻页交给服务端：页码从 1 起
  page.openEnded()
  tree = page.render()
  assert.ok(text(tree).includes('已取消'))
  const pager = nodes(tree, (node) => node.type === 'PageControls')[0]
  assert.equal(pager.props.page, 0)
  assert.equal(pager.props.total, 21)
  assert.equal(page.endedLoads.at(-1).page, 1)
  pager.props.onChange(1)
  page.render()
  const next = page.endedLoads.at(-1)
  assert.equal(next.page, 2, '翻页要重新读已结束的那一页（页码在查询键里）')
  await next.read()
  assert.deepEqual(page.endedPages, [2])
  // 预约设置搬去电脑后台了：哪个角色在小程序里都看不到设置分区（这一页不按角色分）
  assert.equal(
    buttons((await staffPage(view)).render()).some((node) => text(node) === '预约设置'),
    false,
    '小程序里不该有预约设置',
  )
  assert.equal(body.includes('取消或爽约的原因'), false, '原因不再是页顶的常驻输入框——它属于某一次操作，不属于整页')
})

// 「已结束」能按门店日期查（2026-10-06 业主定，同网页）：日期带给后端筛，总数与翻页只算这一天；
// 默认不限日期，换日期回到第 1 页，清除日期回到不限。快捷日期是今天、昨天，按门店时区算。
test('staff look up ended bookings by store date; changing the date goes back to page 1 and clearing it lifts the filter', async () => {
  const view = {
    reservations: [],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const page = await staffPage(view, [], [], { items: [], total: 0, page: 1 })
  page.openEnded()
  const dateField = () => nodes(page.render(), (node) => node.type === 'DateField')[0]
  const latest = () => page.endedLoads.at(-1)

  // 默认不限日期：查询键写 all，请求不带 date
  assert.equal(dateField().props.value, '')
  assert.equal(latest().date, 'all')
  assert.equal(latest().page, 1)
  await latest().read()
  assert.deepEqual({ ...page.endedReads.at(-1) }, { page: 1, date: '' })
  assert.ok(text(page.render()).includes('还没有已结束的预约记录。'))

  // 快捷日期：今天、昨天（门店时区），没选时选择器停在门店的今天
  const today = service.isoDate(service.storeDate(0))
  const yesterday = service.isoDate(service.storeDate(-1))
  assert.deepEqual(
    dateField().props.presets.map((preset) => `${preset.text}=${preset.value}`),
    [`今天=${today}`, `昨天=${yesterday}`],
  )
  assert.equal(dateField().props.openAt, today)

  // 不限日期时翻到第 3 页：同一天里翻页留着上一页
  nodes(page.render(), (node) => node.type === 'PageControls')[0].props.onChange(2)
  page.render()
  assert.equal(latest().page, 3)
  assert.equal(latest().placeholder, 'keep', '翻页时先留着上一页')

  // 选了昨天：回到第 1 页，日期进查询键和请求，换日期不留上一页（别把别的日子的预约当成这一天的）
  dateField().props.onChange(yesterday)
  assert.equal(dateField().props.value, yesterday)
  assert.equal(dateField().props.text, service.relativeDayLabel(yesterday))
  assert.ok(dateField().props.text.endsWith('· 昨天'))
  assert.equal(latest().date, yesterday)
  assert.equal(latest().page, 1, '换日期回到第 1 页')
  assert.equal(latest().placeholder, undefined, '换日期不留上一页')
  await latest().read()
  assert.deepEqual({ ...page.endedReads.at(-1) }, { page: 1, date: yesterday })
  assert.ok(text(page.render()).includes(`${service.relativeDayLabel(yesterday)} 没有已结束的预约。`))

  // 这一天里翻页：日期跟着走
  nodes(page.render(), (node) => node.type === 'PageControls')[0].props.onChange(1)
  page.render()
  assert.deepEqual({ date: latest().date, page: latest().page }, { date: yesterday, page: 2 })
  await latest().read()
  assert.deepEqual({ ...page.endedReads.at(-1) }, { page: 2, date: yesterday })

  // 用选择器换一天：也回到第 1 页
  dateField().props.onChange('2026-09-30')
  page.render()
  assert.deepEqual({ date: latest().date, page: latest().page }, { date: '2026-09-30', page: 1 })

  // 清除日期：回到不限、第 1 页，请求不再带 date
  dateField().props.onChange('')
  assert.equal(dateField().props.value, '')
  assert.deepEqual({ date: latest().date, page: latest().page }, { date: 'all', page: 1 })
  await latest().read()
  assert.deepEqual({ ...page.endedReads.at(-1) }, { page: 1, date: '' })
})

// 过了到店时间加宽限还没处理的：已存状态仍是待确认/已确认，displayStatus 为 expired。
// 以前它们被归进「已结束」且没有任何按钮——提示写着「请标记爽约或取消」，却点不了。
test('bookings past the grace period get their own group and can still be cancelled or marked no-show', async () => {
  const late = { ...staffEntry('r-late', 'confirmed', 'a1'), displayStatus: 'expired' }
  const lateGuest = { ...staffEntry('r-late-guest', 'pending', ''), displayStatus: 'expired' }
  const view = {
    reservations: [late, lateGuest],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const submitted: any[] = []
  const page = await staffPage(view, submitted, [{ confirm: true, content: '没来' }])
  const tree = page.render()
  const body = text(tree)
  const missed = nodes(tree, (node) => cls(node) === 'booking-missed')
  assert.equal(missed.length, 2, '过了时间没来的置顶成红卡')
  assert.ok(text(missed[0]).includes('B1 · 顾客 没来'))
  assert.ok(text(missed[1]).includes('B1 · 张阿姨 没来'))
  assert.ok(body.includes('过了到店时间加 30 分钟宽限，座位已经放出来了'))
  assert.ok(body.includes('今天 · 0'), '过时的不混进时间线')
  const named = (name) => buttons(tree).filter((node) => text(node) === name)
  assert.equal(named('顾客说不来了').length, 2)
  assert.equal(named('标记爽约').length, 2)
  // 过了时间不能再确认；到店开台也不摆（座位已释放）
  assert.equal(named('确认预约').length, 0)
  assert.equal(named('到店了，开台').length, 0)
  named('标记爽约')[0].props.onClick()
  await settle()
  assert.equal(submitted.at(-1).action, 'no_show')
  assert.equal(submitted.at(-1).targetId, 'r-late')
  assert.equal(submitted.at(-1).reason, '没来')
})

// 取消／爽约的原因跟着那一次操作走：当场问，问完就没了。
// 原先是页顶一个常驻文本框，一条预约都没有时它也在，填完还得自己记住它属于下面哪一条。
test('cancelling asks for the reason then and there, and a declined prompt changes nothing', async () => {
  const view = {
    reservations: [staffEntry('r1', 'confirmed', 'a1'), staffEntry('r2', 'confirmed', 'a1')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const submitted: any[] = []
  const page = await staffPage(
    view,
    submitted,
    [
      { confirm: false }, // 第一次点：改主意
      { confirm: true, content: '顾客临时有事' }, // 第二次点：填了原因
      { confirm: true, content: '' }, // 爽约：不填
    ],
    { items: [], total: 0, page: 1 },
    [0, 0, 1, 0], // 「⋯」里依次点：取消预约、取消预约、标记爽约；最后一次点了「⋯」又关掉
  )
  const more = () => buttons(page.render()).filter((node) => text(node) === '⋯')[0]

  await more().props.onClick()
  await settle()
  assert.equal(submitted.length, 0, '点「再想想」不能把预约取消掉')

  await more().props.onClick()
  await settle()
  // 沙箱里造的对象和这里的 Object.prototype 不是同一个，逐字段比
  assert.equal(submitted.at(-1).action, 'cancel')
  assert.equal(submitted.at(-1).targetId, 'r1')
  assert.equal(submitted.at(-1).reason, '顾客临时有事')

  await more().props.onClick()
  await settle()
  assert.equal(submitted.at(-1).action, 'no_show')
  assert.equal(submitted.at(-1).reason, '', '原因可不填')
  assert.deepEqual(page.sheets[0], ['取消预约', '标记爽约'])

  // 上一条填的原因不会跟到下一次操作上
  assert.equal(page.asked.length, 3)
  assert.ok(
    page.asked.every((option) => option.editable === true),
    '弹窗必须带输入框，否则原因根本填不进去',
  )
  assert.equal(page.asked.map((option) => option.title).join(','), '取消预约,取消预约,标记爽约')
})

// 后端只收开始时间到了之后的爽约：还没开始的预约不给「标记爽约」，取消照常可以。
// 待确认的「⋯」里第一项是「到店了，开台」（2026-10-27 起顾客人到了不用先确认）。
test('a reservation that has not started yet cannot be marked as a no-show', async () => {
  const future = staffEntry('r-future', 'pending', 'a1')
  future.reservation.startAt = new Date(Date.now() + 86400000).toISOString()
  const view = {
    reservations: [future, staffEntry('r-past', 'confirmed', 'a1')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const page = await staffPage(view, [], [], { items: [], total: 0, page: 1 }, [])
  assert.ok(text(page.render()).includes('明天 · 1'))
  assert.equal(
    buttons(page.render()).find((node) => text(node) === '⋯').props.ariaLabel,
    '更多：取消预约、标记爽约',
    '今天这条已经开始，能标记爽约',
  )
  buttons(page.render())
    .find((node) => text(node) === '明天 · 1')
    .props.onClick()
  const more = buttons(page.render()).find((node) => text(node) === '⋯')
  assert.equal(more.props.ariaLabel, '更多：到店了，开台、取消预约', '还没开始的只能取消（待确认的另能直接开台）')
  await more.props.onClick()
  assert.deepEqual(page.sheets.at(-1), ['到店了，开台', '取消预约'])
})

// 现场页「等你处理」里的「顾客取消」（2026-10-27 业主定）：今天的预约被顾客自己取消了，写清哪张桌、几点、谁、为什么；
// 点「知道了」交给后端记下（全店一起消），列不列以重读的接口为准。
test('现场页的「顾客取消」写清桌位、时间和原因，点「知道了」交给后端', async () => {
  const h = hooks()
  const submitted: any[] = []
  let refreshed = 0
  let fail = false
  const { CancelledRow } = await load('components/staff/cancelled-row.tsx', {
    react: h.api,
    '@tarojs/components': components,
    '../button': { Button: 'Button' },
    '../../hooks/query': {
      useRefreshAll: () => async () => {
        refreshed++
      },
    },
    '../../services/staff': { staffMessage: (error: Error) => error.message },
    '../../services/reservations': {
      ...service,
      reservations: {
        action: async (input) => {
          if (fail) throw new Error('预约状态已变化，请刷新')
          submitted.push(input)
        },
      },
    },
  })
  const entry = staffEntry('r-gone', 'cancelled', 'a1')
  const start = service.storeClock(entry.reservation.startAt)
  const end = service.storeClock(entry.endAt)
  const render = (value = entry) => h.render(() => CancelledRow({ entry: value, tables: layoutTables() }))
  const ok = () => buttons(render()).find((node) => text(node) === '知道了')

  assert.equal(
    text(nodes(render(), (node) => cls(node) === 'workbench-row-title')[0]),
    `顾客取消 B1 · 今天 ${start}–${end}`,
  )
  assert.equal(text(nodes(render(), (node) => cls(node) === 'workbench-row-meta')[0]), '顾客 · 没选原因')
  const withReason = { ...entry, reservation: { ...entry.reservation, reason: '临时有事来不了' } }
  assert.ok(text(render(withReason)).includes('顾客 · 原因：临时有事来不了'))

  fail = true
  ok().props.onClick()
  await settle()
  assert.ok(text(render()).includes('预约状态已变化，请刷新'), '没记上要说出来')
  assert.equal(refreshed, 0)
  fail = false
  ok().props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ action: 'acknowledge', targetId: 'r-gone' }])
  assert.equal(refreshed, 1, '点完重读，列不列以接口为准')
})

// 2026-10-27 起「确认预约」「到店了，开台」都先问一句：确认会给顾客发微信通知，开台就开始计时，点错了收不回来。
// 待确认的顾客人到了，从「⋯」直接开台，不用先确认；弹窗里写明不再发「预约成功」通知。
test('confirming or seating a booking asks first, and a pending one can be seated straight from the menu', async () => {
  const submitted: any[] = []
  const view = {
    reservations: [staffEntry('r-wait', 'pending', 'a1')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const page = await staffPage(
    view,
    submitted,
    [{ confirm: false }, { confirm: true }, { confirm: true }],
    { items: [], total: 0, page: 1 },
    [0], // 「⋯」里点「到店了，开台」
  )
  const confirm = () => buttons(page.render()).find((node) => text(node) === '确认预约')
  confirm().props.onClick()
  await settle()
  assert.equal(submitted.length, 0, '点「再看看」不确认')
  confirm().props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ action: 'confirm', targetId: 'r-wait' }])
  assert.ok(page.asked[1].content.includes('B1 · ') && page.asked[1].content.includes('顾客'), page.asked[1].content)
  assert.ok(page.asked[1].content.includes('「预约成功」通知'), '写明确认会给顾客发通知')

  await buttons(page.render())
    .find((node) => text(node) === '⋯')
    .props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.at(-1))), { action: 'seat', targetId: 'r-wait' })
  assert.deepEqual(
    page.asked.map((option) => option.title),
    ['确认这条预约？', '确认这条预约？', '到店开台？'],
  )
  assert.ok(page.asked[2].content.includes('还没确认'), '待确认的直接开台要说清不再发「预约成功」')
  assert.ok(page.asked.every((option) => option.cancelText === '再看看'))
})

// A booking taken by phone has no account, and timing, checkout and history all
// hang off one: staff must pick the account before the seat can start.
// 电话、当面约的预约可能没关联账户：到店时弹出来，选上账户再开台，或者当散客开台（业主 10-20 定）。
test('seating a booking without an account offers an account or a walk-in start', async () => {
  const submitted: any[] = []
  const view = {
    reservations: [staffEntry('r-guest', 'confirmed', ''), staffEntry('r-member', 'confirmed', 'a1')],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  // 已关联账户的开台先问一句（下面点一次「开台」）；没关联的弹层里的按钮就是确认，不再问
  const page = await staffPage(view, submitted, [{ confirm: true }])
  const seat = (index: number) => buttons(page.render()).filter((node) => text(node) === '到店了，开台')[index]
  const sheet = () => nodes(page.render(), (node) => node.type === 'StaffSheet')[0]
  const primary = () => nodes(sheet().props.footer, (node) => node.type === 'Button')[0]

  // 已关联账户的问过就开
  seat(1).props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ action: 'seat', targetId: 'r-member' }])
  assert.equal(page.asked.length, 1)

  seat(0).props.onClick()
  await settle()
  assert.equal(submitted.length, 1, '没关联账户的先弹出来，不直接开')
  assert.equal(sheet().props.pill, '到店开台')
  assert.ok(text(sheet()).includes('不选就当散客开台'))
  assert.equal(text(primary()), '当散客开台')
  // 账户由服务端按关键字查（CustomerPick），页面只管选中的是谁
  nodes(sheet(), (node) => node.type === 'CustomerPick')[0].props.onChange({
    id: 'a1',
    nickname: '顾客',
    phoneMasked: '138****8000',
  })
  assert.equal(text(primary()), '关联账户并开台')
  primary().props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.at(-1))), {
    action: 'seat',
    targetId: 'r-guest',
    accountId: 'a1',
  })
  assert.equal(sheet(), undefined, '开好后弹层收起')

  // 不选账户：当散客开台，不带 accountId
  seat(0).props.onClick()
  await settle()
  primary().props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.at(-1))), { action: 'seat', targetId: 'r-guest' })
  assert.equal(page.asked.length, 1, '弹层里的按钮就是确认，不再弹窗问')
})

// 图能用时顾客只看图。图上没画的桌、多座桌的第 2 个座往后，不向顾客开放自助预约——
// 店主明确要求平面图就是全部，多出来的（比如旧的测试区域）不该摆在顾客面前。
// 门店停用的桌（坏了、在维护）：图上画出来，但不给可点热区。
//
// ★★ 停用/启用是布局固定之后员工端唯一还能改的桌位状态。画出来是为了让顾客知道
//    那个位置存在（不然会以为图错了），不给热区是因为点了也订不到 —— 后端会拒。
//    后端不下发停用的桌，图上缺的就是停用的；以前缺一张就整张图不给用（2026-10-05 查出）。
// ★ 和「当天已约满」用不同的标记：约满明天可能有位，停用今天明天都没有，
//   给顾客同一种暗示会让他明天白跑一趟。
test('a table the shop disabled is drawn on the plan but cannot be tapped', async () => {
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [pack],
    // 后端只下发启用的桌：停用的 B3 不在列表里
    tables: layoutTables().filter((table) => table.code !== 'B3'),
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  let tree = page.render()
  // 换到明天：今天还剩几个时段取决于测试运行的钟点。
  dayButtons(tree)[1].props.onClick()
  tree = page.render()
  assert.ok(text(tree).includes('／20'), '空闲数按可约的 20 个位置算，不含停用的')
  pickSlot(page)
  tree = page.render()

  const hits = buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit'))
  assert.equal(hits.length, 20, '停用的位置不该有可点热区')
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('B3')),
    false,
    '停用的桌点了也订不到，不能让顾客点开',
  )
  // 图上仍然画着 21 个位置，停用的那个用独立标记，和「已约满」分开。
  assert.equal(nodes(tree, (node) => cls(node).includes('seatmap-mark')).length, 21)
  assert.equal(nodes(tree, (node) => cls(node).includes('seatmap-mark-off')).length, 1)
  assert.ok(text(tree).includes('还能约 20 个位置'))
})

// 门店里多出来的、布局之外的桌（早年的测试区域之类）不向顾客开放自助预约。
//
// ★ 布局固定之后这种桌本不该存在 —— 后端启动校正会拒绝启动。但顾客端仍然按 code
//   对位、认不出的一律忽略：万一后端还没升上去，也不能把图上没画的桌卖出去。
test('tables outside the layout are ignored instead of offered to customers', async () => {
  const seatmap = await load('services/seatmap.ts')
  const tables = layoutTables()
  tables.push({
    id: 'legacy',
    number: 1,
    seatCount: 2,
    occupiedSeats: [],
    floorAreaId: 'area-legacy',
    floorAreaName: '1',
  })
  assert.equal(
    seatmap.mapSeats(tables).seats.filter((seat: any) => seat.disabled).length,
    0,
    '图外的桌位不该挤掉图上的',
  )
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [pack],
    tables,
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  let tree = page.render()
  dayButtons(tree)[1].props.onClick()
  pickSlot(page)
  tree = page.render()
  assert.equal(
    buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit')).length,
    seatmap.planSeats.length,
    '图上每个位置都要可点，且只有图上这些',
  )
  assert.equal(text(tree).includes('选择桌位'), false, '布局固定之后不再有按桌号选座的列表')
})

test('tapping a seat on the floor plan books that exact seat', async () => {
  const seatmap = await load('services/seatmap.ts')
  const tables = layoutTables()
  const target = seatmap.mapSeats(tables).seats.find((seat) => seat.id === 'B3')
  const submitted: any[] = []
  const page = await customerPage(
    { reservations: [], busy: [], packages: [pack], tables, settings, settingsVersion: 'v', version: 'r' },
    submitted,
  )
  // 先换到明天：今天还剩几个时段取决于测试运行的钟点，傍晚跑的话一个热区都没有。
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  let tree = page.render()
  const b3 = buttons(tree).find(
    (node) => cls(node).split(' ').includes('seatmap-hit') && (node.props.ariaLabel || '').startsWith('B3，'),
  )
  assert.ok(b3, '底图编号 B3 应该有热区')
  b3.props.onClick()
  tree = page.render()
  const sheet = nodes(tree, (node) => cls(node) === 'plan-sheet')[0]
  assert.ok(text(sheet).includes('B3'), '确认层应指向刚点的座位')
  assert.ok(
    text(sheet).includes(`B 区 · ${storeLayout.zones.find((zone) => zone.key === 'B')!.desc} · 1 个座位`),
    text(sheet),
  )
  submitButton(tree).props.onClick()
  await settle()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].serviceTableId, target.serviceTableId, '提交的必须就是 B3 对应的那张桌')
  assert.equal(submitted[0].seatNumber, target.seatNumber)
})

// 当天没有任何空闲时段的座位，图上必须画成已约满且点不开——
// 让顾客点开一个注定订不到的座位，比不显示它更糟。
test('a seat with no free slot that day is drawn as full and cannot be opened', async () => {
  const seatmap = await load('services/seatmap.ts')
  const tables = layoutTables()
  const target = seatmap.mapSeats(tables).seats.find((seat) => seat.id === 'C2')
  const page = await customerPage({
    reservations: [],
    busy: [
      {
        serviceTableId: target.serviceTableId,
        seatNumber: target.seatNumber,
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: '2099-01-01T00:00:00.000Z',
      },
    ],
    packages: [pack],
    tables,
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  // 先换到明天：今天还剩几个时段取决于测试运行的钟点。
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  const tree = page.render()
  const hits = buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit'))
  assert.equal(hits.length, seatmap.planSeats.length - 1, '被占满的座位不该留热区')
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('C2，')),
    false,
    'C2 当天已约满，不能点开',
  )
  // 图上仍然画着它，只是标成已约满
  const marks = nodes(tree, (node) => cls(node).includes('seatmap-mark-taken'))
  assert.equal(marks.length, 1, '正好一个座位标成已约满')
})

// 可约时段会随时间推移失效，但图上的空闲标记和抽屉里的时段都是 useMemo 算出来的。
// 依赖里不放时间，它们就永远停在打开页面那一刻：图上一直说「有空闲」，
// 选中的时段过期了也照样能点，提交被打回后列表还是原样，顾客出不来。
test('the plan and the slot list recompute as time moves on', async () => {
  const seatmap = await load('services/seatmap.ts')
  const tables = layoutTables()
  const target = seatmap.mapSeats(tables).seats.find((seat) => seat.id === 'C2')
  // 同一个 view 对象全程复用，所以 data 这个依赖不会变；只有时间这一层会推进。
  const view: { busy: any[]; [key: string]: any } = {
    reservations: [],
    busy: [],
    packages: [pack],
    tables,
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const page = await customerPage(view)
  // 先换到明天：今天还剩几个时段取决于测试运行的钟点。
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  let tree = page.render()
  assert.equal(
    buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit')).length,
    seatmap.planSeats.length,
  )

  // 别人把 C2 整段约走了。数据对象本身没换，只有内容变了。
  view.busy.push({
    serviceTableId: target.serviceTableId,
    seatNumber: target.seatNumber,
    startAt: '2026-01-01T00:00:00.000Z',
    endAt: '2099-01-01T00:00:00.000Z',
  })
  // 不推进时间的话，页面理应还停在旧结论上——这正是依赖缓存生效的证据。
  assert.equal(
    buttons(page.render()).filter((node) => cls(node).split(' ').includes('seatmap-hit')).length,
    seatmap.planSeats.length,
    '依赖没变时不该重算，否则这条测试证明不了下一步',
  )

  advance()
  tree = page.render()
  const hits = buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit'))
  assert.equal(hits.length, seatmap.planSeats.length - 1, '时间推进后图上必须重算空闲')
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('C2，')),
    false,
    'C2 已被约走，热区应该消失',
  )
})

// 排不出任何时段的那一天（超出可预约范围、或今天已过最后一个时间），
// 不能和「被别人订满」混成一句话——那是在告诉顾客一件不存在的事。
test('a day with no slots at all says so instead of claiming everything is booked', async () => {
  // 套餐时长比营业时间还长，任何一天都排不出时段。
  const tooLong = { ...pack, id: 'long', name: '通宵', durationMinutes: 15 * 60 }
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [tooLong],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  const tree = page.render()
  const body = text(tree)
  assert.match(body, /最近 7 天都排不出可约时段/)
  assert.equal(body.includes('当天已约满'), false, '没有时段不等于被订满')
  assert.equal(body.includes('可能超出'), false, '日期条只给 7 天，「超出范围」从界面进不去，文案不该猜')
  assert.equal(
    buttons(tree)
      .filter((node) => cls(node).includes('seatmap-hit'))
      .every((node) => node.props.disabled),
    true,
    '排不出时段时座位不能点开',
  )
})

// 晚上打开预约页：今天已经排不出时段，第一屏不该是一句「没有」——页面自己站到最近有时段的
// 一天，并说一声为什么。顾客亲手点回今天，才如实显示「这一天没有可约时段」。
// 2026-09-19 21:02 采图抓到的原样：默认「今天」+ 一段红字，还猜「可能超出了 7 天范围」。
test('an evening visit lands on the first day that still has slots, and says so', async () => {
  const today = service.storeDate(0)
  const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day
  const page = await customerPage(
    {
      reservations: [],
      busy: [],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    [],
    // 让「今天」排不出任何时段，其他日子照常——这就是 21 点打开页面的局面
    { openSlots: (s, date, minutes, now) => (sameDay(date, today) ? [] : service.openSlots(s, date, minutes, now)) },
  )
  let tree = page.render()
  let body = text(tree)
  const dayButtons = () => buttons(tree).filter((node) => cls(node).split(' ').includes('plan-day'))
  assert.equal(dayButtons().length, settings.advanceDays, '日期条应有 7 天')
  assert.equal(cls(dayButtons()[0]).includes('plan-day-on'), false, '今天没时段，不该默认站在今天')
  assert.ok(cls(dayButtons()[1]).includes('plan-day-on'), '应自动站到明天')
  assert.match(body, /今天的可约时段已过，已切到/)
  assert.equal(body.includes('这一天没有可约时段'), false, '自动切到的那天是有时段的，不该报没有')
  assert.equal(body.includes('可能超出'), false)

  // 顾客自己点回今天：以他选的为准，并如实说这一天没有时段
  dayButtons()[0].props.onClick()
  tree = page.render()
  body = text(tree)
  assert.ok(cls(dayButtons()[0]).includes('plan-day-on'), '顾客选了今天就站在今天')
  assert.match(body, /这一天没有可约时段，请在上面换一天/)
  assert.equal(body.includes('今天的可约时段已过'), false, '顾客亲手选的日子不再提「已切到」')
})

// 桌号只在区域内唯一，全店有五个「1 号桌」。图上的每个位置必须能被顾客一眼区分开，
// 否则点错了要到店才发现。
//
// ★ 布局固定之后靠的是**编码**（A1、B3…），它全店唯一，画在底图上，也是后端对位的键。
//   旧版靠「区域名 + 桌号」拼标签，那是因为当时没有稳定编码可用。
test('every seat on the plan is labelled with its globally unique code', async () => {
  const page = await customerPage({
    reservations: [],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  const tree = page.render()
  const labels = buttons(tree)
    .filter((node) => cls(node).includes('seatmap-hit'))
    .map((node) => node.props.ariaLabel.split('，')[0])
  assert.equal(labels.length, 21)
  assert.equal(new Set(labels).size, 21, '两个位置不能显示成同一个名字')
  assert.ok(
    ['A1', 'B1', 'C1', 'D1', 'E1'].every((code) => labels.includes(code)),
    '各区的 1 号桌要能分开',
  )
})

// 晚间时段挂「示例工坊夜校」的名字。
//
// ★ 它只是给**已经存在的时段**贴标签，不改变可不可约 —— 能不能约仍由 slotFree 决定。
// ★★ 必须按**门店本地时间**（UTC+8）判，不能用 slot.getHours()：那读的是手机时区，
//    顾客人在别的时区时同一个时段会一会儿是夜校、一会儿不是。
test('evening slots are labelled with the night-school name', async () => {
  const brand = await load('brand.ts')
  const seatmap = await load('services/seatmap.ts')
  // ★ 要同时造出「已约满的晚间时段」和「仍可约的晚间时段」，两条断言才都跑得到。
  //   夹具里 busy 为空的话，「已约满不挂标签」一次都不会执行，变异测试会假通过。
  //
  //   算一下：营业 09:00–22:00（openMinute 540 / closeMinute 1320），套餐 3 小时，
  //   所以晚间起点只有 18:00 / 18:30 / 19:00 三个。把**所有座位**的最后一小时 21:00–22:00 占住：
  //     18:00 起（18–21）不重叠 → 仍可约，带标签
  //     18:30 起（18:30–21:30）重叠 → 已满
  //     19:00 起（19–22）重叠     → 已满
  //   ★★ 「明天」必须按**门店日**算，不能拿 UTC 日期切片。门店是 UTC+8：北京时间
  //      00:00–08:00 这一段里 UTC 还停在前一天，两者差一天，夹具会把占位写到
  //      页面上点的那天的**前一天**去，于是「已约满的时段」一个都造不出来。
  //      2026-09-20 早上 07:0x 撞到过，在别的钟点跑都是绿的 —— 典型的时区边界假绿。
  const storeTomorrow = service.storeDate(1)
  const nightStart = service.storeInstant(storeTomorrow, 21 * 60) // 门店 21:00
  const tables = layoutTables()
  const page = await customerPage({
    reservations: [],
    busy: seatmap.mapSeats(tables).seats.map((seat) => ({
      serviceTableId: seat.serviceTableId,
      seatNumber: seat.seatNumber,
      startAt: nightStart.toISOString(),
      endAt: new Date(nightStart.getTime() + 1 * 3600_000).toISOString(),
    })),
    packages: [pack],
    tables,
    settings,
    settingsVersion: 'v',
    version: 'r',
  })
  dayButtons(page.render())[1].props.onClick()
  const slots = slotButtons(page.render())
  assert.ok(slots.length > 0, '应当有时段')
  assert.ok(
    slots.some((node) => node.props.disabled),
    '夹具要造出已约满的时段，否则「已约满不挂标签」那条断言跑不到',
  )
  const night = slots.filter((node) => text(node).includes(brand.nightSchoolName))
  assert.ok(night.length > 0, `应当有晚间时段挂上「${brand.nightSchoolName}」`)
  // 挂标签的必须都在 18:00 之后开始；没挂的必须都在之前（写还剩几个位置）。
  // ★ 已约满的时段**不显示**标签：那颗按钮点不动，再挂个活动名是噪音。
  for (const node of slots) {
    const hour = Number(text(node).slice(0, 2))
    const tagged = text(node).includes(brand.nightSchoolName)
    if (node.props.disabled) {
      assert.equal(tagged, false, `${text(node).slice(0, 5)} 已约满，不该挂夜校标签`)
      assert.ok(text(node).includes('已满'))
      continue
    }
    assert.equal(tagged, hour >= brand.nightSchoolFromHour, `${text(node).slice(0, 5)} 的夜校标签判错了`)
    if (!tagged) assert.ok(text(node).includes('余 21'), text(node))
  }
})

// ★★ 同一条规则，在**非门店时区**的手机上再跑一遍。
//
//    这条不是重复：夜校要按门店本地时间（UTC+8）判，但代码里很容易顺手写成
//    slot.getHours() —— 那读的是手机时区。开发机恰好也在 UTC+8，那样写本地永远假通过，
//    只有顾客人在别的时区（或手机时区设歪）时才露馅：同一个时段一会儿是夜校一会儿不是。
//    把进程时区搬到 UTC-5 再跑，写错就红。
// 首页「今天还能约」点了一个整点进来（?at=Unix 秒）：站在那一天，图上只亮这个时间还排得下的座位，
// 点座位时套餐和时段都已选好；点「看全天」或换一天就照常按全天画。
test('a slot picked on the home page opens the plan at that hour with the slot already chosen', async () => {
  const tomorrow = service.storeDate(1)
  const at = service.storeInstant(tomorrow, 14 * 60)
  // B2 下午 1 点到 4 点被约了：2 点开始坐不下，但上午还有空
  const b2 = {
    serviceTableId: 'db-B2',
    seatNumber: 1,
    startAt: service.storeInstant(tomorrow, 13 * 60).toISOString(),
    endAt: service.storeInstant(tomorrow, 16 * 60).toISOString(),
    kind: 'reservation',
  }
  const submitted: any[] = []
  const page = await customerPage(
    {
      reservations: [],
      busy: [held, b2],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    submitted,
    {},
    { params: { at: service.slotParam(at) } },
  )
  let tree = page.render()
  assert.ok(cls(dayButtons(tree)[1]).includes('plan-day-on'), '站在整点的那一天')
  // 转发给朋友：带着这个时段，标题写绝对日期
  assert.deepEqual(page.share(), {
    title: `${tomorrow.month} 月 ${tomorrow.day} 日 14:00 还有空位，一起来拼豆`,
    path: `/pages/customer/reservations/index?at=${service.slotParam(at)}`,
  })
  assert.equal(nodes(tree, (node) => cls(node) === 'plan-wanted').length, 0, '排得下就直接选好，不另外提示')
  const chosen = slotButtons(tree).find((node) => cls(node).includes('plan-slot-on'))
  assert.ok(chosen, '时段已经选好')
  assert.ok(text(chosen).startsWith('14:00'), text(chosen))
  let hits = hitsOf(tree)
  assert.equal(hits.length, 19, 'B1 整天被占、B2 两点坐不下')
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('B2')),
    false,
  )
  assert.ok(text(tree).includes('14:00–17:00 还能约 19 个位置'))
  hits.find((node) => (node.props.ariaLabel || '').startsWith('B3')).props.onClick()
  tree = page.render()
  assert.ok(text(nodes(tree, (node) => cls(node) === 'plan-sheet')[0]).includes('14:00–17:00 · 180 分钟'))
  submitButton(tree).props.onClick()
  await settle()
  assert.equal(submitted[0].startAt, at.toISOString())
  assert.equal(submitted[0].serviceTableId, 'db-B3')

  // 换个时间：B2 上午还能约，热区回来
  pickSlot(page, '09:00')
  hits = hitsOf(page.render())
  assert.equal(hits.length, 20)
  assert.ok(hits.some((node) => (node.props.ariaLabel || '').startsWith('B2')))
})

test('朋友转来的日期（?date=）：站在那天；没选时段时转发带上这一天', async () => {
  const day = service.storeDate(2)
  const iso = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`
  const view = {
    reservations: [],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const page = await customerPage(view, [], {}, { params: { date: iso } })
  assert.ok(cls(dayButtons(page.render())[2]).includes('plan-day-on'), '站在转来的那天')
  assert.deepEqual(page.share(), {
    title: 'EXAMPLE 示例工坊 · 选个座位一起来',
    path: `/pages/customer/reservations/index?date=${iso}`,
  })
  // 日期不像样的不认，照常跟着最近一个能约的日子走；转发也不带日期
  const odd = await customerPage(view, [], {}, { params: { date: '2026-1-1' } })
  odd.render()
  assert.equal(odd.share().path, '/pages/customer/reservations/index')
})

test('the home-page hour travels as Unix seconds, which survive the navigation whitelist', () => {
  const at = '2026-10-20T06:00:00.000Z'
  assert.equal(service.slotParam(at), '1792476000')
  assert.equal(service.slotFromParam('1792476000')?.toISOString(), at)
  assert.equal(service.slotFromParam('2026-10-20T06:00'), null)
  assert.equal(service.slotFromParam(undefined), null)
})

test('the night-school label follows store time, not the phone timezone', async () => {
  const brand = await load('brand.ts')
  const original = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    const page = await customerPage({
      reservations: [],
      busy: [],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    })
    dayButtons(page.render())[1].props.onClick()
    const slots = slotButtons(page.render())
    assert.ok(slots.length > 0)
    for (const node of slots) {
      if (node.props.disabled) continue
      // 按钮上显示的时间本身就是门店时间（走 storeClock），
      // 所以标签必须和它一致 —— 手机在哪个时区都一样。
      const hour = Number(text(node).slice(0, 2))
      assert.equal(
        text(node).includes(brand.nightSchoolName),
        hour >= brand.nightSchoolFromHour,
        `手机在 America/New_York 时，${text(node).slice(0, 5)} 的夜校标签判错了`,
      )
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

// 换个座位重新约时，上一个座位没提交的备注不能跟着走——员工会照着它准备。
test('a note typed for one seat does not follow the next one', async () => {
  const submitted: any[] = []
  const page = await customerPage(
    {
      reservations: [],
      busy: [],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    submitted,
  )
  // 换到明天再选位置：今天还剩几个时段取决于测试运行的钟点。
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  const seats = () => hitsOf(page.render())
  seats()[0].props.onClick()
  let tree = page.render()
  nodes(tree, (node) => node.type === 'Textarea')[0].props.onInput({ detail: { value: '想做小恐龙，留靠窗' } })
  buttons(page.render())
    .find((node) => text(node) === '关闭')
    .props.onClick()

  seats()[1].props.onClick()
  tree = page.render()
  assert.equal(nodes(tree, (node) => node.type === 'Textarea')[0].props.value, '', '换座位后备注要清空')
  submitButton(tree).props.onClick()
  await settle()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].note, '', '提交的备注不能是上一个座位写的那段')
})

// 「立即预约」先弹预约须知，按「再想想」不能下单——这一步是给顾客看规则的，不是装饰。
test('declining the booking notice submits nothing', async () => {
  const submitted: any[] = []
  const page = await customerPage(
    {
      reservations: [],
      busy: [],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    submitted,
  )
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  hitsOf(page.render())[0].props.onClick()
  modalAnswer = false
  try {
    submitButton(page.render()).props.onClick()
    await settle()
    assert.equal(submitted.length, 0, '按了「再想想」不能提交')
    // 确认层还开着，选择保留，顾客可以直接再点一次
    assert.ok(nodes(page.render(), (node) => cls(node) === 'plan-sheet')[0], '确认层不应关闭')
  } finally {
    modalAnswer = true
  }
})

// ——— 每人自助预约上限与门店联系方式 ———
// 联系方式来自预约设置（老板在网页后台填），随预约视图下发；小程序不写死。
const contacts = { contactPhone: '0571-8888 6666', contactWechat: 'examplebrand_pindou' }
const viewWith = (extra = {}) => ({
  reservations: [],
  busy: [],
  packages: [pack],
  tables: layoutTables(),
  settings: { ...settings, ...extra },
  settingsVersion: 'v',
  version: 'r',
})
const limitError = () => Object.assign(new Error('服务端的原话'), { code: 'reservation_limit_reached', status: 409 })

/** 页面用到的 Taro 接口替身，记下每次调用。 */
function taroCalls() {
  const calls: { api: string; args: any }[] = []
  const record = (api: string) => async (args: any) => {
    calls.push({ api, args })
    return { confirm: true }
  }
  return {
    calls,
    taro: {
      showModal: record('showModal'),
      makePhoneCall: record('makePhoneCall'),
      setClipboardData: record('setClipboardData'),
      showToast: record('showToast'),
    },
  }
}

/** 换到明天、选第一个时段、点第一个有空的座位、提交。 */
async function bookFirstFreeSeat(page) {
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  hitsOf(page.render())[0].props.onClick()
  submitButton(page.render()).props.onClick()
  await settle()
  return page.render()
}

test('store contacts come from the reservation settings and read as one line', () => {
  assert.deepEqual(service.storeContact({ ...settings, contactPhone: ' 0571-8888 6666 ', contactWechat: '' }), {
    phone: '0571-8888 6666',
    wechat: '',
  })
  assert.deepEqual(service.storeContact(undefined), { phone: '', wechat: '' })
  assert.equal(
    service.contactLine({ phone: '0571-8888 6666', wechat: 'examplebrand_pindou' }),
    '电话 0571-8888 6666，微信号 examplebrand_pindou',
  )
  assert.equal(service.contactLine({ phone: '', wechat: 'examplebrand_pindou' }), '微信号 examplebrand_pindou')
  assert.equal(service.contactLine({ phone: '', wechat: '' }), '')
  // 拨号只留数字和开头的 +
  assert.equal(service.dialNumber('+86 (0571) 8888-6666'), '+86057188886666')
  assert.equal(service.dialNumber('0571-8888 6666'), '057188886666')
})

// 上限的说法由小程序决定，不照搬服务端 message；没登记的错误码照旧用错误本身的说明。
test('the limit error is worded by the miniapp, not passed through from the server', async () => {
  const { customerMessage } = await load('services/customer.ts')
  assert.equal(customerMessage(limitError()), '每个账号最多同时预约 2 个座位，更多座位请联系门店')
  assert.equal(
    customerMessage(Object.assign(new Error('该座位在这个时间段已被预约'), { code: 'reservation_conflict' })),
    '该座位在这个时间段已被预约',
  )
  assert.equal(customerMessage(null, '操作失败'), '操作失败')
})

test('over the self-service limit the customer is told to contact the shop, with tappable contacts', async () => {
  const { calls, taro } = taroCalls()
  const page = await customerPage(
    viewWith(contacts),
    [],
    {},
    { action: async () => Promise.reject(limitError()), taro },
  )
  const tree = await bookFirstFreeSeat(page)

  const sheet = nodes(tree, (node) => cls(node) === 'plan-sheet')[0]
  assert.ok(sheet, '被拒后抽屉保留，顾客的选择还在')
  const alert = nodes(sheet, (node) => node.props?.role === 'alert')[0]
  assert.equal(text(alert), '每个账号最多同时预约 2 个座位，更多座位请联系门店')
  assert.equal(text(sheet).includes('服务端的原话'), false, '不照搬服务端 message')

  const phone = buttons(sheet).find((node) => node.props.ariaLabel === '拨打门店电话 0571-8888 6666')
  const wechat = buttons(sheet).find((node) => node.props.ariaLabel === '复制门店微信号 examplebrand_pindou')
  assert.ok(phone && wechat, '超限提示后面要有门店电话和微信号')
  phone.props.onClick()
  wechat.props.onClick()
  await settle()
  assert.deepEqual(
    calls.filter((call) => call.api !== 'showModal'),
    [
      { api: 'makePhoneCall', args: { phoneNumber: '057188886666' } },
      { api: 'setClipboardData', args: { data: 'examplebrand_pindou' } },
      { api: 'showToast', args: { title: '微信号已复制', icon: 'none' } },
    ],
  )
})

test('without store contacts the limit prompt only says to contact the shop', async () => {
  const { taro } = taroCalls()
  const page = await customerPage(viewWith(), [], {}, { action: async () => Promise.reject(limitError()), taro })
  const tree = await bookFirstFreeSeat(page)
  const sheet = nodes(tree, (node) => cls(node) === 'plan-sheet')[0]
  assert.equal(
    text(nodes(sheet, (node) => node.props?.role === 'alert')[0]),
    '每个账号最多同时预约 2 个座位，更多座位请联系门店',
  )
  assert.equal(nodes(tree, (node) => cls(node) === 'store-contact').length, 0, '没填联系方式时不画联系方式')
})

test('the booking notice and the private-room note carry the shop contacts when filled', async () => {
  const { calls, taro } = taroCalls()
  const page = await customerPage(viewWith(contacts), [], {}, { taro })
  const tree = page.render()

  // 包间说明后面跟着可点的联系方式
  const card = nodes(tree, (node) => cls(node) === 'plan-zones-card')[0]
  const children = nodes(card, () => true)
  const note = children.findIndex((node) => cls(node) === 'plan-room-note')
  const contact = children.findIndex((node) => cls(node) === 'store-contact')
  assert.ok(note >= 0 && contact > note, '联系方式要接在包间说明后面')
  assert.ok(buttons(card).some((node) => node.props.ariaLabel === '拨打门店电话 0571-8888 6666'))
  assert.ok(buttons(card).some((node) => node.props.ariaLabel === '复制门店微信号 examplebrand_pindou'))

  // 预约须知：包间说明后面接一行联系方式
  buttons(tree)
    .find((node) => node.props.ariaLabel === '预约须知')
    .props.onClick()
  await settle()
  const lines = calls.find((call) => call.api === 'showModal')!.args.content.split('\n')
  assert.deepEqual(lines.slice(-2), [
    '· 包间（D、E 区）：想包下整个包间，请提前联系门店预约',
    '· 联系门店：电话 0571-8888 6666，微信号 examplebrand_pindou',
  ])
})

test('without store contacts the notice and the room note stay as they were', async () => {
  const { calls, taro } = taroCalls()
  const page = await customerPage(viewWith(), [], {}, { taro })
  const tree = page.render()
  assert.equal(nodes(tree, (node) => cls(node) === 'store-contact').length, 0)
  buttons(tree)
    .find((node) => node.props.ariaLabel === '预约须知')
    .props.onClick()
  await settle()
  const content = calls.find((call) => call.api === 'showModal')!.args.content
  assert.ok(content.endsWith('· 包间（D、E 区）：想包下整个包间，请提前联系门店预约'))
  assert.equal(content.includes('联系门店：'), false)
})

// ——— 歇业日、爽约暂停、现场挡预约 ———
// 三样都由后端算好随预约视图下发（closedDays、selfServiceSuspended、busy 里 kind=session），小程序只查不推算。
const isoOfDay = (offset: number) => {
  const d = service.storeDate(offset)
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
}
const hitsOf = (tree) => buttons(tree).filter((node) => cls(node).split(' ').includes('seatmap-hit'))

test('a closed day reads 店休 on the strip, greys the whole plan and offers nothing to book', async () => {
  const seatmap = await load('services/seatmap.ts')
  const page = await customerPage({ ...viewWith(), closedDays: [isoOfDay(1)] })
  let tree = page.render()
  const closed = dayButtons(tree)[1]
  assert.ok(cls(closed).includes('plan-day-closed'), '歇业的日子在日期条上单独标出')
  assert.ok(text(closed).includes('店休'))
  assert.ok(closed.props.ariaLabel.includes('店休'))
  assert.equal(text(dayButtons(tree)[2]).includes('店休'), false, '其他日子照常')

  closed.props.onClick()
  tree = page.render()
  assert.equal(hitsOf(tree).length, 0, '歇业那天一个座位都不能点开')
  const marks = nodes(tree, (node) => cls(node).includes('seatmap-mark'))
  assert.ok(
    marks.every((node) => cls(node).includes('seatmap-mark-dim') || cls(node).includes('seatmap-mark-off')),
    '整张图压灰，不画成「已约满」',
  )
  const body = text(tree)
  assert.match(body, /门店这天歇业（店休），请在上面换一天/)
  assert.equal(body.includes('灰色为已约满'), false)

  dayButtons(tree)[2].props.onClick()
  pickSlot(page)
  assert.equal(hitsOf(page.render()).length, seatmap.planSeats.length, '换到营业的日子照常可约')
})

test('when today is a closed day the page lands on the next open day and says why', async () => {
  const page = await customerPage({ ...viewWith(), closedDays: [isoOfDay(0)] })
  const tree = page.render()
  assert.equal(text(dayButtons(tree)[0]).includes('店休'), true)
  assert.ok(cls(dayButtons(tree)[1]).includes('plan-day-on'), '自动站到明天')
  assert.match(text(tree), /今天门店歇业，已切到/)
})

test('a customer suspended for no-shows is told up front, with the shop contacts, before trying to book', async () => {
  const page = await customerPage({ ...viewWith(contacts), selfServiceSuspended: true })
  const tree = page.render()
  const status = nodes(tree, (node) => node.type === 'Status')[0]
  assert.equal(status.props.title, '暂时不能自助预约')
  assert.equal(status.props.message, '最近爽约次数较多，暂时不能自助预约，请联系门店。')
  assert.equal(dayButtons(tree).length, 0, '受限时不摆出选座')
  assert.equal(hitsOf(tree).length, 0)
  assert.ok(buttons(tree).some((node) => node.props.ariaLabel === '拨打门店电话 0571-8888 6666'))
  assert.ok(buttons(tree).some((node) => node.props.ariaLabel === '复制门店微信号 examplebrand_pindou'))

  // 「我的预约」也提前说，并且不再引去预约
  const mine = (await myReservationsPage({ ...viewWith(contacts), selfServiceSuspended: true })).render()
  assert.ok(text(mine).includes('最近爽约次数较多，暂时不能自助预约，请联系门店。'))
  assert.ok(buttons(mine).some((node) => node.props.ariaLabel === '拨打门店电话 0571-8888 6666'))
  assert.equal(
    buttons(mine).some((node) => text(node) === '预约座位'),
    false,
  )
  const normal = (await myReservationsPage(viewWith(contacts))).render()
  assert.equal(text(normal).includes('爽约'), false)
  assert.ok(buttons(normal).some((node) => text(node) === '预约座位'))
})

test('closed-day and suspension errors are worded by the miniapp; an in-use seat keeps the server time', async () => {
  const { customerMessage } = await load('services/customer.ts')
  const err = (code: string, message = '服务端的原话') => Object.assign(new Error(message), { code, status: 409 })
  assert.equal(customerMessage(err('store_closed')), '门店这天歇业，请换一天预约')
  assert.equal(customerMessage(err('reservation_suspended')), '最近爽约次数较多，暂时不能自助预约，请联系门店')
  assert.equal(
    customerMessage(err('seat_in_use', '这个座位现场正在使用，到 13:00 才空出，请换个时段或座位')),
    '这个座位现场正在使用，到 13:00 才空出，请换个时段或座位',
  )

  // 下单时才发现被暂停（页面数据过时）：说明后面同样接门店联系方式
  const { taro } = taroCalls()
  const page = await customerPage(
    viewWith(contacts),
    [],
    {},
    { action: async () => Promise.reject(err('reservation_suspended')), taro },
  )
  const sheet = nodes(await bookFirstFreeSeat(page), (node) => cls(node) === 'plan-sheet')[0]
  assert.equal(
    text(nodes(sheet, (node) => node.props?.role === 'alert')[0]),
    '最近爽约次数较多，暂时不能自助预约，请联系门店',
  )
  assert.ok(buttons(sheet).some((node) => node.props.ariaLabel === '拨打门店电话 0571-8888 6666'))
})

test('a seat held by a live timed session counts as taken on the customer plan', async () => {
  const seatmap = await load('services/seatmap.ts')
  const tables = layoutTables()
  const target = seatmap.mapSeats(tables).seats.find((seat) => seat.id === 'B3')
  const page = await customerPage({
    ...viewWith(),
    tables,
    busy: [
      {
        serviceTableId: target.serviceTableId,
        seatNumber: target.seatNumber,
        startAt: '2026-01-01T00:00:00.000Z',
        endAt: '2099-01-01T00:00:00.000Z',
        kind: 'session',
      },
    ],
  })
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  const hits = hitsOf(page.render())
  assert.equal(hits.length, seatmap.planSeats.length - 1)
  assert.equal(
    hits.some((node) => (node.props.ariaLabel || '').startsWith('B3，')),
    false,
    '现场正在使用的座位到结束前不能点开',
  )
})

test('staff see in-use end times, but only bookings block a registration', () => {
  const start = new Date('2026-09-15T01:00:00.000Z') // 门店 09:00
  const busy = [
    {
      serviceTableId: 't',
      seatNumber: 1,
      startAt: '2026-09-15T00:00:00.000Z',
      endAt: '2026-09-15T02:30:00.000Z',
      kind: 'session',
    },
    {
      serviceTableId: 't',
      seatNumber: 1,
      startAt: '2026-09-14T23:00:00.000Z',
      endAt: '2026-09-15T01:30:00.000Z',
      kind: 'session',
    },
    {
      serviceTableId: 't',
      seatNumber: 2,
      startAt: '2026-09-15T01:00:00.000Z',
      endAt: '2026-09-15T04:00:00.000Z',
      kind: 'reservation',
    },
  ]
  assert.deepEqual(
    service.reservedOnly(busy).map((slot) => slot.seatNumber),
    [2],
  )
  assert.equal(
    service.sessionUntil(busy, 't', 1, start, 180).toISOString(),
    '2026-09-15T02:30:00.000Z',
    '取最晚结束的那个',
  )
  assert.equal(service.sessionUntil(busy, 't', 2, start, 180), null, '预约不算现场会话')
  assert.equal(
    service.sessionUntil(busy, 't', 1, new Date('2026-09-15T02:30:00.000Z'), 60),
    null,
    '结束那一刻起不再压到',
  )
})

async function bookingPage(view, submitted: any[] = []) {
  const h = hooks()
  const left: unknown[] = []
  const { default: StaffBooking } = await load('pages/staff/booking/index.tsx', {
    '../../hooks/billing': billingMock(),
    react: h.api,
    '@tarojs/components': { ...components, ScrollView: 'ScrollView' },
    '@tarojs/taro': { default: { showToast() {} } },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': {
      StaffScreen: 'StaffScreen',
      useStaffQuery: () => ({ loading: false, data: view, error: null, refresh() {}, updatedAt: 0 }),
      useStaffEvents: () => ({ connection: 'connected', polling: true, refetchInterval: 30000 }),
    },
    '../../../components/staff/table-sheet': { CustomerPick: 'CustomerPick', minutesText },
    '../../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../../hooks/query': { useRefreshAll: () => async () => {} },
    '../../../services/format': {
      money: (cents) => (cents / 100).toFixed(2),
      moneyText: (cents) => (cents / 100).toFixed(2),
      storeOffsetMinutes: 8 * 60,
    },
    '../../../services/navigation': { returnToPreviousPage: async (...args: unknown[]) => left.push(args) },
    '../../../services/staff': { StaffError: class extends Error {} },
    '../../../services/reservations': {
      ...service,
      reservations: { action: async (input) => submitted.push(input) },
    },
  })
  return { render: () => h.render(StaffBooking), submitted, left }
}

test('staff registration warns about a closed day and an in-use seat but still goes through', async () => {
  const tomorrow = service.storeDate(1)
  const at = (minute: number) => service.storeInstant(tomorrow, minute).toISOString()
  const table = {
    id: 't-1',
    code: 'X1',
    zone: 'A',
    number: 1,
    seatCount: 2,
    wholeTable: false,
    occupiedSeats: [],
    floorAreaId: 'a',
    floorAreaName: 'A 区',
  }
  const view = {
    reservations: [],
    busy: [
      { serviceTableId: 't-1', seatNumber: 1, startAt: at(8 * 60), endAt: at(10 * 60 + 30), kind: 'session' },
      { serviceTableId: 't-1', seatNumber: 2, startAt: at(9 * 60), endAt: at(12 * 60), kind: 'reservation' },
    ],
    packages: [pack],
    tables: [table],
    settings,
    settingsVersion: 'v',
    closedDays: [isoOfDay(1)],
    version: 'r',
  }
  const submitted: any[] = []
  const page = await bookingPage(view, submitted)
  const press = (match: (node: any) => boolean) => {
    const node = buttons(page.render()).find(match)
    assert.ok(node, '找不到按钮')
    node.props.onClick()
  }
  // 套餐按钮写时长和价：「3 小时 ¥100.00」
  press((node) => text(node).startsWith('3 小时'))
  press((node) => cls(node).includes('booking-date') && text(node).startsWith('明天'))
  let tree = page.render()
  assert.ok(text(tree).includes('这天是歇业日，顾客不能自助预约；代客登记照常可以'))
  press((node) => text(node) === '09:00')
  tree = page.render()
  const seats = buttons(tree).filter((node) => cls(node).includes('booking-seat'))
  // 已被预约的 2 号座不列出来；1 号座现场在用只提示，不挡代客登记
  assert.deepEqual(
    seats.map((node) => node.props.ariaLabel),
    ['X1-1，现场使用中到 10:30'],
  )
  assert.ok(text(tree).includes('带 * 的座位现场正在使用'))
  seats[0].props.onClick()
  tree = page.render()
  assert.ok(text(tree).includes('X1-1 现场正在使用，到 10:30 才空出；代客登记照常可以'))
  const submit = () => buttons(page.render()).find((node) => text(node) === '登记')
  assert.equal(submit().props.disabled, true, '还没填顾客不能登记')
  nodes(tree, (node) => node.type === 'Input')[0].props.onInput({ detail: { value: '张阿姨' } })
  assert.ok(text(page.render()).includes('张阿姨 · X1-1'))
  submit().props.onClick()
  await settle()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].action, 'register')
  assert.equal(submitted[0].guestName, '张阿姨')
  assert.equal(submitted[0].seatNumber, 1)
  assert.equal(submitted[0].startAt, at(9 * 60))
  assert.equal(page.left.length, 1, '登记好回到预约页')
})

// 系统内收费关着（2026-10-10 起，钱在美团、大众点评收）：套餐只写时长不写价，提交时带上选填的团购记录。
// 「到打烊」的套餐在打烊前的任一时段开始、约到当天打烊：后面有别人预约的座位，只能约在那个预约结束之后。
test('收费关着：到打烊的套餐约到打烊、不写价格，团购记录随预约提交', async () => {
  const submitted: any[] = []
  const tomorrow = service.storeDate(1)
  const close = {
    id: 'close',
    kind: 'package',
    name: '畅玩到打烊',
    durationMinutes: 0,
    amountCents: 0,
    untilClose: true,
  }
  const page = await customerPage(
    {
      reservations: [],
      busy: [
        {
          serviceTableId: 'db-B2',
          seatNumber: 1,
          startAt: service.storeInstant(tomorrow, 15 * 60).toISOString(),
          endAt: service.storeInstant(tomorrow, 17 * 60).toISOString(),
          kind: 'reservation',
        },
      ],
      packages: [close],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    submitted,
    {},
    { billing: false },
  )
  dayButtons(page.render())[1].props.onClick()
  let tree = page.render()
  assert.equal(text(tree).includes('¥'), false, '收费关着不写价格')
  const slot = (start: string) => slotButtons(page.render()).find((node) => text(node).startsWith(start))
  assert.ok(slot('09:00'), '从开门就能约')
  assert.ok(slot('21:30'), '打烊前最后一个时段也能约')
  const b2 = () => hitsOf(page.render()).find((node) => (node.props.ariaLabel || '').startsWith('B2'))
  pickSlot(page, '16:30')
  assert.equal(b2(), undefined, '16:30 约到打烊会压到 15:00-17:00 的预约，B2 不能点')
  pickSlot(page, '17:00')
  assert.ok(b2(), '那个预约结束之后可以约')
  assert.ok(text(page.render()).includes('17:00–22:00 还能约 21 个位置'))

  b2().props.onClick()
  tree = page.render()
  const sheet = () => nodes(page.render(), (node) => cls(node) === 'plan-sheet')[0]
  assert.equal(text(sheet()).includes('¥'), false, `收费关着不写价格：${text(sheet())}`)
  assert.ok(text(sheet()).includes('17:00–22:00 · 到今天打烊'), '确认层写时段到打烊')
  assert.ok(text(sheet()).includes('预约不收费'))
  const fields = nodes(tree, (node) => node.type?.name === 'CouponFields')[0]
  fields.props.onChange({ platform: 'meituan', code: '1234 5678 9012' })
  tree = page.render()
  assert.equal(text(tree).includes('到店付'), false)
  submitButton(tree).props.onClick()
  await settle()
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].coupon, { platform: 'meituan', code: '123456789012' })
  assert.equal(submitted[0].startAt, service.storeInstant(tomorrow, 17 * 60).toISOString())
})

test('团购券码填得不对时不能预约，底部写明要先改好', async () => {
  const page = await customerPage(
    {
      reservations: [],
      busy: [],
      packages: [pack],
      tables: layoutTables(),
      settings,
      settingsVersion: 'v',
      version: 'r',
    },
    [],
    {},
    { billing: false },
  )
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  hitsOf(page.render())
    .find((node) => (node.props.ariaLabel || '').startsWith('B2'))
    .props.onClick()
  let tree = page.render()
  nodes(tree, (node) => node.type?.name === 'CouponFields')[0].props.onChange({ platform: 'meituan', code: '券码-12' })
  tree = page.render()
  assert.equal(submitButton(tree).props.disabled, true)
  assert.ok(text(tree).includes('团购填得不对，改好后再预约'))
})

test('收费关着：「我的预约」不写到店付多少，团购记录照常显示', async () => {
  const view = {
    reservations: [
      {
        reservation: {
          id: 'r1',
          accountId: 'me',
          serviceTableId: 'db-B2',
          seatNumber: 1,
          packageId: 'pkg',
          packageName: '三小时',
          durationMinutes: 180,
          amountCents: 10000,
          startAt: '2099-01-01T06:00:00.000Z',
          status: 'confirmed',
          note: '',
          coupon: { platform: 'meituan', code: '123456789012' },
        },
        displayStatus: 'confirmed',
        endAt: '2099-01-01T09:00:00.000Z',
        tableNumber: 2,
      },
    ],
    busy: [],
    packages: [pack],
    tables: layoutTables(),
    settings,
    settingsVersion: 'v',
    version: 'r',
  }
  const off = text((await myReservationsPage(view, [], false)).render())
  assert.equal(off.includes('到店后付'), false)
  assert.ok(off.includes('团购美团 · 券码 1234 5678 9012'), off)
  const on = text((await myReservationsPage(view, [], true)).render())
  assert.ok(on.includes('到店后付 ¥100.00'))
})

// ——— 微信提醒（订阅消息，2026-10-20 起）———
// 模板随本人的预约视图下发；订阅框和登录码由 services/notices.ts 管（tests/notices.test.ts 测它本身），这里测页面怎么用。
const templates = [
  { kind: 'confirmed', templateId: 't-ok' },
  { kind: 'reminder', templateId: 't-soon' },
  { kind: 'cancelled', templateId: 't-off' },
]
/** services/notices 的替身：记下弹过的订阅框和记到后端的种类；askNotices 回 answer 给的种类。 */
async function noticesMock(answer: (kinds: string[]) => string[]) {
  const real = await load('services/notices.ts')
  const asked: string[][] = []
  const saved: [string, string[]][] = []
  return {
    asked,
    saved,
    mock: {
      ...real,
      askNotices: async (list, kinds) => {
        assert.deepEqual(list, templates, '订阅框按视图里的模板弹')
        asked.push([...kinds])
        return answer(kinds)
      },
      saveNotices: async (id, kinds) => {
        saved.push([id, [...kinds]])
      },
    },
  }
}

test('提交预约：按下「确认预约」先弹订阅框订三种，允许了的记到新预约上；全拒绝照常提交、不再追问', async () => {
  for (const [answer, expected] of [
    [['confirmed', 'cancelled'], [['r-new', ['confirmed', 'cancelled']]]],
    [[], []],
  ] as const) {
    const submitted: any[] = []
    const notices = await noticesMock(() => [...answer])
    const { calls, taro } = taroCalls()
    const page = await customerPage(
      { ...viewWith(), noticeTemplates: templates },
      submitted,
      {},
      {
        taro,
        mocks: { '../../services/notices': notices.mock },
        action: async (input) => {
          // 提交之前订阅框已经弹过
          assert.equal(notices.asked.length, 1)
          submitted.push(input)
          return { targetId: 'r-new' }
        },
      },
    )
    await bookFirstFreeSeat(page)
    await settle()
    assert.deepEqual(notices.asked, [['confirmed', 'reminder', 'cancelled']])
    assert.equal(submitted.length, 1, '拒绝了也照常提交')
    assert.deepEqual(notices.saved, expected)
    assert.equal(calls.filter((call) => call.api === 'showModal').length, 1, '只弹预约须知，不追问')
  }
})

// 点了「提交预约」到出结果之间弹层锁住（2026-10-27 起）：预约须知、订阅框之间碰一下遮罩，弹层就关了，提交成功的勾也看不到。
test('提交预约：从预约须知到出结果，弹层关不掉、也不能再点提交', async () => {
  let answer: (value: { confirm: boolean }) => void = () => {}
  const page = await customerPage(
    viewWith(),
    [],
    {},
    { taro: { showModal: () => new Promise((resolve) => (answer = resolve)) } },
  )
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  hitsOf(page.render())[0].props.onClick()
  const sheet = () => nodes(page.render(), (node) => cls(node) === 'plan-sheet')[0]
  const mask = () => nodes(page.render(), (node) => cls(node) === 'plan-sheet-mask')[0]
  submitButton(page.render()).props.onClick()
  assert.equal(submitButton(page.render()).props.disabled, true, '须知弹着时不能再点提交')
  mask().props.onClick()
  assert.ok(sheet(), '须知弹着时点遮罩不关弹层')
  answer({ confirm: false })
  await settle()
  assert.equal(!!submitButton(page.render()).props.disabled, false, '点了「再想想」就解锁')
  mask().props.onClick()
  assert.equal(sheet(), undefined)
})

// 2026-10-28 业主定：弹层里写了备注或券码，点遮罩不关（免得误碰把写的丢了），点「关闭」照常关。
test('预约弹层：写了备注点遮罩不关，点「关闭」照常关', async () => {
  const page = await customerPage(viewWith())
  dayButtons(page.render())[1].props.onClick()
  pickSlot(page)
  hitsOf(page.render())[0].props.onClick()
  const sheet = () => nodes(page.render(), (node) => cls(node) === 'plan-sheet')[0]
  const mask = () => nodes(page.render(), (node) => cls(node) === 'plan-sheet-mask')[0]
  nodes(sheet(), (node) => node.type === 'Textarea')[0].props.onInput({ detail: { value: '想做一只小猫' } })
  mask().props.onClick()
  assert.ok(sheet(), '写了备注点遮罩不关')
  buttons(sheet())
    .find((node) => text(node) === '关闭')
    .props.onClick()
  assert.equal(sheet(), undefined, '点「关闭」照常关')
})

test('门店没开顾客通知（没有模板）：提交预约不弹订阅框', async () => {
  const notices = await noticesMock(() => {
    throw new Error('不该弹订阅框')
  })
  const submitted: any[] = []
  const page = await customerPage(
    { ...viewWith(), noticeTemplates: [] },
    submitted,
    {},
    {
      mocks: {
        '../../services/notices': { ...notices.mock, askNotices: (await load('services/notices.ts')).askNotices },
      },
    },
  )
  await bookFirstFreeSeat(page)
  assert.equal(submitted.length, 1)
  assert.deepEqual(notices.saved, [])
})

const noticeEntry = (id: string, status: string, notices: string[], startAt: string) => ({
  reservation: {
    id,
    serviceTableId: 'db-B1',
    seatNumber: 1,
    packageId: 'pkg',
    packageName: '三小时',
    durationMinutes: 180,
    amountCents: 10000,
    startAt,
    status,
    createdBy: 'staff',
    createdAt: '2099-01-01T00:00:00.000Z',
  },
  displayStatus: status,
  endAt: new Date(Date.parse(startAt) + 3 * 3600_000).toISOString(),
  tableNumber: 1,
  notices,
})

test('我的预约：缺哪种提醒就给「开启微信提醒」，都开了写已开启；全拒绝时告诉顾客去设置里打开', async () => {
  const view = {
    ...viewWith(),
    noticeTemplates: templates,
    reservations: [
      noticeEntry('r-first', 'pending', ['confirmed', 'reminder', 'cancelled'], '2099-01-02T06:00:00.000Z'),
      noticeEntry('r-later', 'confirmed', ['cancelled'], '2099-01-03T06:00:00.000Z'),
    ],
  }
  let answer: string[] = ['reminder']
  const notices = await noticesMock(() => answer)
  const { calls, taro } = taroCalls()
  let refreshed = 0
  const page = await myReservationsPage(
    view,
    [],
    true,
    { '@tarojs/taro': { default: { navigateTo: async () => {}, ...taro } }, '../../services/notices': notices.mock },
    async () => {
      refreshed++
    },
  )
  const tree = page.render()
  const big = nodes(tree, (node) => cls(node) === 'mine-next')[0]
  assert.ok(text(big).includes('已开启微信提醒'), '大卡这条三种都允许过')
  const turnOn = buttons(tree).filter((node) => text(node) === '开启微信提醒')
  assert.equal(turnOn.length, 1, '只有缺提醒的那条给按钮')

  turnOn[0].props.onClick()
  await settle()
  assert.deepEqual(notices.asked, [['reminder']], '已确认的只要提醒和取消，取消已经有了')
  assert.deepEqual(notices.saved, [['r-later', ['reminder']]])
  assert.equal(refreshed, 1)

  answer = []
  buttons(page.render())
    .find((node) => text(node) === '开启微信提醒')
    .props.onClick()
  await settle()
  assert.equal(notices.saved.length, 1, '全拒绝不提交')
  const modal = calls.find((call) => call.api === 'showModal')
  assert.equal(modal?.args.title, '没有开启微信提醒')
  assert.ok(modal?.args.content.includes('「设置」'))
})

test('我的预约：门店没开顾客通知时不提微信提醒', async () => {
  const reservations = [noticeEntry('r-first', 'confirmed', [], '2099-01-02T06:00:00.000Z')]
  const off = text((await myReservationsPage({ ...viewWith(), noticeTemplates: [], reservations })).render())
  assert.equal(off.includes('微信提醒'), false)
})

// 2026-10-27 起顾客取消预约不再点一下就生效：从底下弹出来，先选原因（选「其他」要写一句）才能确认，原因跟着提交。
// 「到店扫码入座」只在预约当天给。
test('我的预约：取消先弹出来选原因，没选不能确认，「再想想」不取消', async () => {
  const view = { ...viewWith(), reservations: [noticeEntry('r-first', 'confirmed', [], '2099-01-02T06:00:00.000Z')] }
  const submitted: any[] = []
  const { calls, taro } = taroCalls()
  let refreshed = 0
  const page = await myReservationsPage(
    view,
    submitted,
    true,
    { '@tarojs/taro': { default: { navigateTo: async () => {}, ...taro } } },
    async () => {
      refreshed++
    },
  )
  const sheet = () => nodes(page.render(), (node) => cls(node) === 'cancel-sheet')[0]
  const button = (name: string) => buttons(sheet()).find((node) => text(node) === name)
  const open = () =>
    buttons(page.render())
      .find((node) => text(node) === '取消预约')
      .props.onClick()
  assert.equal(text(page.render()).includes('到店扫码入座'), false, '不是今天的预约不给扫码入座')
  assert.equal(sheet(), undefined)

  open()
  assert.ok(text(sheet()).includes('取消这次预约？'))
  assert.ok(text(sheet()).includes('B1 · 3 小时'), text(sheet()))
  assert.equal(button('确认取消').props.disabled, true, '没选原因不能确认')
  button('再想想').props.onClick()
  assert.equal(sheet(), undefined, '「再想想」收起，不取消')
  assert.equal(submitted.length, 0)

  open()
  button('其他').props.onClick()
  assert.equal(button('确认取消').props.disabled, true, '选「其他」还要写一句')
  const mask = () => nodes(page.render(), (node) => cls(node) === 'cancel-sheet-mask')[0]
  mask().props.onClick()
  assert.equal(sheet(), undefined, '还没写字，点遮罩照常收起')
  open()
  button('其他').props.onClick()
  nodes(sheet(), (node) => node.type === 'Textarea')[0].props.onInput({ detail: { value: '  孩子发烧了  ' } })
  mask().props.onClick()
  assert.ok(sheet(), '写了字点遮罩不收起，免得误碰丢了')
  assert.equal(!!button('确认取消').props.disabled, false)
  button('确认取消').props.onClick()
  await settle()
  assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [
    { action: 'cancel', targetId: 'r-first', reason: '孩子发烧了' },
  ])
  assert.equal(sheet(), undefined, '取消成了收起')
  assert.equal(refreshed, 1)
  assert.equal(calls.find((call) => call.api === 'showToast')?.args.title, '已取消预约')
})

test('我的预约：今天的预约给「到店扫码入座」', async () => {
  const soon = new Date(Date.now() + 60_000).toISOString()
  const entry = noticeEntry('r-today', 'confirmed', [], soon)
  const body = text((await myReservationsPage({ ...viewWith(), reservations: [entry] })).render())
  // 按门店日期（UTC+8）比：测试正好跑在门店那天最后一分钟时，「一分钟后」已是明天，就不该有按钮
  const storeDay = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
  assert.equal(body.includes('到店扫码入座'), storeDay(Date.parse(soon)) === storeDay(Date.now()))
})
