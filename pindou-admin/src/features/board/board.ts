import type {
  AdmissionView,
  BoardData,
  PackageRule,
  ReservationEntry,
  ServiceTable,
  SessionUpdate,
  VenueSession,
} from '../../api/board'
import { money } from '../../lib/format'
import { packageDuration } from '../../lib/packages'
import type { RealtimeStatus } from '../../realtime/connection'
import { planSeats, zoneNames, type PlanSeat } from './layout'

// 「现场」看板的展示规则。业务状态一律以接口为准：占用、计时摘要、快到点与超时（timingStatus）由后端
// 按当前时间算好；这里只决定怎么摆、怎么写，以及两次重读之间按 endsAt 倒数显示剩余分钟。

/**
 * 一个座位此刻的样子。free 空闲；running 使用中；companion 陪客中（整桌开台标记了陪客，不计费）；
 * expiring 快到点（后端判定剩余 10 分钟以内）；overdue 已超时（后端判定过了结束时间）；paused 暂停中；
 * stopped 已停止计时、保留座位等结账；off 停用。
 */
export type SeatState = 'free' | 'running' | 'companion' | 'expiring' | 'overdue' | 'paused' | 'stopped' | 'off'

export const seatStateNames: Record<SeatState, string> = {
  free: '空闲',
  running: '使用中',
  companion: '陪客中',
  expiring: '快到点',
  overdue: '已超时',
  paused: '暂停',
  stopped: '待结账',
  off: '停用',
}

/** 图例与计数的顺序。 */
export const seatStateOrder: SeatState[] = [
  'free',
  'running',
  'companion',
  'expiring',
  'overdue',
  'paused',
  'stopped',
  'off',
]

/** 座位上标出多少分钟内要到店的预约。 */
export const bookingMarkMinutes = 30
/** 侧栏「即将到店」列出多少分钟内的预约。 */
export const arrivalListMinutes = 60

/** 实时连着时 30 秒重读一次（快到点、超时随时间变化，没有事件推过来）；断线时 10 秒一次。 */
export function refetchInterval(status: RealtimeStatus): number {
  return status === 'open' ? 30_000 : 10_000
}

export interface BoardSeat extends PlanSeat {
  /** 桌位接口里这张桌；布局里有、接口里没有（不应发生）时为空，按停用画。 */
  table?: ServiceTable
  /** 这张桌以哪个会话为准，见 primarySession。 */
  session?: VenueSession
  /** 同桌进行中的会话数（陪客等少见情况会多于 1）。 */
  sessionCount: number
  /** 按座会话在当班申请里的那一条：顾客称呼、套餐快照、sessionVersion。 */
  admission?: AdmissionView
  state: SeatState
  /** 30 分钟内要到店的预约里最早的一条。 */
  booking?: ReservationEntry
}

/**
 * 一张桌以哪个会话为准：后端的计时摘要取「最早到期」的那个，开始时间（startedAt）和它对得上；
 * 对不上（自由计时等）取第一个。实际上一张桌同时只有一组客人，多数时候只有一个会话。
 */
export function primarySession(table: ServiceTable, sessions: VenueSession[]): VenueSession | undefined {
  const mine = sessions.filter((session) => session.serviceTableId === table.id)
  if (mine.length <= 1) return mine[0]
  const started = table.startedAt ? Date.parse(table.startedAt) : Number.NaN
  return mine.find((session) => Date.parse(session.startedAt) === started) ?? mine[0]
}

/**
 * 座位状态。停止计时、暂停优先于快到点和超时：停了的在等结账、暂停的不走时间，都不该再催。
 * 快到点、超时只认后端的 timingStatus，不在前端按剩余秒数自己判（陪客也照样提醒，和小程序工作台一致）；
 * 其余时候陪客会话写「陪客中」，不写「使用中」：看板上要看得出这一台不按套餐收费。
 */
export function seatState(table: ServiceTable | undefined, session: VenueSession | undefined): SeatState {
  if (!table || !table.enabled) return 'off'
  if (table.occupancy !== 'occupied') return 'free'
  if (session?.stoppedAt) return 'stopped'
  if (session?.status === 'paused') return 'paused'
  if (table.timingStatus === 'overdue') return 'overdue'
  if (table.timingStatus === 'expiring') return 'expiring'
  if (session?.status === 'companion') return 'companion'
  return 'running'
}

/**
 * 剩余秒数，负数是超时了多久；自由计时、没有结束时间、没人用时为 null。
 * 计时中按 endsAt 倒数（两次重读之间不必等接口）；暂停中的不走时间，停在读到那一刻；
 * 已停止的停在停止那一刻（后端也是按停止时间算的）。
 */
export function remainingSeconds(
  seat: Pick<BoardSeat, 'table' | 'session' | 'state'>,
  now: number,
  fetchedAt: number,
): number | null {
  if (seat.state === 'free' || seat.state === 'off' || seat.session?.timingMode === 'free') return null
  const endsAt = seat.table?.endsAt ? Date.parse(seat.table.endsAt) : Number.NaN
  if (!Number.isFinite(endsAt)) return null
  let at = now
  if (seat.state === 'paused') at = fetchedAt
  if (seat.state === 'stopped') {
    const stoppedAt = seat.session?.stoppedAt ? Date.parse(seat.session.stoppedAt) : Number.NaN
    at = Number.isFinite(stoppedAt) ? stoppedAt : fetchedAt
  }
  return Math.floor((endsAt - at) / 1000)
}

/** 分钟向上取整：还剩 30 秒也写「1 分」，超时 10 秒也写「超时 1 分」。 */
const minutesOf = (seconds: number) => Math.ceil(seconds / 60)
/** 剩余分钟，不小于 0：两次重读之间倒数过了 0、后端还没判超时的，先写 0。 */
const leftMinutes = (seconds: number) => Math.max(0, minutesOf(seconds))
/**
 * 超时分钟：按整分钟向下取整、至少 1，和计价口径一致（不足一分钟不算；超时 10 分 30 秒写 10 分钟，
 * 计价说明也写「超时 10 分钟」——2026-10-06 业主定）。
 */
const overMinutes = (seconds: number) => Math.max(1, Math.floor(-seconds / 60))

/** 平面图上座位里的一行短字。 */
export function seatShortText(seat: Pick<BoardSeat, 'state'>, seconds: number | null): string {
  switch (seat.state) {
    case 'free':
    case 'off':
    case 'paused':
    case 'stopped':
      return seatStateNames[seat.state]
    case 'overdue':
      return seconds === null ? '超时' : `超${overMinutes(seconds)}分`
    default:
      return seconds === null ? '自由' : `剩${leftMinutes(seconds)}分`
  }
}

/** 列表、详情和读屏用的完整说法。 */
export function timingText(seat: Pick<BoardSeat, 'state'>, seconds: number | null): string {
  switch (seat.state) {
    case 'free':
      return '空闲'
    case 'off':
      return '已停用'
    case 'stopped':
      return '计时已停止，待结账'
    case 'paused':
      if (seconds === null) return '暂停中'
      return seconds < 0 ? `暂停中，已超时 ${overMinutes(seconds)} 分钟` : `暂停中，剩余 ${leftMinutes(seconds)} 分钟`
    case 'overdue':
      return seconds === null ? '已超时' : `已超时 ${overMinutes(seconds)} 分钟`
    default:
      return seconds === null ? '自由计时' : `剩余 ${leftMinutes(seconds)} 分钟`
  }
}

/**
 * 还要等员工处理的预约（待确认、已确认；过了宽限期的 expired 不算），开始时间在 within 分钟以内的，
 * 包括已经到了开始时间、还在宽限期里没到店的。按开始时间排。
 */
export function upcomingReservations(entries: ReservationEntry[], now: number, within: number): ReservationEntry[] {
  const limit = now + within * 60_000
  return entries
    .filter(
      (entry) =>
        (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed') &&
        Date.parse(entry.reservation.startAt) <= limit,
    )
    .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))
}

/** 到店开台按哪个套餐：后端按现行发布的同一套餐开台计时、建订单，不按预约时记下的快照。 */
export interface SeatingPlan {
  /** 现行发布的那个套餐；停用了就没有，后端会拒绝开台。 */
  pkg?: PackageRule
  /** 和预约时记下的名称、时长或价格不一样。 */
  changed: boolean
  /** 确认框里的说明：按哪个套餐开台，或为什么不能开。 */
  text: string
  /** 和预约时不一样时，预约时是什么（确认框里单独提醒）。 */
  note?: string
}

/**
 * 到店开台确认框写的套餐。以前写的是预约时记下的套餐名和时长，后端却按现行发布的套餐开台：
 * 套餐之后改过价或时长，员工确认的和实际开出来的不是一回事。现在按现行发布的写，不一样时说明预约时是什么。
 * 系统内收费关着时（billing 为 false）不建单，不写价格，也不比价格。
 */
export function seatingPlan(entry: ReservationEntry, packages: PackageRule[], billing: boolean): SeatingPlan {
  const booked = entry.reservation
  const pkg = packages.find((rule) => rule.id === booked.packageId && rule.kind === 'package')
  if (!pkg)
    return {
      changed: true,
      text: `预约时的套餐「${booked.packageName}」已停用，不能按预约到店开台：请改用现场开台或另选套餐。`,
    }
  const text = billing
    ? `按现行套餐「${pkg.name}」开台计时（${packageDuration(pkg)}，${money(pkg.amountCents)}），生成套餐的待结账订单。`
    : `按现行套餐「${pkg.name}」开台计时（${packageDuration(pkg)}）。`
  // 到打烊的套餐预约时按约的开始时间算到打烊，时长本来就和套餐（0）不一样，不算改过
  const changed =
    pkg.name !== booked.packageName ||
    (!pkg.untilClose && pkg.durationMinutes !== booked.durationMinutes) ||
    (billing && pkg.amountCents !== booked.amountCents)
  if (!changed) return { pkg, changed, text }
  const was = billing
    ? `「${booked.packageName}」${booked.durationMinutes} 分钟、${money(booked.amountCents)}`
    : `「${booked.packageName}」${booked.durationMinutes} 分钟`
  return {
    pkg,
    changed,
    text,
    note: `预约时是${was}，套餐之后改过，开台按现行的${billing ? '计时计价' : '计时'}。`,
  }
}

/** 待确认的扫码入座申请（看 displayStatus：过期的已存状态仍是 pending），先申请的在前（先过期）。 */
export function pendingAdmissions(admissions: AdmissionView[]): AdmissionView[] {
  return admissions
    .filter((entry) => entry.displayStatus === 'pending')
    .sort((a, b) => Date.parse(a.admission.createdAt) - Date.parse(b.admission.createdAt))
}

/** 把桌位、会话、申请、预约贴到平面图的每个座位上。 */
export function boardSeats(data: BoardData, now: number): BoardSeat[] {
  const tables = new Map(data.tables.map((table) => [table.code, table]))
  const bookings = upcomingReservations(data.reservations, now, bookingMarkMinutes)
  return planSeats.map((plan) => {
    const table = tables.get(plan.code)
    const session = table ? primarySession(table, data.sessions) : undefined
    return {
      ...plan,
      table,
      session,
      sessionCount: table ? data.sessions.filter((item) => item.serviceTableId === table.id).length : 0,
      admission: session?.admissionId ? data.admissions.find((entry) => entry.session?.id === session.id) : undefined,
      state: seatState(table, session),
      booking: table ? bookings.find((entry) => entry.reservation.serviceTableId === table.id) : undefined,
    }
  })
}

/** 各状态的座位数。 */
export function stateCounts(seats: BoardSeat[]): Record<SeatState, number> {
  const counts = Object.fromEntries(seatStateOrder.map((state) => [state, 0])) as Record<SeatState, number>
  for (const seat of seats) counts[seat.state]++
  return counts
}

export interface Reminder {
  seat: BoardSeat
  /** 剩余秒数，负数为已超时。 */
  seconds: number
}

/** 快到点与已超时的座位，按剩余时间排：超时最久的在最前。 */
export function reminders(seats: BoardSeat[], now: number, fetchedAt: number): Reminder[] {
  return seats
    .filter((seat) => seat.state === 'expiring' || seat.state === 'overdue')
    .map((seat) => ({ seat, seconds: remainingSeconds(seat, now, fetchedAt) ?? 0 }))
    .sort((a, b) => a.seconds - b.seconds || a.seat.code.localeCompare(b.seat.code))
}

/** 点得开详情的座位：有人在用（含暂停、待结账）且读到了会话。 */
export function openable(seat: BoardSeat): boolean {
  return Boolean(seat.session) && seat.state !== 'free' && seat.state !== 'off'
}

/** 点了开台的座位：空闲、启用（整桌开台按座位对应的那张桌）。停用的不开台；能不能开最终以后端为准。 */
export function startable(seat: Pick<BoardSeat, 'state' | 'table'>): boolean {
  return seat.state === 'free' && Boolean(seat.table?.enabled)
}

/** 「A3」；多座的桌带座号（「A3 · 2 号座」），整桌单位写「D1 · 整桌」。找不到桌时如实说。 */
export function tablePlace(table: Pick<ServiceTable, 'code' | 'seatCount' | 'wholeTable'> | undefined, seat?: number) {
  if (!table) return '桌位待核对'
  if (table.wholeTable) return `${table.code} · 整桌`
  if (table.seatCount > 1 && seat) return `${table.code} · ${seat} 号座`
  return table.code
}

/** 会话详情里的座位：「A3（A 区）」，多座、整桌同 tablePlace。 */
export function seatPlace(seat: Pick<BoardSeat, 'code' | 'zone' | 'table' | 'session'>): string {
  const zone = zoneNames.get(seat.zone)
  const place = tablePlace(seat.table ?? { code: seat.code, seatCount: 1, wholeTable: false }, seat.session?.seatNumber)
  return zone ? place.replace(seat.code, `${seat.code}（${zone}）`) : place
}

/** 顾客称呼：「小王（138****1234）」；没留手机号只写昵称；没有称呼时为空串。 */
export function customerText(label: { nickname: string; phoneMasked?: string } | null | undefined): string {
  if (!label) return ''
  return label.phoneMasked ? `${label.nickname}（${label.phoneMasked}）` : label.nickname
}

/** 提醒栏右侧的标签：「超时 5 分」「剩 8 分」。 */
export function reminderText({ seat, seconds }: Reminder): string {
  return seat.state === 'overdue' ? `超时 ${overMinutes(seconds)} 分` : `剩 ${leftMinutes(seconds)} 分`
}

/** 预约过了开始时间几分钟（还在宽限期里没到店）；没到开始时间为 0。 */
export function lateMinutes(entry: ReservationEntry, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(entry.reservation.startAt)) / 60_000))
}

/** 整桌会话的续时方案（后端按开台时记下的价给，见契约 ServiceTableSession.renewal）。 */
export type RenewalPlan = NonNullable<VenueSession['renewal']>

/**
 * 续时：按座会话按入座时的套餐续一块；整桌会话按分钟续，有续时方案（plan）时另给「续 N 分钟」（renewChoices）。
 */
export type RenewOption =
  { kind: 'package'; minutes: number; cents: number } | { kind: 'minutes'; plan: RenewalPlan | null }

/** 整桌会话「续 N 分钟」的几个按钮：续时方案的 1、2、3 块（续时上限 1440 分钟以内的）。 */
export const renewChoices = (plan: RenewalPlan) =>
  [1, 2, 3].map((blocks) => blocks * plan.minutes).filter((minutes) => minutes <= 1440)

/** 会话详情里能做的事。都只决定显示，能否执行由后端判定。 */
export interface SessionActions {
  /** 按座会话（扫码入座、预约到店开的）走 /loyalty/actions；整桌会话走 /venue-sessions。 */
  seatBased: boolean
  pause: boolean
  /** 有值时暂停按钮置灰并写明原因。 */
  pauseBlocked?: string
  resume: boolean
  renew: RenewOption | null
  /**
   * 单独的「停止计时」按钮（系统内收费开着、整桌会话还在计时的；陪客不计时、没有它）：停了以后计价冻结在那一刻，
   * 座位保留到结账，不能再暂停、继续或续时。整桌会话的「去结账」不先停：中途建单加商品时计时照走。
   */
  stop: boolean
  /** 「去结账」：只在系统内收费开着时有。 */
  checkout: boolean
  /** 去结账前先停止计时（按座会话还没停的）。整桌会话用上面单独的「停止计时」，去结账不先停。 */
  stopFirst: boolean
  checkoutLabel: string
  /**
   * 「结束」：系统内收费关着时有（2026-10-10 业主定），结束计时、立刻放座，不建单不收款。进行中的都能结束，
   * 含暂停、陪客和开关关掉之前停了计时的。
   */
  end: boolean
  /** 按座会话的操作要带 sessionVersion，没读到对应申请时（两次读取之间）先不让点。 */
  waiting: boolean
  /**
   * 换到哪儿：整桌会话换桌（整张桌搬过去）；按座会话换座（选桌和座号，计时、套餐照旧）。
   * 同小程序：整桌会话在会话页「换桌」，按座会话在「会员与计时」的「换座」（停止计时、等结账的也能换）。
   */
  move: 'table' | 'seat'
  /**
   * 标记陪客：只有整桌会话有（按座会话不设陪客，小程序里是「扫码入座的体验不支持这个操作」）。
   * 已经是陪客的为 marked，按钮置灰；陪客标了不能改回，标错了撤销开台后重开。
   */
  companion: 'available' | 'marked' | null
  /**
   * 撤销误开：只有整桌会话有。按座会话撤销等于把顾客买的套餐单抹掉，实际消费免收另须授权，不能当误开撤销。
   */
  cancel: boolean
}

/**
 * billing：系统内收费开着没有。开到打烊的（会话带 untilClose：整桌「到打烊」或按座「到打烊」的套餐）用到打烊为止，
 * 不能暂停、续时，整桌的也不能标陪客（后端也拒绝）。
 */
export function sessionActions(
  seat: Pick<BoardSeat, 'session' | 'admission'>,
  billing: boolean,
): SessionActions | null {
  const session = seat.session
  if (!session) return null
  const untilClose = Boolean(session.untilClose)
  if (session.admissionId) {
    const stopped = Boolean(session.stoppedAt)
    const pkg = seat.admission?.admission.package
    return {
      seatBased: true,
      stop: false,
      pause: !stopped && !untilClose && session.status === 'active',
      pauseBlocked: pkg && pkg.pauseLimitMinutes === 0 ? '这个套餐不能暂停' : undefined,
      resume: !stopped && session.status === 'paused',
      renew:
        !stopped && !untilClose && pkg && pkg.renewalMinutes > 0
          ? { kind: 'package', minutes: pkg.renewalMinutes, cents: pkg.renewalCents }
          : null,
      checkout: billing,
      stopFirst: billing && !stopped,
      checkoutLabel: stopped ? '去结账' : '停止计时并去结账',
      end: !billing,
      waiting: !seat.admission?.sessionVersion,
      move: 'seat',
      companion: null,
      cancel: false,
    }
  }
  // 陪客会话不给暂停、继续：陪客只记在会话状态上，暂停再继续就成了普通计时，建单按套餐价收了陪客的钱（后端也拒绝）。
  // 停止计时、等结账的（同按座会话）：只剩换桌、撤销和去结账，暂停、继续、续时、标陪客后端都拒绝
  const companion = session.status === 'companion'
  const stopped = Boolean(session.stoppedAt)
  const timing = !companion && !stopped
  return {
    seatBased: false,
    stop: billing && timing,
    pause: timing && !untilClose && session.status !== 'paused',
    resume: timing && session.status === 'paused',
    renew:
      !stopped && !untilClose && session.timingMode === 'timed'
        ? { kind: 'minutes', plan: session.renewal ?? null }
        : null,
    checkout: billing,
    stopFirst: false,
    checkoutLabel: '去结账',
    end: !billing,
    waiting: false,
    move: 'table',
    companion: stopped || untilClose ? null : companion ? 'marked' : 'available',
    cancel: true,
  }
}

/**
 * 整桌续时后的提示：草稿已按新时长改价就报新应收；草稿明细被员工改过、没有自动改价，要员工去结账页核对。
 * 没有草稿时为 null。金额只取后端给的，不在这里算。
 */
export function draftOrderNotice(
  update: Pick<SessionUpdate, 'draftOrder'>,
): { repriced: boolean; text: string; orderId: string } | null {
  const draft = update.draftOrder
  if (!draft) return null
  return draft.repriced
    ? { repriced: true, orderId: draft.id, text: `待结账订单已按新时长改为 ${money(draft.receivableCents)}` }
    : {
        repriced: false,
        orderId: draft.id,
        text: `这一台的待结账订单明细被改过，没有按新时长自动改价（现在应收 ${money(draft.receivableCents)}）。请到结账页核对计时费。`,
      }
}

/** 整桌会话续时的分钟数：1–1440 的整数，否则 null。 */
export function renewMinutes(value: number | string | undefined | null): number | null {
  const minutes = typeof value === 'number' ? value : Number(String(value ?? '').trim() || Number.NaN)
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null
}
