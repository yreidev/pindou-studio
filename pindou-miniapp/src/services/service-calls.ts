import type { components } from '../api/schema'
import { CustomerError, messageForCode } from './customer'
import { request, StaffError } from './staff'

// 呼叫店员（docs/api.yaml 的 service-calls）。顾客在「本次手作」页叫，员工在工作台看到，可以先点「我去处理」认领
// （别的员工那里显示「XX 正在处理」、不再振动），去了之后点「已处理」。
// 状态只以接口为准：叫没叫过、谁认领着、认领失没失效、处理没处理、过没过期、还要等几秒都由后端算好，
// 这里只在两次刷新之间倒数显示。

/**
 * 一次呼叫。员工视图多带 customer（顾客称呼）、handledBy（处理人称呼）、claimedBy（认领人称呼）；
 * 顾客视图不带任何员工称呼，只看 claimStatus（有人认领着就写「店员正在过来」）。
 */
export type ServiceCall = components['schemas']['ServiceCall']

/** 顾客侧的请求：错误一律转成 CustomerError，文案只走 messageForCode 白名单，不把服务端原文给顾客。 */
export async function asCustomer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof StaffError) throw new CustomerError(e.code, messageForCode(e.code, e.status), e.status)
    throw e
  }
}

export const serviceCalls = {
  /** 顾客：本人每个进行中会话最近的一条呼叫（没叫过的会话不在里面）。 */
  mine: () => asCustomer(() => request<ServiceCall[]>('/service-calls/me')),
  /**
   * 顾客：为这次计时呼叫店员。已有没处理的呼叫时后端原样返回那一条，重复点、网络重发都无害，所以不带幂等键。
   * 店员刚处理过 1 分钟内会被拒（service_call_cooldown）。
   */
  call: (venueSessionId: string) =>
    asCustomer(() => request<ServiceCall>('/service-calls', 'POST', { venueSessionId })),
  /** 员工：还没处理的呼叫（没处理、没过期、顾客还在），先叫的在前。 */
  open: () => request<ServiceCall[]>('/service-calls?scope=open'),
  /** 员工：标记已处理。已被别人处理过的原样返回，处理人不变。 */
  handle: (id: string) => request<ServiceCall>(`/service-calls/${encodeURIComponent(id)}/handle`, 'POST'),
  /**
   * 员工：「我去处理」。谁先认领算谁：别人认领着时被拒（service_call_claimed，说明里写「XX 已在处理」）；
   * 自己再点原样返回，重复点、重发都无害，所以不带幂等键。
   */
  claim: (id: string) => request<ServiceCall>(`/service-calls/${encodeURIComponent(id)}/claim`, 'POST'),
}

/** 员工称呼：昵称，没有时用打码手机号；账户不在了写 fallback。 */
const staffName = (label: ServiceCall['claimedBy'], fallback: string) =>
  label?.nickname || label?.phoneMasked || fallback

/**
 * 工作台上这条呼叫的认领情况（只看后端算好的 claimStatus）：
 * - 认领着：「阿贝 正在处理 · 2 分钟前」（自己认领的写「你正在处理」），不再为它振动；
 * - 认领满 10 分钟还没处理：「阿贝 12 分钟前说去处理，还没处理」，重新振动，谁都能再认领；
 * - 没人认领：null。
 */
export function claimNote(call: ServiceCall, now: number, me?: string): string | null {
  if (!call.claimedAt || (call.claimStatus !== 'claimed' && call.claimStatus !== 'lapsed')) return null
  // 自己认领的写「你正在处理」（me 是当前登录员工的账户编号）
  const mine = !!me && call.claimedBy?.id === me
  const who = mine ? '你' : staffName(call.claimedBy, '其他店员')
  if (call.claimStatus === 'claimed')
    return mine ? `你正在处理 · ${waited(call.claimedAt, now)}` : `${who} 正在处理 · ${waited(call.claimedAt, now)}`
  return `${who} ${waited(call.claimedAt, now)}说去处理，还没处理`
}

/**
 * 这条呼叫要不要提醒员工：有人点了「我去处理」、认领着的不再振动、响铃；认领满 10 分钟没处理的（lapsed）重新提醒。
 * 旧版后端不带 claimStatus：照旧提醒。
 */
export const needsAlert = (call: ServiceCall) => call.claimStatus !== 'claimed'

/**
 * 提醒用的键：认领失效后重新提醒算一次「新到」，所以换一个键（带上那次认领的时间）；再认领、再失效又是新的一次。
 * 没人认领过的就是呼叫编号。
 */
export const alertKey = (call: ServiceCall) =>
  call.claimStatus === 'lapsed' && call.claimedAt ? `${call.id}@${call.claimedAt}` : call.id

/** 这次读到的、要提醒的呼叫的键：下次重读时据此认出新到的。认领着的不在里面。 */
export const alertKeys = (calls: readonly ServiceCall[]): Set<string> => new Set(calls.filter(needsAlert).map(alertKey))

/** 「B3 桌」：员工按布局编码找桌。 */
export const callTable = (call: Pick<ServiceCall, 'tableCode'>) =>
  call.tableCode ? `${call.tableCode} 桌` : '桌位待核对'

/** 叫了多久：不到 1 分钟是「刚刚」，否则「N 分钟前」。手机时钟慢一点也不显示负数。 */
export function waited(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60000)
  return !Number.isFinite(minutes) || minutes < 1 ? '刚刚' : `${minutes} 分钟前`
}

/**
 * 顾客页上这次计时的呼叫状态：
 * - idle：没叫过，或上次的已处理且过了冷却——可以叫；
 * - waiting：已呼叫，店员还没处理——显示「店员马上就到」和等了多久；有店员点了「我去处理」时 coming 为 true，
 *   显示「店员正在过来」（不说是哪位；认领满 10 分钟还没处理就变回「马上就到」）；
 * - cooldown：店员刚处理过，还要等 seconds 秒才能再叫；
 * - expired：叫了 30 分钟没人处理（后端按时间算）——可以再叫。
 * cooldownSeconds 是读取那一刻的剩余秒数，fetchedAt 是读到的时间，两次刷新之间据此倒数，不看手机时钟算冷却。
 */
export type CallState =
  | { kind: 'idle'; handled: boolean }
  | { kind: 'waiting'; since: string; coming: boolean }
  | { kind: 'cooldown'; seconds: number }
  | { kind: 'expired' }

export function callState(call: ServiceCall | undefined, fetchedAt: number, now: number): CallState {
  if (!call) return { kind: 'idle', handled: false }
  if (call.displayStatus === 'pending')
    return { kind: 'waiting', since: call.createdAt, coming: call.claimStatus === 'claimed' }
  if (call.displayStatus === 'expired') return { kind: 'expired' }
  const seconds = call.cooldownSeconds - Math.floor(Math.max(0, now - fetchedAt) / 1000)
  return seconds > 0 ? { kind: 'cooldown', seconds } : { kind: 'idle', handled: true }
}

/**
 * 这次读到的呼叫里新到的、要提醒的：上次没见过的新呼叫，以及认领满 10 分钟还没处理、重新提醒的（键换了）。
 * 认领着的不算。seen 是上次的 alertKeys，为 null 表示第一次读：打开页面时已经挂着的不算新到。
 */
export function arrivals(seen: ReadonlySet<string> | null, calls: readonly ServiceCall[]): ServiceCall[] {
  return seen === null ? [] : calls.filter((call) => needsAlert(call) && !seen.has(alertKey(call)))
}

/** 工作台新呼叫的振动：每 4 秒振一次（和网页后台的响铃同一个节奏），最长 5 分钟。 */
export const buzzEveryMs = 4000
export const buzzForMs = 5 * 60_000

/**
 * 正在振的呼叫：since 是最近一条新呼叫到达的时间（再来新的就从它重新计时），ids 是引起振动、还要提醒的那些
 * （alertKey：认领失效后重新提醒的带着认领时间）。
 */
export type Buzz = { since: number; ids: ReadonlySet<string> }

/**
 * 读到未处理呼叫后的振动状态：有新到的就开始（或重新计时）并记下它们；引起振动的呼叫都不用再提醒了
 * （有人点了「我去处理」——在哪台手机、网页上点的都算，包括自己；网页或别的手机上点了已处理、过期、顾客结账走了）就停。
 * 只有新到的才会开始振，打开时已经挂着的不振；认领满 10 分钟还没处理的算新到，重新振。
 */
export function buzzAfterRead(
  buzz: Buzz | null,
  fresh: readonly ServiceCall[],
  open: readonly ServiceCall[],
  now: number,
): Buzz | null {
  const still = alertKeys(open)
  const ids = new Set([...(buzz?.ids ?? [])].filter((id) => still.has(id)))
  for (const call of fresh) ids.add(alertKey(call))
  if (ids.size === 0) return null
  return { since: fresh.length > 0 || !buzz ? now : buzz.since, ids }
}

/**
 * 这一刻怎么办：stop 不振了（没有在振的，或振满 5 分钟）；buzz 振一下（离上次振够 4 秒）；wait 还没到下一次。
 * 按真实流逝的时间算：锁屏、切走期间错过的几次不补，回来超过 5 分钟也不再振。
 */
export function buzzDue(buzz: Buzz | null, lastAt: number, now: number): 'stop' | 'buzz' | 'wait' {
  if (!buzz || now - buzz.since >= buzzForMs) return 'stop'
  return now - lastAt >= buzzEveryMs ? 'buzz' : 'wait'
}
