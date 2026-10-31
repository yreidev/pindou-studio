import { z } from 'zod'
import type { PackageRule, ReservationEntry, SessionOpenInput } from '../../api/board'
import type { ListedAccount } from '../../api/staff'
import { clockTime, dateOnly, money } from '../../lib/format'
import { customerText } from './board'

// 看板上点空闲座位的「开台」（整桌开台，POST /venue-sessions），内容与小程序桌位页的开台弹层一致：
// 顾客（不选为散客）、计时（已发布套餐的时长、其他时长、到打烊或自由计时）、开始时间（默认「现在」，可回填）。
// 回填范围、套餐价只做提示与限制，能不能开、从几点开始以后端为准。系统内收费关着时不标价。

/** 读不到已发布的计时套餐（或一个定时的都没有）时，时长按钮退回 1、2、3 小时，不挡开台（同小程序）。 */
export const fallbackDurations = [60, 120, 180] as const

/** 「其他时长」：30 分钟一档，30 分钟到 8 小时（业主 2026-10-20 定，同小程序）。 */
export const otherDurations = Array.from({ length: 16 }, (_, index) => (index + 1) * 30)

/**
 * 时长按钮：已发布的计时套餐的时长（店里真实卖的），从短到长、去掉重复，最多 4 个（同小程序）；
 * 「到打烊」的套餐不算，另有「到打烊」。
 */
export function openDurations(packages: readonly PackageRule[]): number[] {
  const minutes = packages
    .filter((rule) => rule.kind === 'package' && !rule.untilClose && rule.durationMinutes > 0)
    .map((rule) => rule.durationMinutes)
  const choices = [...new Set(minutes)].sort((a, b) => a - b).slice(0, 4)
  return choices.length ? choices : [...fallbackDurations]
}

/** 「其他时长」下拉里列的：时长按钮上已有的不重复列。 */
export const otherChoices = (durations: readonly number[]) =>
  otherDurations.filter((minutes) => !durations.includes(minutes))

/** 「1 小时」「1 小时 30 分」「45 分钟」（同小程序）。 */
export function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} 小时 ${rest} 分` : `${minutes / 60} 小时`
}

/**
 * 计时：定时的分钟数（时长按钮或「其他时长」）、到打烊（close：从开始时间算到「营业与预约」的每天最晚结束，
 * 不能暂停、续时，2026-10-10 业主定），或自由计时。
 */
export type OpenTiming = number | 'close' | 'free'

export interface OpenFormValues {
  /** 顾客账户；null 是散客。 */
  customer: ListedAccount | null
  timing: OpenTiming
  /** now：点确认开台的那一刻开始；earlier：回填更早的开始时间（clock）。 */
  start: 'now' | 'earlier'
  /** 回填的开始时间「时:分」，门店时区的今天；start 为 now 时不用。 */
  clock: string
}

/**
 * 表单初值：散客、第二个时长按钮（只有一个就是它；按钮是 1、2、3 小时时默认 2 小时）、现在开始。
 * durations 是 openDurations 的结果（同小程序开台弹层）。
 */
export const defaultOpenForm = (durations: readonly number[]): OpenFormValues => ({
  customer: null,
  timing: durations[Math.min(1, durations.length - 1)] ?? fallbackDurations[1],
  start: 'now',
  clock: '',
})

/**
 * 时长按钮下标的价：已发布的计时套餐里时长正好是这么多分钟的那个（同小程序）。系统内收费关着、没有对应套餐
 * （读不到套餐时的 1、2、3 小时）就不写，不编一个价出来。这里只是「引用」已公开的套餐，实际收多少钱以后端为准。
 */
export function durationPrice(packages: readonly PackageRule[], minutes: number, billing: boolean): string {
  if (!billing) return ''
  const rule = packages.find((rule) => rule.kind === 'package' && !rule.untilClose && rule.durationMinutes === minutes)
  return rule ? money(rule.amountCents) : ''
}

/** 「22:00」：从 0 点起的分钟数写成时:分（24:00 照写）。 */
export const minuteClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

/** 到打烊的选项下面那行：「用到 22:00」；今天已到打烊写明开不了（以后端为准）。 */
export function closeNote(closeMinute: number, now: number): string {
  const close = minuteClock(closeMinute)
  const nowMinute = Number(storeClock(now).slice(0, 2)) * 60 + Number(storeClock(now).slice(3))
  return nowMinute >= closeMinute ? `已过 ${close} 打烊` : `用到 ${close} 打烊`
}

/** 门店时区是中国标准时间（没有夏令时），偏移固定。 */
const storeOffset = '+08:00'

/** 此刻在门店时区的「时:分」。 */
export const storeClock = (at: number): string => clockTime(at).slice(0, 5)

/** 门店今天（按 at 所在的门店日期）这个「时:分」对应的时刻，毫秒；格式不对时为 NaN。 */
export function storeInstant(clock: string, at: number): number {
  if (!/^\d{2}:\d{2}$/.test(clock)) return Number.NaN
  return Date.parse(`${dateOnly(at)}T${clock}:00${storeOffset}`)
}

/** 店员最多回填多少分钟（后端同一规则，httpx.go 的 validateStartedAt）。 */
export const clerkBackfillMinutes = 60

const canBackdateToday = (roles: readonly string[]) => roles.includes('manager') || roles.includes('owner')

export interface BackfillWindow {
  /** 最早能回填到的时刻（毫秒，含）。 */
  earliest: number
  /** 最晚：此刻（不能晚于现在）。 */
  latest: number
  /** 写在开始时间下面的说明。 */
  help: string
}

/**
 * 回填开始时间的范围：不晚于现在；店员最早 60 分钟前，店长、老板最早今天 0 点（门店时区）。
 * 开始时间只选「时:分」、日期固定是今天，所以店员在午夜后回填也不跨到昨天。前端只做提示与限制，以后端为准。
 */
export function backfillWindow(roles: readonly string[], now: number): BackfillWindow {
  const dayStart = storeInstant('00:00', now)
  if (canBackdateToday(roles))
    return { earliest: dayStart, latest: now, help: '店长、老板可回填今天更早的开始时间，不能晚于现在。' }
  return {
    earliest: Math.max(dayStart, now - clerkBackfillMinutes * 60_000),
    latest: now,
    help: `店员可回填最近 ${clerkBackfillMinutes} 分钟内的开始时间，不能晚于现在。`,
  }
}

/** 回填的开始时间哪里不行（文字同后端的拒绝说明）；可以时为 null。 */
export function startProblem(clock: string, roles: readonly string[], now: number): string | null {
  const at = storeInstant(clock, now)
  if (!Number.isFinite(at)) return '请选择开始时间'
  if (at > now) return '开始时间不能晚于当前时间'
  if (at < backfillWindow(roles, now).earliest)
    return canBackdateToday(roles) ? '开始时间必须是今天' : `店员最多只能回填 ${clerkBackfillMinutes} 分钟内的开始时间`
  return null
}

const range = (count: number) => Array.from({ length: count }, (_, index) => index)
const pad = (value: number) => String(value).padStart(2, '0')

/** 时间选择器里不能选的小时、分钟：回填范围以外的（见 backfillWindow）。 */
export function disabledClock(window: Pick<BackfillWindow, 'earliest' | 'latest'>, now: number) {
  const allowed = (hour: number, minute: number) => {
    const at = storeInstant(`${pad(hour)}:${pad(minute)}`, now)
    return at >= window.earliest && at <= window.latest
  }
  return {
    hours: () => range(24).filter((hour) => !range(60).some((minute) => allowed(hour, minute))),
    minutes: (hour: number | undefined) =>
      hour === undefined || hour === null ? [] : range(60).filter((minute) => !allowed(hour, minute)),
  }
}

/**
 * 表单校验：只有回填时要看开始时间。now 每次校验时现取：表单开着的时候时间在走，
 * 店员 15 分钟前选的「59 分钟前」点确认时可能已经超了。
 */
export function openFormSchema(roles: readonly string[], now: () => number = Date.now) {
  return z
    .object({
      customer: z.custom<ListedAccount | null>(),
      timing: z.union([z.number().int().positive(), z.enum(['close', 'free'])]),
      start: z.enum(['now', 'earlier']),
      clock: z.string(),
    })
    .superRefine((values, ctx) => {
      if (values.start !== 'earlier') return
      const problem = startProblem(values.clock, roles, now())
      if (problem) ctx.addIssue({ code: 'custom', path: ['clock'], message: problem })
    })
}

/**
 * 开台的请求体。开始时间没改（「现在」）就不带 startedAt，由服务器在收到请求的那一刻开始计：既不是打开面板的那一刻
 * （找顾客、等注册拖了二十分钟再点确认，也从点确认时开始计），也不看这台电脑的时钟——2026-10-06 服务器没对时、
 * 慢 2 秒，带上电脑时间的「现在」全被当成未来时间拒了。回填的才带开始时间（now 只用来定「今天」）。
 * 散客不带 accountId，自由计时不带 durationMinutes（契约要求省略）；到打烊带 untilClose、不带分钟数，由服务器按开始时间算到打烊。
 */
export function openSessionInput(serviceTableId: string, values: OpenFormValues, now: number): SessionOpenInput {
  return {
    serviceTableId,
    ...(values.customer ? { accountId: values.customer.id } : {}),
    ...(values.start === 'earlier' ? { startedAt: new Date(storeInstant(values.clock, now)).toISOString() } : {}),
    timingMode: values.timing === 'free' ? 'free' : 'timed',
    ...(values.timing === 'free'
      ? {}
      : values.timing === 'close'
        ? { untilClose: true }
        : { durationMinutes: values.timing }),
  }
}

/** 确认按钮旁的一行：「小王（138****1234）· 2 小时 · 现在开始」。 */
export function openSummary(values: OpenFormValues): string {
  const who = values.customer ? customerText(values.customer) : '散客'
  const timing =
    values.timing === 'free' ? '自由计时' : values.timing === 'close' ? '到打烊' : minutesText(values.timing)
  const start = values.start === 'earlier' && values.clock ? `${values.clock} 开始` : '现在开始'
  return `${who} · ${timing} · ${start}`
}

/**
 * 这张桌今天还要到店的预约（待确认、已确认，还没结束的），按开始时间排。开台的时段压到它们时后端会拒绝开台，
 * 面板上先提醒，免得员工点了确认才知道。
 */
export function tableBookings(entries: readonly ReservationEntry[], tableId: string, now: number): ReservationEntry[] {
  const today = dateOnly(now)
  return entries
    .filter(
      (entry) =>
        entry.reservation.serviceTableId === tableId &&
        (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed') &&
        dateOnly(entry.reservation.startAt) === today &&
        Date.parse(entry.endAt) > now,
    )
    .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))
}

/** 预约一行：「14:30–16:30 小王（已确认）」。 */
export function bookingText(entry: ReservationEntry): string {
  const hm = (value: string) => storeClock(Date.parse(value))
  const who = entry.customerName || '未填写称呼'
  const status = entry.displayStatus === 'confirmed' ? '已确认' : '待确认'
  return `${hm(entry.reservation.startAt)}–${hm(entry.endAt)} ${who}（${status}）`
}
