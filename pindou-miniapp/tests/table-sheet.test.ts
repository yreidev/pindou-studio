import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { expand, label, nodes, settle } from './helpers/tree'
import { billingMock } from './helpers/billing'
import { sheetModule } from './helpers/sheet'

// 桌位页、现场页的底部弹层（2026-10-20 起代替原来的开台页、会话页和「会员与计时 › 计时」）：
// 点空桌弹「开台」，点使用中的桌弹「会话」；整桌开台的会话走 /venue-sessions PATCH，扫码入座的按座会话走 loyalty.action。
// ★ 按座会话没有「陪客」：以前点它落到 renew 上，给顾客订单多加了一笔续时费。续时按套餐追加，先确认金额。

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      return fn()
    },
  }
}

const now = Date.parse('2026-10-05T06:00:00Z') // 门店时间 14:00
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

const table = (extra = {}) => ({
  id: 't-A3',
  code: 'A3',
  number: 3,
  zone: 'A',
  floorAreaId: 'area',
  seatCount: 1,
  enabled: true,
  occupancy: 'occupied',
  ...extra,
})

const seatSession = (extra = {}) => ({
  id: 's-A3',
  serviceTableId: 't-A3',
  status: 'active',
  timingMode: 'timed',
  durationMinutes: 120,
  startedAt: at(-125),
  accountId: 'u-1',
  admissionId: 'a-1',
  seatNumber: 1,
  ...extra,
})

const wholeSession = (extra = {}) => ({
  id: 's-B1',
  serviceTableId: 't-A3',
  status: 'active',
  timingMode: 'timed',
  durationMinutes: 120,
  startedAt: at(-30),
  ...extra,
})

const admission = (extra = {}) => ({
  displayStatus: 'confirmed',
  admission: {
    id: 'a-1',
    accountId: 'u-1',
    serviceTableId: 't-A3',
    seatNumber: 1,
    status: 'confirmed',
    package: { id: 'p-2h', name: '畅玩 2 小时', durationMinutes: 120, renewalMinutes: 30, renewalCents: 2000 },
  },
  session: { id: 's-A3', serviceTableId: 't-A3', seatNumber: 1, status: 'active' },
  sessionVersion: 'v-A3',
  customer: { id: 'u-1', nickname: '小林', phoneMasked: '136****1111' },
  order: { id: 'o-A3', status: 'draft' },
  ...extra,
})

type Options = {
  billing?: boolean
  confirm?: boolean
  roles?: string[]
  rules?: unknown[]
  updateResult?: Record<string, unknown>
  tapIndex?: number
  /** 带输入框的弹窗里填的字（showModal 的 editable）。 */
  modalContent?: string
}

async function sheets({
  billing = true,
  confirm = true,
  roles = ['clerk'],
  rules = [],
  updateResult = {},
  tapIndex = 0,
  modalContent,
}: Options = {}) {
  const { draftOrderNotice } = await load('services/staff.ts')
  const h = hooks()
  const created: any[] = []
  const staffCalls: any[] = []
  const loyaltyCalls: any[] = []
  const modalCalls: { title?: string; content: string; confirmText?: string; editable?: boolean }[] = []
  const sheetItems: string[][] = []
  const toasts: string[] = []
  const pages: string[] = []
  let sheetData: any = null
  const mod = await load('components/staff/table-sheet.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text', Picker: 'Picker', Input: 'Input' },
    '@tarojs/taro': {
      default: {
        showToast({ title }: { title: string }) {
          toasts.push(title)
        },
        showModal: async (options: { title?: string; content: string; confirmText?: string; editable?: boolean }) => {
          modalCalls.push(options)
          return { confirm, content: modalContent }
        },
        showActionSheet: async ({ itemList }: { itemList: string[] }) => {
          sheetItems.push(itemList)
          return { tapIndex }
        },
      },
    },
    '../button': { Button: 'Button' },
    '../sheet': sheetModule,
    '../../hooks/billing': billingMock(billing),
    '../../hooks/query': {
      usePublicQuery: () => ({ data: rules }),
      useRefreshAll: () => async () => {},
      useStaffQuery: (key: unknown[]) =>
        key[0] === 'accounts' ? { data: null } : { data: sheetData, loading: false, error: '', updatedAt: now },
    },
    '../../hooks/customer': { useCustomer: () => ({ account: { roles } }) },
    '../../hooks/clock': { useNow: () => now },
    '../../hooks/server-search': { useServerSearch: () => ({ items: [], loading: false, ready: false, error: '' }) },
    '../../hooks/leave-guard': { useLeaveGuard() {} },
    '../../services/staff': {
      staffApi: {
        createSession: async (input: unknown) => created.push(input),
        updateSession: async (id: string, patch: unknown) => {
          staffCalls.push({ id, patch })
          return { id, ...updateResult }
        },
        cancelSession: async (id: string) => staffCalls.push({ id, cancel: true }),
        createOrder: async () => ({ id: 'o-new' }),
      },
      staffMessage: (e: Error) => e.message,
      draftOrderNotice,
    },
    '../../services/membership': {
      loyalty: {
        action: async (input: unknown) => loyaltyCalls.push(input),
        public: async () => [],
        shift: async () => null,
      },
    },
    '../../services/member-code': { scanMemberCode: async () => ({ kind: 'cancelled' }) },
    '../../services/navigation': { navigateApp: async (url: string) => pages.push(url) },
    './account-search': { accountText: (value: { nickname?: string }) => value.nickname || '' },
  })
  const view = (fn: () => any) => () => expand(h.render(fn), [mod.StaffSheet, sheetModule.SheetFrame])
  const button = (tree: unknown, text: string | RegExp) =>
    nodes(
      tree,
      (node) => node.type === 'Button' && (typeof text === 'string' ? label(node) === text : text.test(label(node))),
    )
  return {
    mod,
    created,
    staffCalls,
    loyaltyCalls,
    modalCalls,
    sheetItems,
    toasts,
    pages,
    button,
    start: (extra = {}) => view(() => mod.StartSheet({ table: table({ occupancy: 'idle', ...extra }), onClose() {} })),
    session: (data: { session: any; tables?: any[]; admission?: any }) => {
      sheetData = {
        sessions: [data.session],
        tables: data.tables || [table()],
        shift: data.admission ? { admissions: [data.admission], tables: [] } : null,
      }
      return view(() => mod.SessionSheet({ table: (data.tables || [table()])[0], onClose() {} }))
    },
  }
}

const timer = (tree: unknown) => nodes(tree, (node) => node.props.className?.startsWith?.('table-sheet-timer '))[0]

// ——— 开台 ———

test('开台没动过开始时间：不带开始时间，由服务器在点确认后收到请求时开始计，不是打开弹层的那一刻', async () => {
  const realNow = Date.now
  let clock = Date.parse('2026-10-06T06:00:00Z') // 门店时间 14:00
  const RealDate = Date
  globalThis.Date = class extends RealDate {
    constructor(...args: any[]) {
      super(...((args.length ? args : [clock]) as []))
    }
    static now() {
      return clock
    }
  } as DateConstructor
  try {
    const page = await sheets()
    const render = page.start()
    const startLine = nodes(render(), (node) => node.props.className === 'table-sheet-start-copy')[0]
    assert.match(label(startLine), /从现在开始计/)
    clock += 25 * 60_000 // 找顾客、等注册，25 分钟后才点确认
    await page.button(render(), '确认开台')[0].props.onClick()
    await settle()
    assert.equal(page.created.length, 1)
    // 「现在」不带开始时间：服务器收到时开始计（25 分钟后点确认就从那时算），也不看手机时钟
    assert.equal('startedAt' in page.created[0], false)
    assert.equal(page.created[0].durationMinutes, 120, '读不到套餐时默认 2 小时')

    // 回填过的就按回填的时间：门店时间 13:30
    const backfilled = await sheets({ roles: ['manager'] })
    const again = backfilled.start()
    const time = nodes(again(), (node) => node.type === 'Picker' && node.props.mode === 'time')[0]
    time.props.onChange({ detail: { value: '13:30' } })
    assert.match(label(nodes(again(), (node) => node.props.className === 'table-sheet-start-copy')[0]), /从13:30开始计/)
    await backfilled.button(again(), '确认开台')[0].props.onClick()
    await settle()
    assert.equal(backfilled.created[0].startedAt, '2026-10-06T05:30:00.000Z')
  } finally {
    globalThis.Date = RealDate
    Date.now = realNow
  }
})

test('开到打烊：不带时长，带 untilClose，由服务器算到打烊；写清之后不能暂停、续时、标陪客', async () => {
  const page = await sheets()
  const render = page.start()
  page.button(render(), '到打烊')[0].props.onClick()
  const tree = render()
  assert.ok(label(tree).includes('从开始时间算到今天打烊，之后不能暂停、续时、标陪客'))
  assert.ok(label(tree).includes('散客 · 到打烊'), `底栏写到打烊：${label(tree)}`)
  await page.button(tree, '确认开台')[0].props.onClick()
  await settle()
  assert.deepEqual(page.created, [
    { serviceTableId: 't-A3', accountId: undefined, timingMode: 'timed', untilClose: true },
  ])
})

test('开台时长用已发布套餐的时长、标上价；「其他时长」30 分钟一档；收费关着不标价', async () => {
  const rules = [
    { kind: 'package', durationMinutes: 60, amountCents: 3800 },
    { kind: 'package', durationMinutes: 120, amountCents: 5800 },
    { kind: 'package', untilClose: true, durationMinutes: 0, amountCents: 8800 },
  ]
  const page = await sheets({ rules })
  const render = page.start()
  assert.deepEqual(
    nodes(render(), (node) => node.type === 'Button' && /^\d/.test(label(node))).map((node) => node.props.ariaLabel),
    ['1 小时，¥38.00', '2 小时，¥58.00，已选中'],
  )
  const other = nodes(render(), (node) => node.type === 'Picker' && node.props.mode === 'selector')[0]
  assert.equal(other.props.range.length, 16)
  assert.equal(other.props.range[0], '30 分钟')
  assert.equal(other.props.range.at(-1), '8 小时')
  other.props.onChange({ detail: { value: 4 } }) // 2 小时 30 分
  assert.ok(label(render()).includes('散客 · 2 小时 30 分'))
  await page.button(render(), '确认开台')[0].props.onClick()
  await settle()
  assert.equal(page.created[0].durationMinutes, 150)

  const off = await sheets({ rules, billing: false })
  const tree = off.start()()
  assert.equal(label(tree).includes('¥'), false)
})

// ——— 会话：按座（扫码入座） ———

test('按座会话没有陪客；续时按套餐、先确认加收金额，取消就不发；暂停走 loyalty 带计时版本', async () => {
  const page = await sheets()
  const render = page.session({
    session: seatSession(),
    tables: [table({ timingStatus: 'overdue', endsAt: at(-5), remainingSeconds: 0 })],
    admission: admission({ remainingSeconds: 0, overdueSeconds: 300 }),
  })
  assert.equal(page.button(render(), /陪客/).length, 0)
  assert.equal(timer(render()).props.ariaLabel, '已超时 +05:00')

  await page.button(render(), '续 30 分钟 +¥20.00')[0].props.onClick()
  await settle()
  assert.deepEqual(
    page.modalCalls.map((call) => `${call.content}/${call.confirmText}`),
    ['追加 30 分钟及 ¥20.00 费用？/确认续时'],
  )
  assert.deepEqual(page.loyaltyCalls, [{ action: 'renew', targetId: 's-A3', expectedVersion: 'v-A3' }])
  assert.deepEqual(page.staffCalls, [])

  await page.button(render(), '暂停')[0].props.onClick()
  await settle()
  assert.deepEqual(page.loyaltyCalls.at(-1), { action: 'pause', targetId: 's-A3', expectedVersion: 'v-A3' })

  const cancelled = await sheets({ confirm: false })
  const again = cancelled.session({
    session: seatSession(),
    admission: admission({ remainingSeconds: 1800 }),
  })
  assert.equal(timer(again()).props.ariaLabel, '还剩 30:00')
  await cancelled.button(again(), /^续 30 分钟/)[0].props.onClick()
  await settle()
  assert.equal(cancelled.modalCalls.length, 1)
  assert.deepEqual(cancelled.loyaltyCalls, [])
})

test('按座会话停止计时后只剩去收款；套餐不能续时就不给点', async () => {
  const page = await sheets()
  const stopped = page.session({ session: seatSession({ stoppedAt: at(-1) }), admission: admission() })
  assert.equal(timer(stopped()).props.ariaLabel.startsWith('计时已停止'), true)
  assert.equal(page.button(stopped(), '暂停').length, 0)
  assert.equal(page.button(stopped(), /^续/).length, 0)
  assert.equal(page.button(stopped(), '停止计时').length, 0)
  const [checkout] = page.button(stopped(), /^去收款/)
  assert.equal(checkout.props.disabled, false)
  await checkout.props.onClick()
  await settle()
  assert.deepEqual(page.pages, ['/pages/staff/checkout/index?id=o-A3'], '按座会话的单开台时就有了')

  const fixed = await sheets()
  const render = fixed.session({
    session: seatSession(),
    admission: admission({
      admission: { ...admission().admission, package: { id: 'p', name: '固定', renewalMinutes: 0, renewalCents: 0 } },
    }),
  })
  assert.equal(fixed.button(render(), '套餐不能续时')[0].props.disabled, true)
})

test('收费关着：按座会话的「结束」走 loyalty end，带会话版本', async () => {
  const page = await sheets({ billing: false })
  const render = page.session({ session: seatSession({ startedAt: at(-30) }), admission: admission() })
  await page.button(render(), '结束，放出座位')[0].props.onClick()
  await settle()
  assert.deepEqual(page.loyaltyCalls, [{ action: 'end', targetId: 's-A3', expectedVersion: 'v-A3' }])
  assert.equal(page.staffCalls.length, 0)
})

// ——— 会话：整桌开台 ———

test('整桌会话：标陪客先确认、写清后果，确认后 PATCH companion；取消就不发', async () => {
  const page = await sheets()
  const render = page.session({
    session: seatSession({ admissionId: undefined, accountId: undefined }),
    tables: [table({ timingStatus: 'overdue', endsAt: at(-7), remainingSeconds: 0 })],
  })
  assert.equal(timer(render()).props.ariaLabel, '已超时 +07:00')
  await page.button(render(), '这桌是陪客？标记陪客（不计时）')[0].props.onClick()
  await settle()
  const [ask] = page.modalCalls
  assert.equal(ask.title, '标记陪客')
  assert.equal(ask.confirmText, '标记陪客')
  assert.match(ask.content, /不计时、不收计时费/)
  assert.match(ask.content, /不能再暂停或继续/)
  assert.match(ask.content, /改不回普通计时/)
  assert.match(ask.content, /标错了只能撤销开台后重开/)
  assert.deepEqual(page.staffCalls, [{ id: 's-A3', patch: { status: 'companion' } }])
  assert.deepEqual(page.loyaltyCalls, [])
  assert.deepEqual(page.toasts, ['已标记陪客'])

  const cancelled = await sheets({ confirm: false })
  const again = cancelled.session({ session: seatSession({ admissionId: undefined, accountId: undefined }) })
  await cancelled.button(again(), /标记陪客/)[0].props.onClick()
  await settle()
  assert.deepEqual(cancelled.staffCalls, [])
})

// 整桌续时以前发「读到的时长 + N」的绝对值：两人同时续或页面过期会互相覆盖、把时长改短。
// 现在发追加的分钟数和看到的时长，后端核对后再加；草稿订单没能跟着改价时（员工改过明细）要提示去核对。
test('整桌续时发追加分钟数和看到的时长；草稿没跟着改价时提示去结账页核对', async () => {
  const renewal = { minutes: 30, amountCents: 1500, packageName: '1小时' }
  const whole = { session: seatSession({ admissionId: undefined, accountId: undefined, durationMinutes: 60, renewal }) }
  const page = await sheets({
    updateResult: { durationMinutes: 90, draftOrder: { id: 'o-1', repriced: false, receivableCents: 2500 } },
  })
  const render = page.session(whole)
  await page.button(render(), '续时')[0].props.onClick()
  await settle()
  // 按开台时记下的续时方案列 1、2、3 块，另能自己填
  assert.deepEqual(page.sheetItems, [['续 30 分钟', '续 1 小时', '续 1 小时 30 分', '其他时长']])
  assert.deepEqual(page.staffCalls, [{ id: 's-A3', patch: { extendMinutes: 30, expectedDurationMinutes: 60 } }])
  assert.equal(page.modalCalls.length, 1)
  assert.match(page.modalCalls[0].content, /没有按新时长自动改价（现在应收 ¥25\.00）/)

  const repriced = await sheets({
    tapIndex: 1,
    updateResult: { durationMinutes: 120, draftOrder: { id: 'o-1', repriced: true, receivableCents: 4490 } },
  })
  const again = repriced.session(whole)
  await repriced.button(again(), '续时')[0].props.onClick()
  await settle()
  assert.deepEqual(repriced.staffCalls[0].patch, { extendMinutes: 60, expectedDurationMinutes: 60 })
  assert.deepEqual(repriced.modalCalls, [])
  assert.deepEqual(repriced.toasts, ['待结账订单已按新时长改为 ¥44.90'])
})

// 选「其他时长」或这一台对不上带续时方案的套餐（后端不给 renewal）：弹输入框自己填，填得不对不发。
test('整桌续时自己填分钟：「其他时长」或没有续时方案时弹输入框，填得不对不发', async () => {
  const renewal = { minutes: 30, amountCents: 1500, packageName: '1小时' }
  const other = await sheets({ tapIndex: 3, modalContent: ' 45 ' })
  const withPlan = other.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, durationMinutes: 60, renewal }),
  })
  await other.button(withPlan(), '续时')[0].props.onClick()
  await settle()
  assert.equal(other.modalCalls[0].editable, true)
  assert.deepEqual(other.staffCalls, [{ id: 's-A3', patch: { extendMinutes: 45, expectedDurationMinutes: 60 } }])

  const noPlan = await sheets({ modalContent: '90' })
  const bare = noPlan.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, durationMinutes: 45 }),
  })
  await noPlan.button(bare(), '续时')[0].props.onClick()
  await settle()
  assert.deepEqual(noPlan.sheetItems, [], '没有续时方案时不列选项，直接填')
  assert.deepEqual(noPlan.staffCalls, [{ id: 's-A3', patch: { extendMinutes: 90, expectedDurationMinutes: 45 } }])

  for (const text of ['', '0', '1441', '1.5', 'abc']) {
    const wrong = await sheets({ modalContent: text })
    const again = wrong.session({
      session: seatSession({ admissionId: undefined, accountId: undefined, durationMinutes: 45 }),
    })
    await wrong.button(again(), '续时')[0].props.onClick()
    await settle()
    assert.deepEqual(wrong.staffCalls, [], text)
    assert.deepEqual(wrong.toasts, ['续时要填 1 到 1440 的整数分钟'], text)
  }
  const cancelled = await sheets({ confirm: false, modalContent: '30' })
  const again = cancelled.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, durationMinutes: 45 }),
  })
  await cancelled.button(again(), '续时')[0].props.onClick()
  await settle()
  assert.deepEqual(cancelled.staffCalls, [])
})

// 陪客只记在会话状态上：陪客 → 暂停 → 继续就成了普通计时，建单按套餐价收了陪客的钱。陪客会话不给这两个按钮。
test('陪客会话不给暂停、继续、续时和停止计时；暂停中的给「继续」', async () => {
  const page = await sheets()
  const render = page.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, status: 'companion' }),
  })
  for (const text of ['暂停', '继续', '续时', '停止计时']) assert.equal(page.button(render(), text).length, 0, text)
  assert.equal(page.button(render(), /标记陪客/).length, 0)

  const paused = await sheets()
  const again = paused.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, status: 'paused' }),
  })
  assert.equal(paused.button(again(), '继续').length, 1)
})

// 整桌开台也能停止计时（2026-10-06 业主定，同按座会话）：先确认、写清后果，确认按钮最多 4 个字。
test('整桌会话停止计时先确认、写清后果；取消就不发', async () => {
  const cancelled = await sheets({ confirm: false })
  const render = cancelled.session({ session: seatSession({ admissionId: undefined, accountId: undefined }) })
  await cancelled.button(render(), '停止计时')[0].props.onClick()
  await settle()
  const [ask] = cancelled.modalCalls
  assert.equal(ask.title, '停止计时')
  assert.equal(ask.confirmText, '停止计时')
  assert.match(ask.content, /保留座位直到结账/)
  assert.match(ask.content, /按这一刻算、不再变/)
  assert.match(ask.content, /不能再暂停、继续或续时/)
  assert.deepEqual(cancelled.staffCalls, [])

  const page = await sheets()
  const again = page.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, status: 'paused' }),
  })
  await page.button(again(), '停止计时')[0].props.onClick()
  await settle()
  assert.deepEqual(page.staffCalls, [{ id: 's-A3', patch: { stop: true } }])
  assert.deepEqual(page.loyaltyCalls, [])
  assert.deepEqual(page.toasts, ['已停止计时'])
})

test('整桌会话停止计时后只剩换桌、撤销和去收款；去收款这时建单', async () => {
  const page = await sheets()
  const render = page.session({
    session: seatSession({ admissionId: undefined, accountId: undefined, stoppedAt: at(-1) }),
    tables: [
      table({ stopped: true, timingStatus: 'overdue', endsAt: at(-5), remainingSeconds: 0, estimatedCents: 5800 }),
      table({ id: 't-A4', code: 'A4', number: 4, occupancy: 'idle' }),
    ],
  })
  for (const text of ['暂停', '继续', '续时', '停止计时']) assert.equal(page.button(render(), text).length, 0, text)
  assert.equal(page.button(render(), /标记陪客/).length, 0)
  const sheet = nodes(render(), (node) => node.props.role === 'dialog')[0]
  assert.equal(sheet.props.ariaLabel, 'A3 待结账')
  const move = nodes(render(), (node) => node.type === 'Picker')[0]
  assert.deepEqual(move.props.range, ['A4'])
  assert.equal(page.button(render(), '开错了？撤销这次开台').length, 1)
  await page.button(render(), '去收款 ¥58.00')[0].props.onClick()
  await settle()
  assert.deepEqual(page.pages, ['/pages/staff/checkout/index?id=o-new'])
})

// 系统内收费关着（2026-10-10 起，钱在美团、大众点评收）：不显示应收、不给停止计时和去收款，底部是「结束，放出座位」。
test('收费关着：整桌会话没有应收、停止计时和去收款，点「结束」先确认再 PATCH end；取消就不发', async () => {
  const page = await sheets({ billing: false })
  const render = page.session({
    session: wholeSession(),
    tables: [table({ estimatedCents: 5800, charge: { summary: '按套餐' } })],
  })
  const text = label(render())
  assert.equal(text.includes('应收'), false)
  assert.equal(text.includes('按套餐'), false)
  assert.equal(page.button(render(), '停止计时').length, 0)
  assert.equal(page.button(render(), /去收款/).length, 0)
  await page.button(render(), '结束，放出座位')[0].props.onClick()
  await settle()
  assert.equal(page.modalCalls.at(-1)?.title, '结束并放座')
  assert.equal(page.modalCalls.at(-1)?.confirmText, '结束')
  assert.deepEqual(page.staffCalls, [{ id: 's-B1', patch: { end: true } }])

  const cancelled = await sheets({ billing: false, confirm: false })
  const again = cancelled.session({ session: wholeSession() })
  await cancelled.button(again(), '结束，放出座位')[0].props.onClick()
  await settle()
  assert.equal(cancelled.staffCalls.length, 0)
})

test('整桌开到打烊：不给暂停、继续、续时、陪客，时长写到打烊', async () => {
  const page = await sheets()
  const render = page.session({ session: wholeSession({ untilClose: true, durationMinutes: 300 }) })
  const text = label(render())
  assert.ok(text.includes('到打烊'))
  assert.ok(text.includes('用到今天打烊：不能暂停、续时'))
  for (const value of ['暂停', '继续', '续时']) assert.equal(page.button(render(), value).length, 0, value)
  assert.equal(page.button(render(), /标记陪客/).length, 0)
})

// ——— 现场页「等你处理」里的扫码入座申请 ———

async function admissionRow(entry: unknown, billing = false, confirm = true) {
  const h = hooks()
  const calls: unknown[] = []
  const modals: { title?: string; content: string }[] = []
  const { AdmissionRow } = await load('components/staff/admission-row.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '@tarojs/taro': {
      default: {
        showToast() {},
        showModal: async (options: { title?: string; content: string }) => {
          modals.push(options)
          return { confirm }
        },
      },
    },
    '../button': { Button: 'Button' },
    '../../hooks/query': { useRefreshAll: () => async () => {} },
    '../../services/membership': { loyalty: { action: async (input: unknown) => calls.push(input) } },
    '../../services/staff': { staffMessage: (e: Error) => e.message },
  })
  const render = () =>
    h.render(() => AdmissionRow({ entry, tables: [{ id: 'tbl', code: 'C1', number: 1, seatCount: 1 }], billing, now }))
  const button = (text: string) => nodes(render(), (node) => node.type === 'Button' && label(node) === text)[0]
  return { render, button, calls, modals }
}

const waiting = {
  displayStatus: 'pending',
  admission: {
    id: 'waiting',
    serviceTableId: 'tbl',
    seatNumber: 1,
    status: 'pending',
    createdAt: at(-12),
    package: { id: 'p', name: '1 小时', durationMinutes: 60, amountCents: 3800 },
    coupon: { platform: 'dianping', code: '9999' },
  },
  // 失效时刻由后端给（申请时刻加确认时限），前端不记时限
  expiresAt: at(18),
  customer: { id: 'u-1', nickname: '小林' },
}

test('确认入座：收费关着不提价格；团购没改不带，改了才带（去掉空格），清空时带空平台', async () => {
  const page = await admissionRow(waiting)
  assert.ok(label(page.render()).includes('C1 · 小林 · 60 分钟'))
  assert.ok(label(page.render()).includes('大众点评 · 券码 9999（请先在美团开店宝验券）'))
  assert.ok(label(page.render()).includes('13:48 申请，再过 18 分钟失效'))
  // 后端改了时限，跟着后端走；读不到失效时刻只写几点申请
  assert.ok(
    label((await admissionRow({ ...waiting, expiresAt: at(5) })).render()).includes('13:48 申请，再过 5 分钟失效'),
  )
  const unknown = label((await admissionRow({ ...waiting, expiresAt: undefined })).render())
  assert.ok(unknown.includes('13:48 申请') && !unknown.includes('分钟失效'))

  await page.button('确认开始计时').props.onClick()
  await settle()
  assert.equal(page.modals[0].content, 'C1 开始计时：60 分钟？')
  assert.deepEqual(page.calls[0], { action: 'confirm', targetId: 'waiting' })

  page.button('改团购').props.onClick()
  const fields = () => nodes(page.render(), (node) => node.type?.name === 'CouponFields')[0]
  assert.deepEqual(fields().props.value, { platform: 'dianping', code: '9999' }, '从申请里的团购开始改')
  fields().props.onChange({ platform: 'meituan', code: '1234 5678 9012' })
  await page.button('确认开始计时').props.onClick()
  await settle()
  assert.deepEqual(page.calls[1], {
    action: 'confirm',
    targetId: 'waiting',
    coupon: { platform: 'meituan', code: '123456789012' },
  })

  // 改成「不填」：带空平台，清掉顾客填的（确认成功后编辑框收起，重新点「改团购」）
  page.button('改团购').props.onClick()
  fields().props.onChange({ platform: '', code: '' })
  await page.button('确认开始计时').props.onClick()
  await settle()
  assert.deepEqual((page.calls[2] as { coupon: unknown }).coupon, { platform: '', code: '' })

  const priced = await admissionRow(waiting, true)
  await priced.button('确认开始计时').props.onClick()
  await settle()
  assert.equal(priced.modals[0].content, 'C1 开始计时：60 分钟，¥38.00？')
})

test('拒绝申请先确认，写清顾客要重新扫码；取消就不发', async () => {
  const cancelled = await admissionRow(waiting, false, false)
  await cancelled.button('拒绝').props.onClick()
  await settle()
  assert.match(cancelled.modals[0].content, /拒绝 小林 在 C1 的入座申请？顾客要重新扫码申请/)
  assert.deepEqual(cancelled.calls, [])

  const page = await admissionRow(waiting)
  await page.button('拒绝').props.onClick()
  await settle()
  assert.deepEqual(page.calls, [{ action: 'reject', targetId: 'waiting' }])
})
