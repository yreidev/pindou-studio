import { describe, expect, it } from 'vitest'
import type { PackageRule, ReservationEntry, ServiceTable } from '../../api/board'
import type { ListedAccount } from '../../api/staff'
import { startable, type BoardSeat } from './board'
import {
  backfillWindow,
  bookingText,
  closeNote,
  defaultOpenForm,
  disabledClock,
  durationPrice,
  minutesText,
  openDurations,
  openFormSchema,
  openSessionInput,
  openSummary,
  otherChoices,
  otherDurations,
  startProblem,
  storeClock,
  storeInstant,
  tableBookings,
  type OpenFormValues,
} from './open'

const now = Date.parse('2026-10-05T06:00:00Z') // 门店 14:00
const minutes = (value: number) => value * 60_000
const at = (offset: number) => new Date(now + minutes(offset)).toISOString()

const rule = (extra: Partial<PackageRule>): PackageRule => ({
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
  renewalMinutes: 30,
  renewalCents: 2000,
  pauseLimitMinutes: 15,
  overtime: 'manual',
  ...extra,
})

const wang: ListedAccount = {
  id: '00000000-0000-4000-8000-000000000002',
  nickname: '小王',
  phoneMasked: '138****0003',
  roles: [],
  phoneVerificationStatus: 'verified',
}

/** 生产上发布的那样：1、2、3 小时，另有到打烊的「全天不限时」。 */
const shopDurations = [60, 120, 180]
const form = (extra: Partial<OpenFormValues> = {}): OpenFormValues => ({ ...defaultOpenForm(shopDurations), ...extra })

describe('开台表单的初值', () => {
  it('散客、第二个时长按钮、现在开始（同小程序开台弹层：1、2、3 小时时默认 2 小时）', () => {
    expect(defaultOpenForm(shopDurations)).toEqual({ customer: null, timing: 120, start: 'now', clock: '' })
    expect(openSummary(defaultOpenForm(shopDurations))).toBe('散客 · 2 小时 · 现在开始')
    // 只有一个时长按钮就选它
    expect(defaultOpenForm([180]).timing).toBe(180)
  })

  it('确认按钮旁写清选了谁、怎么计时、几点开始', () => {
    expect(openSummary(form({ customer: wang, timing: 'free', start: 'earlier', clock: '13:40' }))).toBe(
      '小王（138****0003） · 自由计时 · 13:40 开始',
    )
    expect(openSummary(form({ timing: 150 }))).toBe('散客 · 2 小时 30 分 · 现在开始')
  })
})

describe('时长按钮按已发布的计时套餐列（同小程序开台弹层）', () => {
  const day = rule({ id: 'p-day', name: '全天不限时', durationMinutes: 0, untilClose: true })

  it('取计时套餐的时长，从短到长、去掉重复；到打烊的套餐和别的规则不算', () => {
    const packages = [
      rule({ id: 'p-3h', name: '3 小时', durationMinutes: 180 }),
      rule({}),
      rule({ id: 'p-2h-pair', name: '双人 2 小时', durationMinutes: 120 }),
      rule({ id: 'p-1h', name: '1 小时', durationMinutes: 60 }),
      day,
      // 不是计时套餐的规则不算，哪怕时长字段有值
      rule({ id: 'r-30', kind: 'recharge', name: '充值', durationMinutes: 30 }),
    ]
    expect(openDurations(packages)).toEqual([60, 120, 180])
  })

  it('最多 4 个，取最短的', () => {
    const packages = [300, 240, 180, 120, 60, 45].map((minutes) =>
      rule({ id: `p-${minutes}`, durationMinutes: minutes }),
    )
    expect(openDurations(packages)).toEqual([45, 60, 120, 180])
  })

  it('读不到套餐、或一个定时的都没有：退回 1、2、3 小时，不挡开台', () => {
    expect(openDurations([])).toEqual([60, 120, 180])
    expect(openDurations([day])).toEqual([60, 120, 180])
  })

  it('其他时长：30 分钟一档，30 分钟到 8 小时；时长按钮上已有的不重复列', () => {
    expect(otherDurations).toEqual(Array.from({ length: 16 }, (_, index) => (index + 1) * 30))
    expect(otherChoices([60, 120, 180])).toEqual([30, 90, 150, 210, 240, 270, 300, 330, 360, 390, 420, 450, 480])
    // 套餐时长不在 30 分钟一档上的，不影响其他时长
    expect(otherChoices([45, 120])).toHaveLength(15)
  })

  it('时长写成小时和分', () => {
    expect([30, 45, 60, 90, 150, 480].map(minutesText)).toEqual([
      '30 分钟',
      '45 分钟',
      '1 小时',
      '1 小时 30 分',
      '2 小时 30 分',
      '8 小时',
    ])
  })
})

describe('时长按钮标已发布套餐的价', () => {
  const packages = [
    rule({}),
    rule({ id: 'p-1h', name: '畅玩 1 小时', durationMinutes: 60, amountCents: 4800 }),
    // 不是计时套餐的规则不算，哪怕时长字段对得上
    rule({ id: 'r-30', kind: 'recharge', name: '充值', durationMinutes: 30, amountCents: 10000 }),
  ]

  it('时长正好对得上的计时套餐标价', () => {
    expect(durationPrice(packages, 120, true)).toBe('¥88.00')
    expect(durationPrice(packages, 60, true)).toBe('¥48.00')
  })

  it('系统内收费关着：不标价', () => {
    expect(durationPrice(packages, 120, false)).toBe('')
  })

  it('没有对应套餐、或套餐读不到时只写时长，不编价', () => {
    expect(durationPrice(packages, 30, true)).toBe('')
    expect(durationPrice(packages, 180, true)).toBe('')
    expect(durationPrice([], 120, true)).toBe('')
  })
})

describe('开始时间按门店时区换算', () => {
  it('「时:分」是门店今天的那一刻，不跟电脑时区走', () => {
    expect(storeClock(now)).toBe('14:00')
    expect(new Date(storeInstant('13:20', now)).toISOString()).toBe('2026-10-05T05:20:00.000Z')
    // 门店已过零点、UTC 还是前一天：日期取门店的
    const pastMidnight = Date.parse('2026-10-05T16:30:00Z') // 门店 10-06 00:30
    expect(new Date(storeInstant('00:10', pastMidnight)).toISOString()).toBe('2026-10-05T16:10:00.000Z')
    expect(storeInstant('', now)).toBeNaN()
    expect(storeInstant('9:5', now)).toBeNaN()
  })
})

describe('回填范围按角色', () => {
  it('店员：最近 60 分钟内，不能晚于现在', () => {
    const window = backfillWindow(['clerk'], now)
    expect(window.earliest).toBe(now - minutes(60))
    expect(window.latest).toBe(now)
    expect(window.help).toBe('店员可回填最近 60 分钟内的开始时间，不能晚于现在。')
    expect(startProblem('13:00', ['clerk'], now)).toBeNull()
    expect(startProblem('13:59', ['clerk'], now)).toBeNull()
    expect(startProblem('14:00', ['clerk'], now)).toBeNull()
    expect(startProblem('12:59', ['clerk'], now)).toBe('店员最多只能回填 60 分钟内的开始时间')
    expect(startProblem('14:01', ['clerk'], now)).toBe('开始时间不能晚于当前时间')
  })

  it('店员按到秒：14:00:30 时 13:00 已超过 60 分钟，13:01 可以', () => {
    const later = now + 30_000
    expect(startProblem('13:00', ['clerk'], later)).toBe('店员最多只能回填 60 分钟内的开始时间')
    expect(startProblem('13:01', ['clerk'], later)).toBeNull()
  })

  it('店长、老板：今天 0 点起都可以，不能晚于现在', () => {
    for (const roles of [['manager'], ['owner']]) {
      const window = backfillWindow(roles, now)
      expect(new Date(window.earliest).toISOString()).toBe('2026-10-04T16:00:00.000Z') // 门店 10-05 00:00
      expect(window.help).toBe('店长、老板可回填今天更早的开始时间，不能晚于现在。')
      expect(startProblem('00:00', roles, now)).toBeNull()
      expect(startProblem('08:30', roles, now)).toBeNull()
      expect(startProblem('14:01', roles, now)).toBe('开始时间不能晚于当前时间')
    }
  })

  it('店员在门店零点刚过时只能回填到今天 0 点（只选时:分，不跨到昨天）', () => {
    const pastMidnight = Date.parse('2026-10-05T16:20:00Z') // 门店 10-06 00:20
    const window = backfillWindow(['clerk'], pastMidnight)
    expect(window.earliest).toBe(storeInstant('00:00', pastMidnight))
    expect(startProblem('00:00', ['clerk'], pastMidnight)).toBeNull()
  })

  it('没选时间就提交要先选', () => {
    expect(startProblem('', ['owner'], now)).toBe('请选择开始时间')
  })

  it('时间选择器只放开范围内的时、分', () => {
    const clerk = disabledClock(backfillWindow(['clerk'], now + 30_000), now + 30_000)
    // 14:00:30：13:01–14:00 可选
    expect(clerk.hours()).toEqual([
      ...Array.from({ length: 13 }, (_, h) => h),
      ...Array.from({ length: 9 }, (_, h) => h + 15),
    ])
    expect(clerk.minutes(13)).toEqual([0])
    expect(clerk.minutes(14)).toEqual(Array.from({ length: 59 }, (_, m) => m + 1))
    expect(clerk.minutes(undefined)).toEqual([])
    const owner = disabledClock(backfillWindow(['owner'], now), now)
    expect(owner.hours()).toEqual(Array.from({ length: 9 }, (_, h) => h + 15))
    expect(owner.minutes(9)).toEqual([])
  })
})

describe('表单校验', () => {
  it('「现在」不看回填的时间；回填时按提交那一刻校验范围', () => {
    let clock = now
    const schema = openFormSchema(['clerk'], () => clock)
    expect(schema.safeParse(form({ clock: '01:00' })).success).toBe(true)
    expect(schema.safeParse(form({ start: 'earlier', clock: '13:10' })).success).toBe(true)
    // 表单开着的时候时间在走：二十分钟后再点确认，13:10 已经超过 60 分钟
    clock = now + minutes(20)
    const result = schema.safeParse(form({ start: 'earlier', clock: '13:10' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['clock'], message: '店员最多只能回填 60 分钟内的开始时间' }),
    ])
  })

  it('店长能回填的更早时间，店员不行', () => {
    const values = form({ start: 'earlier', clock: '09:00' })
    expect(openFormSchema(['manager'], () => now).safeParse(values).success).toBe(true)
    expect(openFormSchema(['clerk'], () => now).safeParse(values).success).toBe(false)
  })

  it('计时是正整数分钟、到打烊或自由计时', () => {
    const schema = openFormSchema(['clerk'], () => now)
    for (const timing of [45, 150, 'close', 'free'] as const)
      expect(schema.safeParse(form({ timing })).success).toBe(true)
    for (const timing of [0, -30, 1.5]) expect(schema.safeParse(form({ timing })).success).toBe(false)
  })
})

describe('开台的请求体', () => {
  const tableId = '00000000-0000-4000-8000-0000000000b4'

  it('散客、定时、没改开始时间：不带开始时间（服务器收到时开始计、不看电脑时钟），不带 accountId', () => {
    // 打开面板后找顾客、等注册拖了 25 分钟才点确认：从点确认时开始计，由服务器取时间
    const submittedAt = now + minutes(25)
    expect(openSessionInput(tableId, defaultOpenForm(shopDurations), submittedAt)).toEqual({
      serviceTableId: tableId,
      timingMode: 'timed',
      durationMinutes: 120,
    })
  })

  it('选了顾客、自由计时、回填：带 accountId，不带 durationMinutes，开始时间是门店今天的那一刻', () => {
    expect(
      openSessionInput(tableId, form({ customer: wang, timing: 'free', start: 'earlier', clock: '13:40' }), now),
    ).toEqual({
      serviceTableId: tableId,
      accountId: wang.id,
      startedAt: '2026-10-05T05:40:00.000Z',
      timingMode: 'free',
    })
  })

  it('选了别的时长照发，「其他时长」选的也一样', () => {
    expect(openSessionInput(tableId, form({ timing: 180 }), now)).toMatchObject({
      timingMode: 'timed',
      durationMinutes: 180,
    })
    expect(openSessionInput(tableId, form({ timing: 150 }), now)).toMatchObject({
      timingMode: 'timed',
      durationMinutes: 150,
    })
  })

  it('到打烊：带 untilClose、不带分钟数，由服务器算到打烊', () => {
    expect(openSessionInput(tableId, form({ timing: 'close' }), now)).toEqual({
      serviceTableId: tableId,
      timingMode: 'timed',
      untilClose: true,
    })
    expect(openSummary(form({ timing: 'close' }))).toBe('散客 · 到打烊 · 现在开始')
  })

  it('到打烊的选项写打烊时间，已过打烊写明', () => {
    expect(closeNote(22 * 60, now)).toBe('用到 22:00 打烊')
    expect(closeNote(24 * 60, now)).toBe('用到 24:00 打烊')
    expect(closeNote(14 * 60, now)).toBe('已过 14:00 打烊')
  })
})

describe('这张桌今天的预约', () => {
  const entry = (
    id: string,
    tableId: string,
    startsIn: number,
    status: ReservationEntry['displayStatus'],
    name = '小王',
  ): ReservationEntry =>
    ({
      reservation: {
        id,
        serviceTableId: tableId,
        seatNumber: 1,
        packageId: 'p-2h',
        packageName: '畅玩 2 小时',
        durationMinutes: 120,
        amountCents: 8800,
        startAt: at(startsIn),
        status: 'confirmed',
        createdBy: 'u-staff',
        createdAt: at(-600),
      },
      displayStatus: status,
      endAt: at(startsIn + 120),
      customerName: name,
    }) as ReservationEntry

  it('只列这张桌、今天、还要到店的，按开始时间排', () => {
    const list = [
      entry('later', 't-B4', 240, 'confirmed'),
      entry('soon', 't-B4', 30, 'pending', '王阿姨'),
      entry('other-table', 't-B5', 10, 'confirmed'),
      entry('tomorrow', 't-B4', 60 * 24, 'confirmed'),
      entry('expired', 't-B4', -40, 'expired'),
      // 开始了还在坐、没结束的也提醒（还在宽限期里没到店）
      entry('started', 't-B4', -30, 'confirmed'),
      entry('over', 't-B4', -130, 'confirmed'),
    ]
    expect(tableBookings(list, 't-B4', now).map((item) => item.reservation.id)).toEqual(['started', 'soon', 'later'])
    expect(bookingText(entry('soon', 't-B4', 30, 'pending', '王阿姨'))).toBe('14:30–16:30 王阿姨（待确认）')
    expect(bookingText(entry('later', 't-B4', 240, 'confirmed', ''))).toBe('18:00–20:00 未填写称呼（已确认）')
  })
})

describe('哪些座位点了开台', () => {
  const table = (extra: Partial<ServiceTable> = {}): ServiceTable => ({
    id: 't-B4',
    code: 'B4',
    zone: 'B',
    floorAreaId: 'area-B',
    number: 4,
    seatCount: 1,
    wholeTable: false,
    enabled: true,
    occupancy: 'idle',
    seatBased: false,
    ...extra,
  })
  const seat = (state: BoardSeat['state'], extra: Partial<ServiceTable> = {}) => ({ state, table: table(extra) })

  it('空闲、启用的才开台；停用、使用中、读不到桌位的不开', () => {
    expect(startable(seat('free'))).toBe(true)
    expect(startable(seat('off', { enabled: false }))).toBe(false)
    expect(startable(seat('running', { occupancy: 'occupied' }))).toBe(false)
    expect(startable({ state: 'free', table: undefined })).toBe(false)
  })
})
