import { describe, expect, it } from 'vitest'
import layout from '../../../../layout/store-layout.json'
import type {
  AdmissionView,
  BoardData,
  PackageRule,
  ReservationEntry,
  ServiceTable,
  VenueSession,
} from '../../api/board'
import {
  boardSeats,
  customerText,
  draftOrderNotice,
  lateMinutes,
  openable,
  pendingAdmissions,
  primarySession,
  refetchInterval,
  reminders,
  reminderText,
  remainingSeconds,
  renewChoices,
  renewMinutes,
  seatPlace,
  seatingPlan,
  seatShortText,
  seatState,
  seatStateNames,
  seatStateOrder,
  sessionActions,
  stateCounts,
  tablePlace,
  timingText,
  upcomingReservations,
  type BoardSeat,
} from './board'
import { boxOf, planSeats, planSize } from './layout'

const now = Date.parse('2026-10-05T06:00:00Z') // 门店 14:00
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

const table = (code: string, extra: Partial<ServiceTable> = {}): ServiceTable => ({
  id: `t-${code}`,
  code,
  zone: code[0],
  floorAreaId: `area-${code[0]}`,
  number: Number(code.slice(1)),
  seatCount: 1,
  wholeTable: false,
  enabled: true,
  occupancy: 'idle',
  seatBased: false,
  ...extra,
})
const busy = (code: string, endsInMinutes: number, extra: Partial<ServiceTable> = {}) =>
  table(code, {
    occupancy: 'occupied',
    startedAt: at(-60),
    endsAt: at(endsInMinutes),
    remainingSeconds: Math.max(0, endsInMinutes * 60),
    timingStatus: endsInMinutes < 0 ? 'overdue' : endsInMinutes <= 10 ? 'expiring' : 'running',
    ...extra,
  })
const session = (code: string, extra: Partial<VenueSession> = {}): VenueSession => ({
  id: `s-${code}`,
  serviceTableId: `t-${code}`,
  startedAt: at(-60),
  timingMode: 'timed',
  durationMinutes: 120,
  status: 'active',
  ...extra,
})
const pkg = {
  id: 'p1',
  kind: 'package',
  name: '畅玩 2 小时',
  enabled: true,
  amountCents: 8800,
  giftCents: 0,
  points: 0,
  rateBasisPoints: 0,
  maxBasisPoints: 0,
  minimumPoints: 0,
  validDays: 0,
  mode: '',
  scope: '',
  stack: false,
  productId: '',
  quantity: 0,
  perUserLimit: 0,
  durationMinutes: 120,
  renewalMinutes: 30,
  renewalCents: 2000,
  pauseLimitMinutes: 15,
  overtime: 'manual',
} satisfies AdmissionView['admission']['package']
const admission = (id: string, extra: Partial<AdmissionView> = {}, created = -5): AdmissionView => ({
  admission: {
    id,
    accountId: `u-${id}`,
    serviceTableId: 't-C1',
    seatNumber: 1,
    package: pkg,
    status: 'pending',
    createdAt: at(created),
  },
  displayStatus: 'pending',
  customer: { id: `u-${id}`, nickname: `顾客${id}`, phoneMasked: '138****0000' },
  ...extra,
})
const booking = (
  id: string,
  startsIn: number,
  extra: Partial<ReservationEntry['reservation']> = {},
  status = 'confirmed',
) =>
  ({
    reservation: {
      id,
      serviceTableId: 't-B1',
      seatNumber: 1,
      packageId: 'p1',
      packageName: '畅玩 2 小时',
      durationMinutes: 120,
      amountCents: 8800,
      startAt: at(startsIn),
      status: status === 'pending' ? 'pending' : 'confirmed',
      createdBy: 'u-staff',
      createdAt: at(-600),
      ...extra,
    },
    displayStatus: status,
    endAt: at(startsIn + 120),
  }) as ReservationEntry
const data = (extra: Partial<BoardData> = {}): BoardData => ({
  tables: planSeats.map((seat) => table(seat.code)),
  sessions: [],
  admissions: [],
  reservations: [],
  packages: [],
  closeMinute: 22 * 60,
  shiftTables: [],
  ...extra,
})
const seatOf = (seats: BoardSeat[], code: string) => seats.find((seat) => seat.code === code) as BoardSeat

describe('平面图', () => {
  it('座位与热区取自门店布局，按底图百分比定位', () => {
    expect(planSeats.map((seat) => seat.code)).toEqual(layout.tables.map((t) => t.code))
    expect(planSize).toEqual({ width: layout.plan.width, height: layout.plan.height })
    const a1 = planSeats.find((seat) => seat.code === 'A1')!
    expect(boxOf(a1)).toEqual({
      left: `${((a1.x / planSize.width) * 100).toFixed(3)}%`,
      top: `${((a1.y / planSize.height) * 100).toFixed(3)}%`,
      width: `${((a1.w / planSize.width) * 100).toFixed(3)}%`,
      height: `${((a1.h / planSize.height) * 100).toFixed(3)}%`,
    })
  })

  it('布局里有、接口里没有的桌按停用画，不能点', () => {
    const seats = boardSeats(data({ tables: [table('A1')] }), now)
    expect(seats).toHaveLength(planSeats.length)
    expect(seatOf(seats, 'A1').state).toBe('free')
    expect(seatOf(seats, 'B1').state).toBe('off')
    expect(openable(seatOf(seats, 'B1'))).toBe(false)
  })
})

describe('座位状态只认后端', () => {
  it('停用、空闲、使用中、快到点、超时按桌位接口的 enabled、occupancy 与 timingStatus', () => {
    expect(seatState(table('A1', { enabled: false, occupancy: 'occupied' }), undefined)).toBe('off')
    expect(seatState(table('A1'), session('A1'))).toBe('free')
    expect(seatState(busy('A1', 30), session('A1'))).toBe('running')
    expect(seatState(busy('A1', 8), session('A1'))).toBe('expiring')
    expect(seatState(busy('A1', -3), session('A1'))).toBe('overdue')
    // 剩余秒数看着快到点，后端没判就不算：不在前端自己判
    expect(seatState(busy('A1', 5, { timingStatus: 'running' }), session('A1'))).toBe('running')
  })

  it('已停止计时（待结账）与暂停优先于快到点和超时', () => {
    expect(seatState(busy('A1', -3), session('A1', { stoppedAt: at(-1) }))).toBe('stopped')
    expect(seatState(busy('A1', 5), session('A1', { status: 'paused', pausedAt: at(-2) }))).toBe('paused')
  })

  it('同桌多个会话时以开始时间和计时摘要对得上的那个为准', () => {
    const t = busy('D1', 20, { startedAt: at(-30) })
    const first = session('D1', { id: 's1', startedAt: at(-90), timingMode: 'free' })
    const second = session('D1', { id: 's2', startedAt: at(-30) })
    expect(primarySession(t, [first, second])?.id).toBe('s2')
    expect(primarySession(t, [first])?.id).toBe('s1')
    expect(primarySession(table('A1'), [first])).toBeUndefined()
  })
})

describe('倒数', () => {
  const fetchedAt = now - 20_000

  it('计时中按 endsAt 倒数，超时为负数', () => {
    const running = { table: busy('A1', 12), session: session('A1'), state: 'running' as const }
    expect(remainingSeconds(running, now, fetchedAt)).toBe(720)
    expect(remainingSeconds(running, now + 60_000, fetchedAt)).toBe(660)
    const overdue = { table: busy('A1', -5), session: session('A1'), state: 'overdue' as const }
    expect(remainingSeconds(overdue, now, fetchedAt)).toBe(-300)
  })

  it('暂停中停在读到那一刻，已停止的停在停止那一刻', () => {
    const paused = { table: busy('A1', 12), session: session('A1', { status: 'paused' }), state: 'paused' as const }
    expect(remainingSeconds(paused, now, fetchedAt)).toBe(740)
    expect(remainingSeconds(paused, now + 600_000, fetchedAt)).toBe(740)
    const stopped = {
      table: busy('A1', -4),
      session: session('A1', { stoppedAt: at(-10) }),
      state: 'stopped' as const,
    }
    expect(remainingSeconds(stopped, now, fetchedAt)).toBe(360)
  })

  it('自由计时、空闲、停用没有倒数', () => {
    const free = { table: busy('A1', 0, { endsAt: undefined }), session: session('A1', { timingMode: 'free' }) }
    expect(remainingSeconds({ ...free, state: 'running' }, now, now)).toBeNull()
    expect(remainingSeconds({ table: table('A1'), state: 'free' }, now, now)).toBeNull()
    expect(seatShortText({ state: 'running' }, null)).toBe('自由')
    expect(timingText({ state: 'running' }, null)).toBe('自由计时')
  })

  it('剩余分钟向上取整、不写负数；超时按整分钟向下取整（和计价一致）、至少 1 分', () => {
    expect(seatShortText({ state: 'running' }, 61)).toBe('剩2分')
    expect(seatShortText({ state: 'expiring' }, -5)).toBe('剩0分')
    expect(seatShortText({ state: 'overdue' }, -10)).toBe('超1分')
    expect(seatShortText({ state: 'overdue' }, -301)).toBe('超5分')
    expect(seatShortText({ state: 'overdue' }, -659)).toBe('超10分')
    expect(seatShortText({ state: 'overdue' }, -660)).toBe('超11分')
    expect(seatShortText({ state: 'paused' }, 100)).toBe('暂停')
    expect(seatShortText({ state: 'stopped' }, 100)).toBe('待结账')
    expect(timingText({ state: 'expiring' }, 480)).toBe('剩余 8 分钟')
    expect(timingText({ state: 'overdue' }, -300)).toBe('已超时 5 分钟')
    expect(timingText({ state: 'paused' }, 600)).toBe('暂停中，剩余 10 分钟')
    expect(timingText({ state: 'paused' }, -120)).toBe('暂停中，已超时 2 分钟')
    expect(timingText({ state: 'stopped' }, 0)).toBe('计时已停止，待结账')
  })
})

describe('快到点与超时', () => {
  it('只列后端判为快到点、超时的，按剩余时间排，超时最久的在最前', () => {
    const seats = boardSeats(
      data({
        tables: [
          busy('A1', 45),
          busy('A2', 6),
          busy('A3', -5),
          busy('A4', 3),
          busy('A5', -2),
          busy('B5', 9),
          busy('D1', -15, { seatCount: 2, wholeTable: true }),
          busy('A6', 0, { endsAt: undefined, timingStatus: undefined, timingMode: 'free' }),
        ],
        sessions: [
          session('A1'),
          session('A2'),
          session('A3'),
          session('A4', { status: 'paused' }),
          session('A5', { stoppedAt: at(-1) }),
          session('B5'),
          session('D1'),
          session('A6', { timingMode: 'free', durationMinutes: undefined }),
        ],
      }),
      now,
    )
    const list = reminders(seats, now, now)
    expect(list.map((item) => item.seat.code)).toEqual(['D1', 'A3', 'A2', 'B5'])
    expect(list.map(reminderText)).toEqual(['超时 15 分', '超时 5 分', '剩 6 分', '剩 9 分'])
    const counts = stateCounts(seats)
    expect(counts).toMatchObject({ running: 2, expiring: 2, overdue: 2, paused: 1, stopped: 1 })
    expect(counts.free + counts.off).toBe(planSeats.length - 8)
  })
})

describe('预约与入座申请', () => {
  it('即将到店：待确认、已确认、在窗口内的（含已到开始时间还没到店的），按开始时间排', () => {
    const entries = [
      booking('r-late', -10),
      booking('r-45', 45, {}, 'pending'),
      booking('r-20', 20),
      booking('r-90', 90),
      booking('r-expired', -60, {}, 'expired'),
      booking('r-seated', 5, {}, 'seated'),
    ]
    expect(upcomingReservations(entries, now, 60).map((e) => e.reservation.id)).toEqual(['r-late', 'r-20', 'r-45'])
    expect(upcomingReservations(entries, now, 30).map((e) => e.reservation.id)).toEqual(['r-late', 'r-20'])
    expect(lateMinutes(entries[0], now)).toBe(10)
    expect(lateMinutes(entries[2], now)).toBe(0)
  })

  it('座位上标出 30 分钟内要到店的预约里最早的一条', () => {
    const seats = boardSeats(
      data({
        reservations: [booking('r-40', 40), booking('r-25', 25), booking('r-10', 10, { serviceTableId: 't-E1' })],
      }),
      now,
    )
    expect(seatOf(seats, 'B1').booking?.reservation.id).toBe('r-25')
    expect(seatOf(seats, 'E1').booking?.reservation.id).toBe('r-10')
    expect(seatOf(seats, 'A1').booking).toBeUndefined()
  })

  // 到店开台按现行发布的套餐计时计价，不按预约时记下的快照：确认框要写后端实际会用的那个
  it('到店开台确认框写现行发布的套餐；改过就说明预约时是什么，停用了就不给开', () => {
    const rule = (extra: Partial<PackageRule> = {}) =>
      ({
        id: 'p1',
        kind: 'package',
        name: '畅玩 2 小时',
        durationMinutes: 120,
        amountCents: 8800,
        ...extra,
      }) as PackageRule
    const same = seatingPlan(booking('r', 10), [rule()], true)
    expect(same).toMatchObject({ changed: false, pkg: { id: 'p1' } })
    expect(same.text).toBe('按现行套餐「畅玩 2 小时」开台计时（120 分钟，¥88.00），生成套餐的待结账订单。')

    const repriced = seatingPlan(booking('r', 10), [rule({ amountCents: 9800, durationMinutes: 150 })], true)
    expect(repriced.changed).toBe(true)
    expect(repriced.text).toMatch(/按现行套餐「畅玩 2 小时」开台计时（150 分钟，¥98\.00）/)
    expect(repriced.note).toMatch(/预约时是「畅玩 2 小时」120 分钟、¥88\.00/)
    expect(same.note).toBeUndefined()

    const gone = seatingPlan(booking('r', 10), [rule({ id: 'p2' })], true)
    expect(gone.pkg).toBeUndefined()
    expect(gone.text).toMatch(/已停用，不能按预约到店开台/)
  })

  it('系统内收费关着：到店开台不写价格、不建单，只改了价格不算改过；到打烊的不比时长', () => {
    const rule = (extra: Partial<PackageRule> = {}) =>
      ({
        id: 'p1',
        kind: 'package',
        name: '畅玩 2 小时',
        durationMinutes: 120,
        amountCents: 8800,
        ...extra,
      }) as PackageRule
    const off = seatingPlan(booking('r', 10), [rule({ amountCents: 0 })], false)
    expect(off).toMatchObject({ changed: false, text: '按现行套餐「畅玩 2 小时」开台计时（120 分钟）。' })
    const longer = seatingPlan(booking('r', 10), [rule({ durationMinutes: 150 })], false)
    expect(longer.note).toBe('预约时是「畅玩 2 小时」120 分钟，套餐之后改过，开台按现行的计时。')
    const allDay = seatingPlan(booking('r', 10), [rule({ durationMinutes: 0, untilClose: true })], false)
    expect(allDay).toMatchObject({ changed: false, text: '按现行套餐「畅玩 2 小时」开台计时（到打烊）。' })
  })

  it('待确认入座看 displayStatus（过期的已存状态仍是 pending），先申请的在前', () => {
    const list = pendingAdmissions([
      admission('b', {}, -3),
      admission('a', {}, -20),
      admission('x', { displayStatus: 'expired' }, -40),
      admission('y', { displayStatus: 'confirmed' }, -1),
    ])
    expect(list.map((entry) => entry.admission.id)).toEqual(['a', 'b'])
  })
})

describe('会话详情', () => {
  it('按座会话：带 sessionVersion 才能操作；没停的先停止再结账；按套餐续时', () => {
    const view = admission('a', { displayStatus: 'confirmed', sessionVersion: 'v1' })
    const active = sessionActions({ session: session('A1', { admissionId: 'a' }), admission: view }, true)
    expect(active).toMatchObject({
      seatBased: true,
      pause: true,
      resume: false,
      renew: { kind: 'package', minutes: 30, cents: 2000 },
      stopFirst: true,
      checkoutLabel: '停止计时并去结账',
      waiting: false,
    })
    const paused = sessionActions(
      { session: session('A1', { admissionId: 'a', status: 'paused' }), admission: view },
      true,
    )
    expect(paused).toMatchObject({ pause: false, resume: true })
    const stopped = sessionActions(
      { session: session('A1', { admissionId: 'a', stoppedAt: at(-1) }), admission: view },
      true,
    )
    expect(stopped).toMatchObject({
      pause: false,
      resume: false,
      renew: null,
      stopFirst: false,
      checkoutLabel: '去结账',
    })
    expect(sessionActions({ session: session('A1', { admissionId: 'a' }) }, true)?.waiting).toBe(true)
    const noPause = admission('a', {
      sessionVersion: 'v1',
      admission: { ...view.admission, package: { ...pkg, pauseLimitMinutes: 0, renewalMinutes: 0 } },
    })
    expect(sessionActions({ session: session('A1', { admissionId: 'a' }), admission: noPause }, true)).toMatchObject({
      pauseBlocked: '这个套餐不能暂停',
      renew: null,
    })
  })

  it('整桌会话：暂停、继续改状态，按分钟续时，单独的「停止计时」，去结账不先停；自由计时不续时', () => {
    expect(sessionActions({ session: session('A2') }, true)).toMatchObject({
      seatBased: false,
      pause: true,
      resume: false,
      renew: { kind: 'minutes', plan: null },
      stop: true,
      stopFirst: false,
      checkoutLabel: '去结账',
    })
    // 后端给了续时方案（开台时记下的价）就带上，续时按钮按它给「续 N 分钟」
    const plan = { minutes: 30, amountCents: 1500, packageName: '畅玩 2 小时' }
    expect(sessionActions({ session: session('A2', { renewal: plan }) }, true)?.renew).toEqual({
      kind: 'minutes',
      plan,
    })
    expect(sessionActions({ session: session('A2', { status: 'paused' }) }, true)).toMatchObject({
      pause: false,
      resume: true,
      stop: true,
    })
    // 陪客不计时：没有停止计时
    expect(sessionActions({ session: session('A2', { status: 'companion' }) }, true)?.stop).toBe(false)
    // 停止计时、等结账的（同按座会话）：不能再暂停、继续、续时、标陪客，换桌、撤销、去结账照旧
    expect(sessionActions({ session: session('A2', { stoppedAt: at(-1) }) }, true)).toMatchObject({
      stop: false,
      pause: false,
      resume: false,
      renew: null,
      stopFirst: false,
      checkoutLabel: '去结账',
      move: 'table',
      companion: null,
      cancel: true,
    })
    // 按座会话的停止计时在「停止计时并去结账」里，不另给按钮
    expect(sessionActions({ session: session('A1', { admissionId: 'a' }) }, true)?.stop).toBe(false)
    expect(sessionActions({ session: session('A2', { timingMode: 'free' }) }, true)?.renew).toBeNull()
    expect(sessionActions({}, true)).toBeNull()
    expect([renewMinutes(30), renewMinutes('15'), renewMinutes(0), renewMinutes(1441), renewMinutes(1.5)]).toEqual([
      30,
      15,
      null,
      null,
      null,
    ])
    expect(renewMinutes(undefined)).toBeNull()
  })

  it('系统内收费关着：没有去结账和停止计时，进行中的都能「结束」', () => {
    const view = admission('a', { displayStatus: 'confirmed', sessionVersion: 'v1' })
    expect(sessionActions({ session: session('A1', { admissionId: 'a' }), admission: view }, false)).toMatchObject({
      checkout: false,
      stopFirst: false,
      stop: false,
      end: true,
      pause: true,
      renew: { kind: 'package', minutes: 30, cents: 2000 },
    })
    for (const extra of [{}, { status: 'paused' as const }, { status: 'companion' as const }, { stoppedAt: at(-1) }])
      expect(sessionActions({ session: session('A2', extra) }, false)).toMatchObject({
        checkout: false,
        stop: false,
        end: true,
      })
    expect(sessionActions({ session: session('A2') }, true)).toMatchObject({ checkout: true, stop: true, end: false })
  })

  it('开到打烊的不能暂停、续时，整桌的也不能标陪客；暂停中的（不应出现）照样能继续', () => {
    const view = admission('a', { displayStatus: 'confirmed', sessionVersion: 'v1' })
    expect(
      sessionActions({ session: session('A1', { admissionId: 'a', untilClose: true }), admission: view }, false),
    ).toMatchObject({ pause: false, renew: null, end: true })
    expect(sessionActions({ session: session('A2', { untilClose: true }) }, false)).toMatchObject({
      pause: false,
      renew: null,
      end: true,
      companion: null,
      cancel: true,
    })
    expect(sessionActions({ session: session('A2', { untilClose: true, status: 'paused' }) }, false)?.resume).toBe(true)
  })

  // 同小程序：整桌会话在会话页换桌、标记陪客、撤销未结账开台；按座会话在「会员与计时」换座，没有陪客和撤销
  // （「扫码入座的体验不支持这个操作」）。停止计时、等结账的按座会话也能换座。
  it('不常用的操作：整桌会话换桌、陪客、撤销；按座会话只换座', () => {
    const view = admission('a', { displayStatus: 'confirmed', sessionVersion: 'v1' })
    expect(sessionActions({ session: session('A2') }, true)).toMatchObject({
      move: 'table',
      companion: 'available',
      cancel: true,
    })
    expect(sessionActions({ session: session('A2', { status: 'paused' }) }, true)?.companion).toBe('available')
    expect(sessionActions({ session: session('A2', { status: 'companion' }) }, true)).toMatchObject({
      move: 'table',
      companion: 'marked',
      cancel: true,
    })
    for (const extra of [{}, { stoppedAt: at(-1) }, { status: 'paused' as const }])
      expect(
        sessionActions(
          { session: session('A1', { admissionId: 'a', seatNumber: 1, ...extra }), admission: view },
          true,
        ),
      ).toMatchObject({ move: 'seat', companion: null, cancel: false })
  })

  // 陪客只记在会话状态上：陪客 → 暂停 → 继续就成了普通计时，建单按套餐价收了陪客的钱。
  it('陪客会话不给暂停、继续，平面图上写「陪客中」；快到点、超时照样提醒', () => {
    const companion = session('A2', { status: 'companion' })
    expect(sessionActions({ session: companion }, true)).toMatchObject({ pause: false, resume: false })
    expect(seatState(busy('A2', 60), companion)).toBe('companion')
    expect(seatStateNames.companion).toBe('陪客中')
    expect(seatStateOrder).toContain('companion')
    expect(seatState(busy('A2', 5), companion)).toBe('expiring')
    expect(seatState(busy('A2', -5), companion)).toBe('overdue')
  })

  it('整桌续时后：草稿跟着改价就报新应收，没跟着改（员工改过明细）要去结账页核对', () => {
    expect(draftOrderNotice({})).toBeNull()
    expect(draftOrderNotice({ draftOrder: { id: 'o1', repriced: true, receivableCents: 4490 } })).toEqual({
      repriced: true,
      orderId: 'o1',
      text: '待结账订单已按新时长改为 ¥44.90',
    })
    const review = draftOrderNotice({ draftOrder: { id: 'o1', repriced: false, receivableCents: 2500 } })
    expect(review?.repriced).toBe(false)
    expect(review?.text).toMatch(/没有按新时长自动改价（现在应收 ¥25\.00）/)
  })

  it('座位与顾客的写法', () => {
    expect(tablePlace(table('A1'))).toBe('A1')
    expect(tablePlace(table('D1', { seatCount: 2, wholeTable: true }), 1)).toBe('D1 · 整桌')
    expect(tablePlace(table('X1', { seatCount: 4 }), 2)).toBe('X1 · 2 号座')
    expect(tablePlace(undefined)).toBe('桌位待核对')
    expect(seatPlace({ code: 'A1', zone: 'A', table: table('A1'), session: session('A1') })).toBe('A1（A 区）')
    expect(seatPlace({ code: 'D1', zone: 'D', table: table('D1', { seatCount: 2, wholeTable: true }) })).toBe(
      'D1（D 区） · 整桌',
    )
    expect(customerText({ nickname: '小王', phoneMasked: '138****1234' })).toBe('小王（138****1234）')
    expect(customerText({ nickname: '小王', phoneMasked: '' })).toBe('小王')
    expect(customerText(null)).toBe('')
  })
})

it('实时连着 30 秒重读一次，断线或连接中 10 秒一次', () => {
  expect(refetchInterval('open')).toBe(30_000)
  expect(refetchInterval('closed')).toBe(10_000)
  expect(refetchInterval('connecting')).toBe(10_000)
})

describe('renewChoices', () => {
  it('续时方案的 1、2、3 块，超过 1440 分钟的不给', () => {
    expect(renewChoices({ minutes: 30, amountCents: 1500, packageName: '2 小时' })).toEqual([30, 60, 90])
    expect(renewChoices({ minutes: 600, amountCents: 1500, packageName: '长包' })).toEqual([600, 1200])
  })
})
