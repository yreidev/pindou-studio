import type { components } from '../api/schema'
import { CustomerError } from './customer'
import { queryString, request, requestPage } from './staff'
import type { Rule, Table } from './membership'
import { storeOffsetMinutes } from './format'

type Schemas = components['schemas']
export type Reservation = Schemas['Reservation']
export type ReservationEntry = Schemas['ReservationEntry']
export type ReservationSettings = Schemas['ReservationSettings']
export type BusySlot = Schemas['ReservationView']['busy'][number]
/** 桌位用小程序自己的 Table（见 membership.ts），其余与契约相同。 */
export type ReservationView = {
  reservations: ReservationEntry[]
  busy: BusySlot[]
  packages: Rule[]
  tables: Table[]
  settings: ReservationSettings
  settingsVersion: string
  /** 今天起到最多提前天数为止的歇业日（门店日期 YYYY-MM-DD，每周休息日已展开）。后端算好，小程序只查不推算。 */
  closedDays: string[]
  /** 只在顾客本人的视图里：最近爽约次数达到上限，暂停自助预约。 */
  selfServiceSuspended?: boolean
  /** 只在顾客本人的视图里：请求微信订阅消息用的模板（services/notices.ts），门店没开顾客通知时为空。 */
  noticeTemplates?: Schemas['ReservationView']['noticeTemplates']
  /** 只在员工 scope=open 的视图里：今天被顾客自己取消、还没人点「知道了」的预约（现场页提醒），按开始时间。 */
  customerCancellations?: ReservationEntry[]
  version: string
  targetId?: string
}
export type ReservationAction = Schemas['ReservationAction']

async function read<T>(path: string): Promise<T> {
  try {
    return await request<T>(path)
  } catch (e) {
    const error = e as { code: string; message: string; status: number }
    throw new CustomerError(error.code, error.message, error.status)
  }
}

export const reservations = {
  me: () => read<ReservationView>('/reservations/me'),
  /** 还要处理的：待确认、已确认（含过了宽限期、displayStatus 为 expired 的），按开始时间。 */
  staffOpen: () => request<ReservationView>('/reservations/staff?scope=open'),
  /**
   * 处理完的（已到店、已取消、爽约），开始时间新的在前，服务端分页。
   * 给了门店日期 date（YYYY-MM-DD）就只要到店时间在那一天的，总数与翻页也只算这一天；
   * 哪一天由后端按中国标准时间判断。不给就不限日期。
   */
  staffEnded: (page = 1, date = '', pageSize = 20) =>
    requestPage<ReservationEntry>(
      `/reservations/staff?${queryString({ scope: 'ended', page, pageSize, ...(date ? { date } : {}) })}`,
      page,
      (data) => (data as ReservationView | null)?.reservations || [],
    ),
  /** 员工操作的响应与 staffOpen 相同；顾客操作的响应是本人的预约。 */
  action: (input: ReservationAction) => request<ReservationView>('/reservations/actions', 'POST', input, true),
}

/**
 * 门店联系方式：老板在网页后台「预约设置」里填，随预约视图下发；没填的是空串。
 * 顾客约满上限、想包整间时找门店用，所以只从接口来，不在小程序里写死。
 */
export type StoreContact = { phone: string; wechat: string }

export const storeContact = (settings?: ReservationSettings | null): StoreContact => ({
  phone: settings?.contactPhone?.trim() || '',
  wechat: settings?.contactWechat?.trim() || '',
})

/** 拨号用的号码：只留数字和开头的 +，空格、横线、括号是给人看的。 */
export const dialNumber = (phone: string) => phone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')

/** 联系方式写成一句：「电话 0571-8888 6666，微信号 examplebrand_pindou」；都没填时是空串，由调用方决定写不写。 */
export function contactLine(contact: StoreContact): string {
  return [contact.phone && `电话 ${contact.phone}`, contact.wechat && `微信号 ${contact.wechat}`]
    .filter(Boolean)
    .join('，')
}

export const reservationStatusNames: Record<string, string> = {
  pending: '待确认',
  confirmed: '已确认',
  seated: '已开台',
  cancelled: '已取消',
  no_show: '未到店',
  expired: '已过期',
}

// The store keeps one set of opening hours in China standard time, so slots are
// built from that offset instead of the device clock: a phone left on another
// timezone still sees and books the store's own hours.
const pad = (value: number) => String(value).padStart(2, '0')

export type StoreDate = { year: number; month: number; day: number }

export function storeDate(offsetDays: number, now: Date = new Date()): StoreDate {
  const shifted = new Date(now.getTime() + storeOffsetMinutes * 60000)
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/** 门店日期写成「YYYY-MM-DD」：日期选择器的值、接口的 date 参数都是这个格式。 */
export const isoDate = (date: StoreDate) => `${date.year}-${pad(date.month)}-${pad(date.day)}`

/** isoDate 的反方向。 */
export function parseDate(value: string): StoreDate {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

export function storeInstant(date: StoreDate, minute: number): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day, 0, minute - storeOffsetMinutes))
}

function storeParts(value: string | Date) {
  return new Date(new Date(value).getTime() + storeOffsetMinutes * 60000)
}

export function storeClock(value: string | Date): string {
  const t = storeParts(value)
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`
}

export function storeDayLabel(value: string | Date): string {
  const t = storeParts(value)
  return `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export function storeStamp(value: string | Date): string {
  return `${storeDayLabel(value)} ${storeClock(value)}`
}

/** 「今天 14:00」「明天 09:30」「10-24 周五 14:00」：哪天算今天按门店时区。我的、我的预约里写下一场用。 */
export function friendlyStamp(value: string | Date, now: Date = new Date()): string {
  const day = isoDate(storeDate(0, new Date(value)))
  const offset = [0, 1, 2].findIndex((n) => isoDate(storeDate(n, now)) === day)
  const name =
    offset >= 0 ? ['今天', '明天', '后天'][offset] : `${storeDayLabel(value)} ${weekdayLabel(parseDate(day))}`
  return `${name} ${storeClock(value)}`
}

export function weekdayLabel(date: StoreDate): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  ]
}

export function dayLabel(date: StoreDate, offsetDays: number): string {
  const names = ['今天', '明天', '后天']
  return `${pad(date.month)}-${pad(date.day)} ${names[offsetDays] || weekdayLabel(date)}`
}

/**
 * 门店日期（YYYY-MM-DD）写给人看：「10-05 周一 · 昨天」。昨天到后天写出来，其余只写周几；
 * 哪天算今天按门店时区，不跟手机时区走。员工按日期查「已结束」的预约时用（多是往前看，所以有昨天）。
 */
export function relativeDayLabel(day: string, now: Date = new Date()): string {
  const date = parseDate(day)
  const names: Record<number, string> = { [-1]: '昨天', 0: '今天', 1: '明天', 2: '后天' }
  const offset = [-1, 0, 1, 2].find((n) => isoDate(storeDate(n, now)) === day)
  return `${pad(date.month)}-${pad(date.day)} ${weekdayLabel(date)}${offset === undefined ? '' : ` · ${names[offset]}`}`
}

/** 首页「今天还能约」带到预约页的整点：写成 Unix 秒（导航参数只收字母数字，ISO 时间里的冒号会被滤掉）。 */
export const slotParam = (startAt: string | Date) => String(Math.round(new Date(startAt).getTime() / 1000))

/** slotParam 的反方向；不是秒数时为 null。 */
export function slotFromParam(value?: string): Date | null {
  if (!value || !/^\d{1,12}$/.test(value)) return null
  return new Date(Number(value) * 1000)
}

export function minuteLabel(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
}

// Slots a customer may still pick: inside opening hours, long enough for the
// package, far enough ahead, and not overlapping a seat that is already held.
export function openSlots(
  settings: ReservationSettings,
  date: StoreDate,
  durationMinutes: number,
  now: Date = new Date(),
): Date[] {
  const out: Date[] = []
  if (!durationMinutes) return out
  const earliest = now.getTime() + settings.leadMinutes * 60000
  // 最多提前多少天，后端按「此刻加 N 天」这个绝对时刻判（reservation.go 的 Window），
  // 不是按日历整天。只按日期给到最后一天，那天下午的时段全都会被后端拒收，
  // 顾客选好座位提交才报错，换个座位重试还是错。
  const shifted = new Date(now.getTime() + storeOffsetMinutes * 60000)
  shifted.setUTCDate(shifted.getUTCDate() + settings.advanceDays)
  const latest = shifted.getTime() - storeOffsetMinutes * 60000
  for (
    let minute = settings.openMinute;
    minute + durationMinutes <= settings.closeMinute;
    minute += settings.slotMinutes
  ) {
    const start = storeInstant(date, minute)
    if (start.getTime() > earliest && start.getTime() <= latest) out.push(start)
  }
  return out
}

/**
 * 员工代客登记不受现场会话限制：只把预约当作占用，现场定时会话（kind=session）只提示。
 * 顾客的平面选座两种都算占用，直接用 busy。
 */
export const reservedOnly = (busy: BusySlot[]) => busy.filter((slot) => slot.kind !== 'session')

/** 这个座位在所选时段压到的现场定时会话最晚到什么时候结束（员工登记时提示）；没压到返回 null。 */
export function sessionUntil(
  busy: BusySlot[],
  serviceTableId: string,
  seatNumber: number,
  start: Date,
  durationMinutes: number,
): Date | null {
  const end = start.getTime() + durationMinutes * 60000
  let until: Date | null = null
  for (const slot of busy) {
    if (slot.kind !== 'session' || slot.serviceTableId !== serviceTableId || slot.seatNumber !== seatNumber) continue
    const slotEnd = new Date(slot.endAt)
    if (start.getTime() < slotEnd.getTime() && new Date(slot.startAt).getTime() < end && (!until || slotEnd > until))
      until = slotEnd
  }
  return until
}

export function seatFree(
  busy: BusySlot[],
  serviceTableId: string,
  seatNumber: number,
  start: Date,
  durationMinutes: number,
): boolean {
  const end = start.getTime() + durationMinutes * 60000
  return !busy.some(
    (slot) =>
      slot.serviceTableId === serviceTableId &&
      slot.seatNumber === seatNumber &&
      start.getTime() < new Date(slot.endAt).getTime() &&
      new Date(slot.startAt).getTime() < end,
  )
}
