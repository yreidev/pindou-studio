import { describe, expect, it } from 'vitest'
import type { PackageRule } from '../../api/board'
import type { BusySlot, ReservationEntry, ReservationSettings, ReservationTable } from '../../api/reservations'
import type { ListedAccount } from '../../api/staff'
import {
  addDays,
  arrivalStartText,
  bookablePackages,
  bookingMinutes,
  canCancel,
  canConfirm,
  canMarkNoShow,
  canSeat,
  customerText,
  dayText,
  defaultRegisterForm,
  inUseUntil,
  openEntries,
  placeText,
  registerDays,
  registerDirty,
  registerFormSchema,
  registerInput,
  registerSlots,
  slotMinutesOf,
  reservationsSearchSchema,
  seatUnits,
  sourceText,
  storeInstant,
  unitReserved,
  untilText,
  viewCounts,
  whenText,
  type RegisterFormValues,
} from './reservations'

const now = Date.parse('2026-10-06T06:00:00Z') // 门店 10-06 周二 14:00
const iso = (day: string, clock: string) => new Date(`${day}T${clock}:00+08:00`).toISOString()

const entry = (
  id: string,
  day: string,
  clock: string,
  displayStatus: ReservationEntry['displayStatus'],
  extra: Partial<ReservationEntry['reservation']> = {},
  more: Partial<ReservationEntry> = {},
): ReservationEntry => ({
  reservation: {
    id,
    serviceTableId: 't-A3',
    seatNumber: 1,
    packageId: 'p-2h',
    packageName: '畅玩 2 小时',
    durationMinutes: 120,
    amountCents: 8800,
    startAt: iso(day, clock),
    status: displayStatus === 'expired' ? 'confirmed' : displayStatus,
    createdBy: 'u-staff',
    createdAt: iso('2026-10-01', '10:00'),
    ...extra,
  },
  displayStatus,
  endAt: new Date(Date.parse(iso(day, clock)) + 120 * 60_000).toISOString(),
  tableNumber: 3,
  customerName: '小王',
  phoneMasked: '138****1234',
  ...more,
})

const table = (code: string, extra: Partial<ReservationTable> = {}): ReservationTable => ({
  id: `t-${code}`,
  code,
  zone: code[0],
  number: Number(code.slice(1)),
  seatCount: 1,
  wholeTable: false,
  occupiedSeats: [],
  floorAreaId: `area-${code[0]}`,
  floorAreaName: `${code[0]} 区`,
  ...extra,
})

const settings: ReservationSettings = {
  enabled: true,
  openMinute: 540,
  closeMinute: 1320,
  slotMinutes: 30,
  advanceDays: 7,
  leadMinutes: 30,
  graceMinutes: 30,
  closedDates: [],
  closedWeekdays: [],
  noShowLimit: 0,
  noShowWindowDays: 30,
}

const pkg = (extra: Partial<PackageRule> = {}): PackageRule => ({
  id: 'p-2h',
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
  renewalMinutes: 0,
  renewalCents: 0,
  pauseLimitMinutes: 0,
  overtime: 'manual',
  ...extra,
})

describe('列表筛选', () => {
  const entries = [
    entry('r3', '2026-10-07', '10:00', 'confirmed'),
    entry('r1', '2026-10-06', '15:00', 'pending'),
    entry('r0', '2026-10-06', '11:00', 'expired'),
    entry('r2', '2026-10-06', '16:00', 'confirmed'),
  ]

  it('按状态与门店日期筛，开始时间早的在前', () => {
    expect(openEntries(entries, 'open').map((e) => e.reservation.id)).toEqual(['r0', 'r1', 'r2', 'r3'])
    expect(openEntries(entries, 'confirmed').map((e) => e.reservation.id)).toEqual(['r2', 'r3'])
    expect(openEntries(entries, 'open', '2026-10-07').map((e) => e.reservation.id)).toEqual(['r3'])
    expect(openEntries(entries, 'expired', '2026-10-06').map((e) => e.reservation.id)).toEqual(['r0'])
  })

  it('门店日期按东八区算：UTC 还是前一天的凌晨预约也落在门店那一天', () => {
    const early = entry('r-early', '2026-10-08', '07:30', 'confirmed')
    expect(early.reservation.startAt).toBe('2026-10-07T23:30:00.000Z')
    expect(openEntries([early], 'open', '2026-10-08')).toHaveLength(1)
    expect(openEntries([early], 'open', '2026-10-07')).toHaveLength(0)
  })

  it('筛选按钮上的个数跟着日期走', () => {
    expect(viewCounts(entries)).toEqual({ open: 4, pending: 1, confirmed: 2, expired: 1 })
    expect(viewCounts(entries, '2026-10-06')).toEqual({ open: 3, pending: 1, confirmed: 1, expired: 1 })
  })

  it('网址参数不认识的一律当没填', () => {
    expect(reservationsSearchSchema.parse({ tab: 'x', view: 'all', date: '10-06', page: 0 })).toEqual({})
    expect(reservationsSearchSchema.parse({ tab: 'register', view: 'ended', date: '2026-10-06', page: '2' })).toEqual({
      tab: 'register',
      view: 'ended',
      date: '2026-10-06',
      page: 2,
    })
  })
})

describe('每条预约能做的事（同小程序）', () => {
  it('待确认：确认、到店开台、取消；已确认：到店开台、取消；过时未处理：取消、爽约；处理完的什么都不能做', () => {
    const pending = entry('p', '2026-10-06', '15:00', 'pending')
    const confirmed = entry('c', '2026-10-06', '15:00', 'confirmed')
    const expired = entry('e', '2026-10-06', '11:00', 'expired')
    const seated = entry('s', '2026-10-06', '11:00', 'seated')
    expect([canConfirm(pending), canSeat(pending), canCancel(pending)]).toEqual([true, true, true])
    expect([canConfirm(confirmed), canSeat(confirmed), canCancel(confirmed)]).toEqual([false, true, true])
    expect([canConfirm(expired), canSeat(expired), canCancel(expired)]).toEqual([false, false, true])
    expect([canConfirm(seated), canSeat(seated), canCancel(seated), canMarkNoShow(seated, now)]).toEqual([
      false,
      false,
      false,
      false,
    ])
  })

  it('标记爽约要到了开始时间（后端拒绝还没开始的）', () => {
    const later = entry('l', '2026-10-06', '14:30', 'confirmed')
    const started = entry('s', '2026-10-06', '14:00', 'confirmed')
    expect(canMarkNoShow(later, now)).toBe(false)
    expect(canMarkNoShow(started, now)).toBe(true)
    expect(canMarkNoShow(entry('e', '2026-10-06', '11:00', 'expired'), now)).toBe(true)
  })
})

describe('文字', () => {
  it('到店时间、日期说明按门店时区写', () => {
    expect(whenText(entry('r', '2026-10-06', '14:00', 'confirmed'))).toBe('10-06 周二 14:00–16:00')
    expect(dayText('2026-10-06', '2026-10-06')).toBe('10-06 周二 · 今天')
    expect(dayText('2026-10-08', '2026-10-06')).toBe('10-08 周四 · 后天')
    expect(dayText('2026-10-05', '2026-10-06')).toBe('10-05 周一 · 昨天')
    expect(dayText('2026-10-04', '2026-10-06')).toBe('10-04 周日')
    expect(dayText('2026-10-11', '2026-10-06')).toBe('10-11 周日')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('到店开台确认框：今天的只写时分，别的日子带日期', () => {
    expect(arrivalStartText(iso('2026-10-06', '15:00'), now)).toBe('15:00')
    expect(arrivalStartText(iso('2026-10-08', '15:00'), now)).toBe('10-08 15:00')
  })

  it('座位按桌位编码写；停用的桌不在桌位里，退回桌号', () => {
    const tables = new Map([
      ['t-A3', table('A3')],
      ['t-D1', table('D1', { seatCount: 2, wholeTable: true })],
    ])
    expect(placeText(entry('r', '2026-10-06', '15:00', 'confirmed'), tables)).toBe('A3')
    expect(
      placeText(entry('r', '2026-10-06', '15:00', 'confirmed', { serviceTableId: 't-D1', seatNumber: 2 }), tables),
    ).toBe('D1 · 整桌')
    expect(placeText(entry('r', '2026-10-06', '15:00', 'confirmed', { serviceTableId: 't-gone' }), tables)).toBe(
      '3 号桌 · 1 号座',
    )
  })

  it('顾客：有账户带打码手机号；代客登记的散客写尚无账户', () => {
    expect(customerText(entry('r', '2026-10-06', '15:00', 'confirmed', { accountId: 'u-wang' }))).toBe(
      '小王（138****1234）',
    )
    expect(
      customerText(
        entry(
          'r',
          '2026-10-06',
          '15:00',
          'confirmed',
          { guestName: '张阿姨' },
          { customerName: '张阿姨', phoneMasked: '' },
        ),
      ),
    ).toBe('张阿姨 · 尚无账户')
    expect(
      customerText(entry('r', '2026-10-06', '15:00', 'confirmed', {}, { customerName: '', phoneMasked: undefined })),
    ).toBe('未填写称呼 · 尚无账户')
  })

  it('登记方式：登记人就是本人的是自助预约，其余是代客登记', () => {
    expect(sourceText(entry('r', '2026-10-06', '15:00', 'pending', { accountId: 'u-wang', createdBy: 'u-wang' }))).toBe(
      '顾客在小程序自助预约',
    )
    expect(sourceText(entry('r', '2026-10-06', '15:00', 'confirmed', { accountId: 'u-wang' }))).toBe('员工代客登记')
    expect(sourceText(entry('r', '2026-10-06', '15:00', 'confirmed', { guestName: '张阿姨' }))).toBe('员工代客登记')
  })
})

describe('代客登记的时段', () => {
  it('营业时间内按粒度排，套餐要在结束前做完；不受最短提前限制，只要晚于此刻', () => {
    const today = registerSlots(settings, '2026-10-06', 120, now).map((t) => new Date(t).toISOString())
    // 此刻 14:00：14:00 不算（要晚于此刻），14:30 起；22:00 结束、120 分钟的最晚 20:00 开始
    expect(today[0]).toBe(iso('2026-10-06', '14:30'))
    expect(today.at(-1)).toBe(iso('2026-10-06', '20:00'))
    expect(today).toHaveLength(12)
    expect(registerSlots(settings, '2026-10-07', 120, now)).toHaveLength(23)
  })

  it('最多提前天数按「此刻加 N 天」这个时刻判，不是按日历整天', () => {
    const last = registerSlots(settings, '2026-10-13', 120, now).map((t) => new Date(t).toISOString())
    expect(last.at(-1)).toBe(iso('2026-10-13', '14:00'))
    expect(registerSlots(settings, '2026-10-14', 120, now)).toEqual([])
    expect(registerDays(settings, now)).toEqual({ first: '2026-10-06', last: '2026-10-13' })
  })

  it('门店时刻按东八区换算', () => {
    expect(new Date(storeInstant('2026-10-06', 9 * 60 + 30)).toISOString()).toBe('2026-10-06T01:30:00.000Z')
  })
})

describe('代客登记的座位', () => {
  const tables = [table('A1'), table('D1', { seatCount: 2, wholeTable: true }), table('F1', { seatCount: 2 })]
  const units = seatUnits(tables)
  const start = Date.parse(iso('2026-10-07', '14:00'))
  const slot = (code: string, seat: number, from: string, to: string, kind: BusySlot['kind']): BusySlot => ({
    serviceTableId: `t-${code}`,
    seatNumber: seat,
    startAt: iso('2026-10-07', from),
    endAt: iso('2026-10-07', to),
    kind,
  })

  it('单人位一个、整桌售卖的桌整张算一个（按 1 号座登记）、其余多座桌按座号', () => {
    expect(units.map((u) => [u.label, u.seatNumber])).toEqual([
      ['A1', 1],
      ['D1 整桌', 1],
      ['F1 · 1 号座', 1],
      ['F1 · 2 号座', 2],
    ])
  })

  it('只把别的预约当占用；整桌售卖的桌任何一个座被约住整张就不能约（同后端）', () => {
    const busy = [slot('A1', 1, '15:00', '17:00', 'reservation'), slot('D1', 2, '13:00', '14:30', 'reservation')]
    expect(unitReserved(busy, units[0], start, 120)).toBe(true)
    expect(unitReserved(busy, units[0], Date.parse(iso('2026-10-07', '17:00')), 120)).toBe(false)
    expect(unitReserved(busy, units[1], start, 120)).toBe(true)
    expect(unitReserved(busy, units[2], start, 120)).toBe(false)
  })

  it('现场定时会话不挡，只告诉员工到几点空出', () => {
    const busy = [slot('A1', 1, '12:00', '14:40', 'session'), slot('A1', 1, '12:00', '15:10', 'session')]
    expect(unitReserved(busy, units[0], start, 120)).toBe(false)
    const until = inUseUntil(busy, units[0], start, 120)
    expect(until).toBe(Date.parse(iso('2026-10-07', '15:10')))
    expect(untilText(until!, start)).toBe('15:10')
    expect(inUseUntil(busy, units[0], Date.parse(iso('2026-10-07', '16:00')), 120)).toBeNull()
  })

  it('只列计时套餐，含「到打烊」的', () => {
    expect(
      bookablePackages([
        pkg(),
        pkg({ id: 'r', kind: 'recharge', durationMinutes: 0 }),
        pkg({ id: 'all-day', durationMinutes: 0, untilClose: true }),
      ]).map((p) => p.id),
    ).toEqual(['p-2h', 'all-day'])
  })

  it('「到打烊」的从开始时间约到当天打烊，过了打烊为 0；列时段时只要在打烊前开始', () => {
    const allDay = pkg({ id: 'all-day', durationMinutes: 0, untilClose: true })
    expect(bookingMinutes(allDay, Date.parse(iso('2026-10-07', '14:00')), 22 * 60)).toBe(480)
    expect(bookingMinutes(allDay, Date.parse(iso('2026-10-07', '22:00')), 22 * 60)).toBe(0)
    expect(bookingMinutes(pkg(), Date.parse(iso('2026-10-07', '14:00')), 22 * 60)).toBe(120)
    expect(slotMinutesOf(allDay)).toBe(1)
    expect(slotMinutesOf(pkg())).toBe(120)
  })
})

describe('代客登记表单', () => {
  const customer = { id: 'u-wang', nickname: '小王', phoneMasked: '138****1234' } as ListedAccount
  const filled = (extra: Partial<RegisterFormValues> = {}): RegisterFormValues => ({
    ...defaultRegisterForm('2026-10-07', [pkg()]),
    guestName: '张阿姨',
    start: Date.parse(iso('2026-10-07', '14:00')),
    unit: 't-A1:1',
    ...extra,
  })
  const issues = (values: RegisterFormValues) => {
    const result = registerFormSchema.safeParse(values)
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`)
  }

  it('只有一个套餐时直接选上；日期、套餐不算填过东西', () => {
    const blank = defaultRegisterForm('2026-10-07', [pkg()])
    expect(blank.packageId).toBe('p-2h')
    expect(defaultRegisterForm('2026-10-07', [pkg(), pkg({ id: 'p-3h' })]).packageId).toBe('')
    expect(registerDirty(blank)).toBe(false)
    expect(registerDirty({ ...blank, note: '两位' })).toBe(true)
    expect(registerDirty({ ...blank, coupon: { platform: 'meituan', code: '' } })).toBe(true)
  })

  it('顾客账户或称呼二选一，称呼最多 20 字，备注最多 200 字，套餐时间座位必选', () => {
    expect(issues(filled())).toEqual([])
    expect(issues(filled({ customer, guestName: '' }))).toEqual([])
    expect(issues(filled({ guestName: '  ' }))).toEqual(['guestName:请选择顾客账户或填写称呼'])
    expect(issues(filled({ guestName: '一'.repeat(21) }))).toEqual(['guestName:称呼最多 20 个字'])
    expect(issues(filled({ note: '字'.repeat(201) }))).toEqual(['note:备注最多 200 字'])
    expect(issues(filled({ coupon: { platform: 'meituan', code: '12-34' } }))).toEqual(['coupon:券码只能是字母和数字'])
    expect(issues(filled({ packageId: '', start: 0, unit: '' }))).toEqual([
      'packageId:请选择套餐',
      'start:请选择到店时间',
      'unit:请选择座位',
    ])
  })

  it('请求体：有账户发账户、否则发称呼；备注空着不发', () => {
    expect(registerInput(filled({ customer, guestName: '' }), { tableId: 't-A1', seatNumber: 1 })).toEqual({
      action: 'register',
      accountId: 'u-wang',
      serviceTableId: 't-A1',
      seatNumber: 1,
      packageId: 'p-2h',
      startAt: '2026-10-07T06:00:00.000Z',
    })
    expect(registerInput(filled({ note: ' 两位，带小孩 ' }), { tableId: 't-D1', seatNumber: 1 })).toEqual({
      action: 'register',
      guestName: '张阿姨',
      serviceTableId: 't-D1',
      seatNumber: 1,
      packageId: 'p-2h',
      startAt: '2026-10-07T06:00:00.000Z',
      note: '两位，带小孩',
    })
    expect(
      registerInput(filled({ coupon: { platform: 'meituan', code: '1234 5678 9012' } }), {
        tableId: 't-A1',
        seatNumber: 1,
      }).coupon,
    ).toEqual({ platform: 'meituan', code: '123456789012' })
  })
})
