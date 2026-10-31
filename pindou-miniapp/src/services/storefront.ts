import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import { nightSchoolFromHour, nightSchoolName } from '../brand'
import { apiBase } from './api-base'
import type { Member, Table } from './membership'
import { isoDate, storeClock, storeDate, type ReservationEntry } from './reservations'
import type { WholeTableSession } from './whole-table'

// 小程序首页与「图纸」页的内容（迁移 025，方案见 docs/plan-home-and-patterns.md）：公告、门店地址与营业状态、
// 今天还能约的整点、本周上新和图纸库。都是公开接口，没登录也能读。
// 余座、营业状态、算不算上新都由后端按读取时刻算好，这里只挑说法、排版，不自己判。

type Schemas = components['schemas']
export type Storefront = Schemas['Storefront']
export type StoreContact = Schemas['StoreContact']
export type TodaySlot = Storefront['slots'][number]
export type Pattern = Schemas['Pattern']
export type PatternCategory = Schemas['PatternCategory']
export type PatternLibrary = Schemas['PatternLibrary']

const base = apiBase.replace(/\/$/, '')

async function publicGet<T>(path: string, failure: string): Promise<T> {
  const response = await Taro.request<T>({ url: `${base}${path}`, timeout: 15000 })
  if (response.statusCode !== 200) throw new Error(failure)
  return response.data
}

export const storefront = {
  /** 首页：公告、联系方式与地址、今天的营业状态、今天还能约、本周上新。 */
  home: () => publicGet<Storefront>('/storefront', '首页内容暂时无法加载'),
  /** 顾客看的图纸库：只有上架的图纸和启用的分类，按员工排的顺序。 */
  patterns: () => publicGet<PatternLibrary>('/patterns', '图纸暂时无法加载'),
}

/** 图片地址：接口给的路径相对接口根地址，带着图片版本，换图后不会用到旧缓存。 */
export const imageUrl = (path: string) => `${base}${path}`

/**
 * 底部第二格（2026-10-28 业主定，docs/plan-home-and-patterns.md）：店里有上架的图纸叫「图纸」；一张都没有时叫「做图纸」，
 * 页面只放做图纸的入口，不摆一块空的「店里的图纸」（0.0.37 提审因【图纸】页「无具体运营内容」被驳回）。
 * 业主在网页后台上架第一张图纸，顾客下次打开就变回「图纸」，不用再发版。
 */
export const patternsTabText = (hasPatterns: boolean) => (hasPatterns ? '图纸' : '做图纸')

export type PatternFilter = { key: string; label: string }

/** 「图纸」页的筛选：全部、本周上新（有上新的时候）、有图纸的分类（按员工排的顺序；停用的分类后端不给）。 */
export function patternFilters(library: PatternLibrary): PatternFilter[] {
  const used = new Set(library.patterns.map((pattern) => pattern.categoryId))
  return [
    { key: 'all', label: '全部' },
    ...(library.patterns.some((pattern) => pattern.isNew) ? [{ key: 'new', label: '本周上新' }] : []),
    ...library.categories
      .filter((category) => category.enabled && used.has(category.id))
      .map((category) => ({ key: category.id, label: category.name })),
  ]
}

/** 按筛选取图纸，顺序照员工排的。 */
export function filterPatterns(patterns: readonly Pattern[], key: string): Pattern[] {
  if (key === 'new') return patterns.filter((pattern) => pattern.isNew)
  if (key === 'all') return [...patterns]
  return patterns.filter((pattern) => pattern.categoryId === key)
}

/** 图纸的分类名；不分类或分类已停用（顾客看不到）时为空串。 */
export const categoryName = (library: PatternLibrary, pattern: Pattern) =>
  library.categories.find((category) => category.id === pattern.categoryId && category.enabled)?.name || ''

/** 门店行的营业状态：「营业中 · 10:00–22:00」「休息中 · 10:00–22:00 营业」「今天店休」。 */
export function openingLine(today: Storefront['today']): string {
  const hours = `${today.opensAt}–${today.closesAt}`
  if (today.status === 'open') return `营业中 · ${hours}`
  if (today.status === 'day_off') return '今天店休'
  return `休息中 · ${hours} 营业`
}

/** 公告在首页只显示第一行，点开看全文。 */
export const announcementTitle = (body: string) => body.split('\n')[0].trim()

export type SlotCell = {
  startAt: string
  /** 「14:00」 */
  time: string
  /** 格子第二行：「余 3 座」「已满」，18 点起写「示例工坊夜校」 */
  note: string
  full: boolean
  night: boolean
  /** 读屏用的完整说法 */
  label: string
}

/** 今天还能约的格子。几点按门店时间写（不跟手机时区走），夜校只是给晚间时段贴个名字，约不约得上看 remaining。 */
export function slotCells(slots: readonly TodaySlot[]): SlotCell[] {
  return slots.map((slot) => {
    const time = storeClock(slot.startAt)
    const night = Number(time.slice(0, 2)) >= nightSchoolFromHour
    const full = slot.remaining === 0
    return {
      startAt: slot.startAt,
      time,
      note: full ? '已满' : night ? nightSchoolName : `余 ${slot.remaining} 座`,
      full,
      night,
      label: `${time} 开始，${full ? '已约满' : `还能约 ${slot.remaining} 个座位`}${night ? `，${nightSchoolName}` : ''}`,
    }
  })
}

/** 今天的一个格子都没有时说明为什么（关了自助预约时整块不显示，不走这里）。 */
export const noSlotsLine = (today: Storefront['today']) =>
  today.status === 'day_off' ? '今天店休，看看别的日子' : '今天没有能约的整点了，看看别的日子'

/** 首页进行中的这次手作：扫码入座的按座计时、店员开台的整桌计时，取一个。 */
export type Visit = {
  /** 「C1 桌 · 2 号座」「D1 桌」 */
  table: string
  /** 等员工确认开台：还没开始计时 */
  pending: boolean
  startedAt?: string
  free: boolean
  /** 已用分钟（扣掉暂停） */
  minutes: number
  /** 定时的还剩几分钟；自由计时、陪客为 null */
  remaining: number | null
  /** 超时几分钟，没超为 0 */
  overdue: number
  state: '等员工确认' | '计时中' | '已暂停' | '陪客' | '计时已停止'
  /** 能呼叫店员时是这次计时的会话编号 */
  callSessionId: string | null
}

const tableLabel = (tables: readonly Table[], id: string | undefined, seat?: number) => {
  const table = tables.find((item) => item.id === id)
  const name = table ? `${table.code || table.number} 桌` : '桌位待核对'
  return seat ? `${name} · ${seat} 号座` : name
}

/**
 * 正在店里的这次：计时中的优先，其次是等员工确认的申请；都没有为 null。
 * 口径同「本次手作」页（loyalty.me 的 admissions 与 /venue-sessions/me）。
 */
export function visitOf(
  admissions: Member['admissions'],
  tables: readonly Table[],
  wholeTable: readonly WholeTableSession[],
): Visit | null {
  for (const view of admissions) {
    const session = view.session
    if (!session || !['active', 'paused', 'companion'].includes(session.status)) continue
    const free = session.timingMode === 'free'
    return {
      table: tableLabel(tables, session.serviceTableId, session.seatNumber || view.admission.seatNumber),
      pending: false,
      startedAt: session.startedAt,
      free,
      minutes: Math.floor((view.elapsedSeconds || 0) / 60),
      remaining: free || session.status === 'companion' ? null : Math.ceil((view.remainingSeconds || 0) / 60),
      overdue: Math.ceil((view.overdueSeconds || 0) / 60),
      state: session.stoppedAt
        ? '计时已停止'
        : session.status === 'paused'
          ? '已暂停'
          : session.status === 'companion'
            ? '陪客'
            : '计时中',
      callSessionId: ['active', 'paused'].includes(session.status) ? session.id : null,
    }
  }
  const session = wholeTable[0]
  if (session) {
    const free = session.timingMode === 'free'
    return {
      table: session.tableCode ? `${session.tableCode} 桌` : '整桌计时',
      pending: false,
      startedAt: session.startedAt,
      free,
      minutes: Math.floor(session.elapsedSeconds / 60),
      remaining: free || session.displayStatus === 'companion' ? null : Math.ceil((session.remainingSeconds || 0) / 60),
      overdue: Math.ceil((session.overdueSeconds || 0) / 60),
      state: ({ running: '计时中', paused: '已暂停', companion: '陪客', stopped: '计时已停止' } as const)[
        session.displayStatus
      ],
      callSessionId: session.canCallStaff ? session.id : null,
    }
  }
  const waiting = admissions.find((view) => view.displayStatus === 'pending')
  if (!waiting) return null
  return {
    table: tableLabel(tables, waiting.admission.serviceTableId, waiting.admission.seatNumber),
    pending: true,
    free: false,
    minutes: 0,
    remaining: null,
    overdue: 0,
    state: '等员工确认',
    callSessionId: null,
  }
}

/** 今天还要来的那条预约（待确认、已确认，还没结束），最早的一条；没有为 null。哪天算今天按门店时区。 */
export function todaysReservation(
  entries: readonly ReservationEntry[],
  now: Date = new Date(),
): ReservationEntry | null {
  const today = isoDate(storeDate(0, now))
  return (
    entries
      .filter(
        (entry) =>
          (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed') &&
          isoDate(storeDate(0, new Date(entry.reservation.startAt))) === today &&
          Date.parse(entry.endAt) > now.getTime(),
      )
      .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))[0] ?? null
  )
}

/** 还要来的预约（待确认、已确认，还没结束）里最早的一条，不限今天；没有为 null。「我的」里写下一场用。 */
export function nextReservation(entries: readonly ReservationEntry[], now: Date = new Date()): ReservationEntry | null {
  return (
    entries
      .filter(
        (entry) =>
          (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed') &&
          Date.parse(entry.endAt) > now.getTime(),
      )
      .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))[0] ?? null
  )
}

/** 离预约开始还有多久：「还有 1 小时 20 分钟」「还有 8 分钟」；到点了写「已到开始时间」。只是两次刷新之间的显示。 */
export function untilLabel(startAt: string, now: number = Date.now()): string {
  const minutes = Math.ceil((Date.parse(startAt) - now) / 60000)
  if (minutes <= 0) return '已到开始时间'
  const hours = Math.floor(minutes / 60)
  if (!hours) return `还有 ${minutes} 分钟`
  return `还有 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}

/** 白天的问候（安卓这类高屏手机首页顶上一行）：按门店时间分早上、中午、下午、晚上。 */
export function greeting(now: Date = new Date()): string {
  const hour = Number(storeClock(now).slice(0, 2))
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

// ---- 首页一屏分档 ----
//
// 首页不滑动：样式用固定像素（PX，不随屏宽缩放），所以按可用高度挑放哪些块、上新用哪一档。
// 块高照画布「F 一屏版」：块之间 14、上下各 12 的内边距。放不下最小一档时退回正常滚动。

export const homeBlockHeights = {
  staff: 52,
  start: 76,
  card: 148,
  actions: 68,
  announcement: 44,
  slots: 86,
  store: 56,
  greeting: 36,
  large: 190,
  small: 140,
  row: 80,
} as const
export const homeGap = 14
export const homePadding = 24

export type HomeBlocks = {
  /** 员工工作台入口 */
  staff: boolean
  /** 顶上那块：本次手作按钮，或正在店里、今天有预约的状态卡 */
  status: 'start' | 'visit' | 'reservation'
  announcement: boolean
  /** 今天还能约（有状态卡时不显示） */
  slots: boolean
  /** 本周上新有几张 */
  featured: number
  store: boolean
  /** 登录了才有问候 */
  greeting: boolean
}

export type FeaturedSize = 'large' | 'small' | 'row' | 'none'
export type HomeLayout = { featured: FeaturedSize; greeting: boolean; fits: boolean }

const total = (heights: number[]) =>
  heights.length ? homePadding + heights.reduce((sum, value) => sum + value, 0) + homeGap * (heights.length - 1) : 0

/**
 * 按可用高度（窗口高减去导航栏）挑档：上新先试 3 张大图、再 3 张小图、再一行；
 * 放下了大图（或还没有图纸）还有空，登录的人加一行问候。放不下一行上新就不放上新；连固定块都放不下时 fits 为 false，
 * 页面照常滚动，上新用小图。
 */
export function homeLayout(available: number, blocks: HomeBlocks): HomeLayout {
  const h = homeBlockHeights
  const fixed = [
    blocks.staff ? h.staff : 0,
    blocks.status === 'start' ? h.start : h.card,
    h.actions,
    blocks.announcement ? h.announcement : 0,
    blocks.slots && blocks.status === 'start' ? h.slots : 0,
    blocks.store ? h.store : 0,
  ].filter(Boolean)
  const sizes: FeaturedSize[] = blocks.featured ? ['large', 'small', 'row'] : []
  for (const size of sizes) {
    const heights = [...fixed, h[size as 'large' | 'small' | 'row']]
    if (total(heights) > available) continue
    const greet = blocks.greeting && size === 'large' && total([...heights, h.greeting]) <= available
    return { featured: size, greeting: greet, fits: true }
  }
  if (total(fixed) <= available) {
    // 还没有图纸时空余最多，放得下就问候；有图纸却连一行都放不下时不问候
    const greet = blocks.greeting && !blocks.featured && total([...fixed, h.greeting]) <= available
    return { featured: 'none', greeting: greet, fits: true }
  }
  return { featured: blocks.featured ? 'small' : 'none', greeting: false, fits: false }
}
