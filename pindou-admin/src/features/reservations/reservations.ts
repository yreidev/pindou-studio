import { z } from 'zod'
import { couponInput, couponProblem, emptyCouponDraft, type CouponDraft } from '../../lib/coupon'
import type { PackageRule } from '../../api/board'
import type {
  BusySlot,
  ReservationEntry,
  ReservationRegister,
  ReservationSettings,
  ReservationTable,
} from '../../api/reservations'
import type { ListedAccount } from '../../api/staff'
import { clockTime, dateOnly, money } from '../../lib/format'
import { tablePlace } from '../board/board'

// 「预约」页的展示规则与代客登记表单，照小程序员工「预约」页（pages/staff/reservations）。
// 状态（含按时间派生的 expired）、可约与否一律以接口为准：这里只决定怎么摆、怎么写，以及代客登记按门店设置
// 列出可选的时段（后端还会再按同一规则核对）。时间一律按门店时区（中国标准时间）。

export type DisplayStatus = ReservationEntry['displayStatus']

/** 展示状态的名称（同小程序）。expired 只是按当前时间派生的，已存状态仍是待确认或已确认。 */
export const statusNames: Record<DisplayStatus, string> = {
  pending: '待确认',
  confirmed: '已确认',
  seated: '已开台',
  cancelled: '已取消',
  no_show: '未到店',
  expired: '已过期',
}

export const statusColors = {
  pending: 'orange',
  confirmed: 'blue',
  seated: 'green',
  cancelled: 'grey',
  no_show: 'violet',
  expired: 'red',
} as const satisfies Record<DisplayStatus, string>

// ---- 列表与筛选 ----

/** 列表看哪一部分：还要处理的（全部、待确认、待到店、过了时间待处理）或处理完的（服务端分页）。 */
export const listViews = ['open', 'pending', 'confirmed', 'expired', 'ended'] as const
export type ListView = (typeof listViews)[number]

export const viewNames: Record<ListView, string> = {
  open: '全部待处理',
  pending: '待确认',
  confirmed: '待到店',
  expired: '过时未处理',
  ended: '已结束',
}

const storeDatePattern = /^\d{4}-\d{2}-\d{2}$/

/**
 * 网址参数：标签页、看哪一部分、门店日期、已结束的页码。不认识的值当没填。
 * 门店日期两部分共用：还要处理的整份取回在本页筛，已结束的带给后端筛（scope=ended&date=…），切换部分时日期留着。
 */
export const reservationsSearchSchema = z.object({
  tab: z.enum(['list', 'register']).optional().catch(undefined),
  view: z.enum(listViews).optional().catch(undefined),
  date: z.string().regex(storeDatePattern).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
})
export type ReservationsSearch = z.infer<typeof reservationsSearchSchema>

/** 这条预约在不在 view 里（只对还要处理的几种；已结束的另取）。 */
function inView(entry: ReservationEntry, view: Exclude<ListView, 'ended'>): boolean {
  if (view === 'open') return true
  return entry.displayStatus === view
}

/** 预约开始时间所在的门店日期（YYYY-MM-DD）。 */
export const startDay = (entry: ReservationEntry) => dateOnly(entry.reservation.startAt)

/**
 * 还要处理的预约里落在 view 和门店日期 date（不给就是全部日期）的，按开始时间排（早的在前，同小程序）。
 */
export function openEntries(
  entries: readonly ReservationEntry[],
  view: Exclude<ListView, 'ended'>,
  date?: string,
): ReservationEntry[] {
  return entries
    .filter((entry) => inView(entry, view) && (!date || startDay(entry) === date))
    .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))
}

/** 筛选按钮上的个数：门店日期 date（不给就是全部日期）里，每一部分各有几条还要处理的。 */
export function viewCounts(
  entries: readonly ReservationEntry[],
  date?: string,
): Record<Exclude<ListView, 'ended'>, number> {
  const counts = { open: 0, pending: 0, confirmed: 0, expired: 0 }
  for (const entry of entries) {
    if (date && startDay(entry) !== date) continue
    counts.open++
    if (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed' || entry.displayStatus === 'expired')
      counts[entry.displayStatus]++
  }
  return counts
}

// ---- 每条预约能做的事（只决定显示；能不能做以后端为准） ----

/** 顾客自助提交的待确认预约：确认后才算生效。过了时间（expired）的不能再确认，后端也拒绝。 */
export const canConfirm = (entry: ReservationEntry) => entry.displayStatus === 'pending'
/** 待确认、已确认、还在宽限期里的：到店开台。待确认的顾客人到了不用先确认（2026-10-27 起，不发「预约成功」通知）。 */
export const canSeat = (entry: ReservationEntry) =>
  entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed'
/** 待确认、已确认、过时未处理的都能取消：过时的不处理会一直挂在列表里。 */
export const canCancel = (entry: ReservationEntry) =>
  entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed' || entry.displayStatus === 'expired'
/** 标记爽约：同取消，另外要到了开始时间（后端回「预约尚未开始，不能标记爽约」），没到时不给这个按钮。 */
export const canMarkNoShow = (entry: ReservationEntry, now: number) =>
  canCancel(entry) && Date.parse(entry.reservation.startAt) <= now

// ---- 文字 ----

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const pad = (value: number) => String(value).padStart(2, '0')
const hm = (value: string | number) => clockTime(value).slice(0, 5)

/** 门店日期（YYYY-MM-DD）是周几。日期本身不带时区，按日历算。 */
export const weekdayOf = (day: string) => weekdays[new Date(`${day}T00:00:00Z`).getUTCDay()]

/** 门店日期 day 往后 offset 天（YYYY-MM-DD）。 */
export function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** 「10-06 周二 · 今天」：昨天、今天、明天、后天写出来（昨天给「已结束」按日期看），其余只写周几。 */
export function dayText(day: string, today: string): string {
  const names: Record<number, string> = { [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天' }
  const offset = [-1, 0, 1, 2].find((n) => addDays(today, n) === day)
  return `${day.slice(5)} ${weekdayOf(day)}${offset === undefined ? '' : ` · ${names[offset]}`}`
}

/** 列表里的到店时间：「10-06 周二 14:00–16:00」。 */
export function whenText(entry: ReservationEntry): string {
  const day = startDay(entry)
  return `${day.slice(5)} ${weekdayOf(day)} ${hm(entry.reservation.startAt)}–${hm(entry.endAt)}`
}

/** 到店开台确认框里的开始时间：今天的只写「14:00」，别的日子带上日期「10-08 14:00」。 */
export function arrivalStartText(startAt: string, now: number): string {
  const day = dateOnly(startAt)
  return day === dateOnly(now) ? hm(startAt) : `${day.slice(5)} ${hm(startAt)}`
}

/**
 * 座位：「A3」「D1 · 整桌」，多座的桌带座号（同看板）。停用的桌不在预约视图的桌位里，退回接口带的桌号。
 */
export function placeText(
  entry: Pick<ReservationEntry, 'reservation' | 'tableNumber'>,
  tables: ReadonlyMap<string, ReservationTable>,
): string {
  const table = tables.get(entry.reservation.serviceTableId)
  if (table) return tablePlace(table, entry.reservation.seatNumber)
  return entry.tableNumber ? `${entry.tableNumber} 号桌 · ${entry.reservation.seatNumber} 号座` : '桌位待核对'
}

/** 顾客：称呼（没填写「未填写称呼」），有账户的带打码手机号，代客登记的散客写「尚无账户」。 */
export function customerText(entry: ReservationEntry): string {
  const name = entry.customerName || '未填写称呼'
  if (entry.phoneMasked) return `${name}（${entry.phoneMasked}）`
  return entry.reservation.accountId ? name : `${name} · 尚无账户`
}

/** 套餐：预约时记下的快照「畅玩 2 小时 · 120 分钟」（到店开台按当时现行的套餐计费）。 */
export const packageText = (entry: ReservationEntry) =>
  `${entry.reservation.packageName} · ${entry.reservation.durationMinutes} 分钟`

/** 到店应收（预约时的套餐价；预约本身不收钱）。 */
export const amountText = (entry: ReservationEntry) => money(entry.reservation.amountCents)

/**
 * 怎么登记的：顾客自己在小程序提交的（登记人就是本人），还是员工代客登记的。
 * 只用接口给的 createdBy 与 accountId 比对，不另外推测。
 */
export function sourceText(entry: ReservationEntry): string {
  const { accountId, createdBy } = entry.reservation
  return accountId && accountId === createdBy ? '顾客在小程序自助预约' : '员工代客登记'
}

// ---- 代客登记 ----

/** 门店某天（YYYY-MM-DD）从 0 点起第 minute 分钟那一刻，毫秒。门店时区是东八区，没有夏令时。 */
export function storeInstant(day: string, minute: number): number {
  return Date.parse(`${day}T${pad(Math.floor(minute / 60))}:${pad(minute % 60)}:00+08:00`)
}

/** 代客登记能选的日期：门店今天到「此刻起最多提前天数」那天（含两头）。 */
export function registerDays(settings: Pick<ReservationSettings, 'advanceDays'>, now: number) {
  return { first: dateOnly(now), last: dateOnly(now + settings.advanceDays * 86_400_000) }
}

/**
 * 代客登记某天可选的开始时间（毫秒）：营业时间内、按时段粒度、套餐在结束时间前做完；
 * 员工代客登记不受「最短提前」限制（后端 register 不看 leadMinutes），只要晚于此刻；最晚到此刻起最多提前天数
 * （后端按「此刻加 N 天」这个时刻判，不是按日历整天）。座位是否被占不在这里判。
 */
export function registerSlots(
  settings: Pick<ReservationSettings, 'openMinute' | 'closeMinute' | 'slotMinutes' | 'advanceDays'>,
  day: string,
  durationMinutes: number,
  now: number,
): number[] {
  const out: number[] = []
  if (!durationMinutes || settings.slotMinutes <= 0) return out
  const latest = now + settings.advanceDays * 86_400_000
  for (
    let minute = settings.openMinute;
    minute + durationMinutes <= settings.closeMinute;
    minute += settings.slotMinutes
  ) {
    const start = storeInstant(day, minute)
    if (start > now && start <= latest) out.push(start)
  }
  return out
}

/** 一个可以登记的座位单位：单人位一个座；整桌售卖的桌（包间双人桌）整张桌算一个（按 1 号座登记）；其余多座桌每个座号一个。 */
export interface SeatUnit {
  /** 单选组里的值：「桌位编号:座号」。 */
  key: string
  tableId: string
  seatNumber: number
  label: string
  table: ReservationTable
}

export const unitKey = (tableId: string, seatNumber: number) => `${tableId}:${seatNumber}`

/** 预约视图的桌位（只有启用的，按区域、桌号排好）展开成可登记的座位单位。 */
export function seatUnits(tables: readonly ReservationTable[]): SeatUnit[] {
  return tables.flatMap((table) => {
    if (table.wholeTable || table.seatCount <= 1)
      return [
        {
          key: unitKey(table.id, 1),
          tableId: table.id,
          seatNumber: 1,
          label: table.wholeTable ? `${table.code} 整桌` : table.code,
          table,
        },
      ]
    return Array.from({ length: table.seatCount }, (_, index) => ({
      key: unitKey(table.id, index + 1),
      tableId: table.id,
      seatNumber: index + 1,
      label: `${table.code} · ${index + 1} 号座`,
      table,
    }))
  })
}

/** 这个单位实际占哪些座号：整桌售卖的桌占整张桌（后端同样按整张桌比，见 reservationSeatFree）。 */
const unitSeatNumbers = (unit: Pick<SeatUnit, 'table' | 'seatNumber'>) =>
  unit.table.wholeTable ? Array.from({ length: unit.table.seatCount }, (_, index) => index + 1) : [unit.seatNumber]

const overlaps = (slot: BusySlot, start: number, end: number) =>
  start < Date.parse(slot.endAt) && Date.parse(slot.startAt) < end

/**
 * 这个时段这个单位已被别的预约占着（busy 里 kind=reservation 的，后端给的）。代客登记只把预约当作占用：
 * 现场正在进行的定时会话只提示（员工可以特殊安排），见 inUseUntil。
 */
export function unitReserved(
  busy: readonly BusySlot[],
  unit: Pick<SeatUnit, 'tableId' | 'table' | 'seatNumber'>,
  start: number,
  durationMinutes: number,
): boolean {
  const end = start + durationMinutes * 60_000
  const seats = unitSeatNumbers(unit)
  return busy.some(
    (slot) =>
      slot.kind === 'reservation' &&
      slot.serviceTableId === unit.tableId &&
      seats.includes(slot.seatNumber) &&
      overlaps(slot, start, end),
  )
}

/** 这个单位在所选时段压到的现场定时会话最晚到什么时候结束（毫秒）；没压到为 null。员工登记时只提示。 */
export function inUseUntil(
  busy: readonly BusySlot[],
  unit: Pick<SeatUnit, 'tableId' | 'table' | 'seatNumber'>,
  start: number,
  durationMinutes: number,
): number | null {
  const end = start + durationMinutes * 60_000
  const seats = unitSeatNumbers(unit)
  let until: number | null = null
  for (const slot of busy) {
    if (slot.kind !== 'session' || slot.serviceTableId !== unit.tableId || !seats.includes(slot.seatNumber)) continue
    if (!overlaps(slot, start, end)) continue
    const slotEnd = Date.parse(slot.endAt)
    if (until === null || slotEnd > until) until = slotEnd
  }
  return until
}

/** 「14:30」，别的日子带日期「10-07 14:30」：现场会话一般当天结束。 */
export const untilText = (until: number, start: number) =>
  dateOnly(until) === dateOnly(start) ? hm(until) : `${dateOnly(until).slice(5)} ${hm(until)}`

/** 能登记的计时套餐（预约视图的 packages 是已发布的），含「到打烊」的。 */
export const bookablePackages = (packages: readonly PackageRule[]) =>
  packages.filter((rule) => rule.kind === 'package' && (rule.durationMinutes > 0 || rule.untilClose))

/** 门店时区里 at 是当天第几分钟。 */
const storeMinute = (at: number) => {
  const [hour, minute] = hm(at).split(':').map(Number)
  return hour * 60 + minute
}

/**
 * 这个套餐从 start 起约多少分钟：「到打烊」的约到当天打烊（同后端 MinutesUntilClose，已到或过了打烊为 0），
 * 其余是套餐时长。
 */
export function bookingMinutes(
  pkg: Pick<PackageRule, 'durationMinutes' | 'untilClose'>,
  start: number,
  closeMinute: number,
): number {
  if (!pkg.untilClose) return pkg.durationMinutes
  return Math.max(0, closeMinute - storeMinute(start))
}

/** 列可选开始时间时按多长算：「到打烊」的只要在打烊前开始就行（至少 1 分钟）。 */
export const slotMinutesOf = (pkg: Pick<PackageRule, 'durationMinutes' | 'untilClose'>) =>
  pkg.untilClose ? 1 : pkg.durationMinutes

/** 代客登记表单。顾客账户与称呼二选一；时间用开始时刻（毫秒，0 为未选），座位用 SeatUnit.key。 */
export interface RegisterFormValues {
  customer: ListedAccount | null
  guestName: string
  packageId: string
  /** 门店日期 YYYY-MM-DD。 */
  day: string
  /** 开始时刻，毫秒；0 是还没选。 */
  start: number
  /** 座位单位（unitKey），空串是还没选。 */
  unit: string
  note: string
  /** 团购记录（选填）：顾客在美团、大众点评买的团购和券码。 */
  coupon: CouponDraft
}

export const defaultRegisterForm = (today: string, packages: readonly PackageRule[]): RegisterFormValues => ({
  customer: null,
  guestName: '',
  // 只有一个套餐时直接选上（多数门店只发一个），多个时让员工选
  packageId: packages.length === 1 ? packages[0].id : '',
  day: today,
  start: 0,
  unit: '',
  note: '',
  coupon: emptyCouponDraft,
})

/** 按字符数算（一个表情算一个字，和后端一致）。 */
export const charLength = (text: string) => [...text].length
export const guestNameLimit = 20
export const noteLimit = 200

/** 表单校验：照后端（reserve.Name、reserve.Note、「请选择顾客账户或填写称呼」）。座位是否已被占由页面按 busy 另外拦。 */
export const registerFormSchema = z
  .object({
    customer: z.custom<ListedAccount | null>(),
    guestName: z.string(),
    packageId: z.string(),
    day: z.string(),
    start: z.number(),
    unit: z.string(),
    note: z.string(),
    coupon: z.custom<CouponDraft>(),
  })
  .superRefine((values, ctx) => {
    const guest = values.guestName.trim()
    if (!values.customer && !guest)
      ctx.addIssue({ code: 'custom', path: ['guestName'], message: '请选择顾客账户或填写称呼' })
    if (!values.customer && charLength(guest) > guestNameLimit)
      ctx.addIssue({ code: 'custom', path: ['guestName'], message: `称呼最多 ${guestNameLimit} 个字` })
    if (!values.packageId) ctx.addIssue({ code: 'custom', path: ['packageId'], message: '请选择套餐' })
    if (!values.start) ctx.addIssue({ code: 'custom', path: ['start'], message: '请选择到店时间' })
    if (!values.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: '请选择座位' })
    if (charLength(values.note.trim()) > noteLimit)
      ctx.addIssue({ code: 'custom', path: ['note'], message: `备注最多 ${noteLimit} 字` })
    const coupon = couponProblem(values.coupon)
    if (coupon) ctx.addIssue({ code: 'custom', path: ['coupon'], message: coupon })
  })

/** 登记的请求体：有账户发 accountId，否则发称呼；备注、团购空着不发。 */
export function registerInput(
  values: RegisterFormValues,
  unit: Pick<SeatUnit, 'tableId' | 'seatNumber'>,
): ReservationRegister {
  const note = values.note.trim()
  const coupon = couponInput(values.coupon)
  return {
    action: 'register',
    ...(values.customer ? { accountId: values.customer.id } : { guestName: values.guestName.trim() }),
    serviceTableId: unit.tableId,
    seatNumber: unit.seatNumber,
    packageId: values.packageId,
    startAt: new Date(values.start).toISOString(),
    ...(note ? { note } : {}),
    ...(coupon ? { coupon } : {}),
  }
}

/** 有没有填过东西（离开页面前要确认）：日期、套餐是默认就有的，不算。 */
export const registerDirty = (values: RegisterFormValues) =>
  Boolean(
    values.customer ||
    values.guestName.trim() ||
    values.start ||
    values.unit ||
    values.note.trim() ||
    values.coupon.platform ||
    values.coupon.code.trim(),
  )
