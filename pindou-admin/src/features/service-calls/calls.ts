import type { ServiceCall } from '../../api/service-calls'

/** 「B3 桌 · 2 号座」：店员按布局编码找桌。整桌开台的旧会话没有座号（0），只写桌。 */
export function callPlace(call: Pick<ServiceCall, 'tableCode' | 'seatNumber'>): string {
  const table = call.tableCode ? `${call.tableCode} 桌` : '桌位待核对'
  return call.seatNumber > 0 ? `${table} · ${call.seatNumber} 号座` : table
}

/** 叫的顾客：昵称，没有昵称时用打码手机号；账户不在了写「顾客」。 */
export function callerName(call: Pick<ServiceCall, 'customer'>): string {
  return call.customer?.nickname || call.customer?.phoneMasked || '顾客'
}

/** 「刚刚」「3 分钟前」：叫了多久。不到 1 分钟算刚刚；电脑时钟比服务器快一点时也不显示负数。 */
export function waitedLabel(createdAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(createdAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚'
  return `${minutes} 分钟前`
}

/**
 * 这条呼叫的认领情况（只看后端算好的 claimStatus），没人认领为 null：
 * - claimed：「阿贝 正在处理 · 2 分钟前」，不再为它响铃；是自己认领的写「你正在处理 · 2 分钟前」；
 * - lapsed：认领满 10 分钟还没处理，「阿贝 12 分钟前说去处理，还没处理」，重新提醒、谁都能再认领。
 * me 是当前登录员工的账户编号，用来认出自己。
 */
export function claimNote(
  call: Pick<ServiceCall, 'claimStatus' | 'claimedAt' | 'claimedBy'>,
  now: number,
  me?: string,
): { text: string; claimed: boolean } | null {
  if (!call.claimedAt || (call.claimStatus !== 'claimed' && call.claimStatus !== 'lapsed')) return null
  const mine = !!me && call.claimedBy?.id === me
  const who = mine ? '你' : call.claimedBy?.nickname || call.claimedBy?.phoneMasked || '其他店员'
  const when = waitedLabel(call.claimedAt, now)
  if (call.claimStatus === 'claimed')
    return { text: mine ? `你正在处理 · ${when}` : `${who} 正在处理 · ${when}`, claimed: true }
  return { text: `${who} ${when}说去处理，还没处理`, claimed: false }
}

/**
 * 这条呼叫要不要提醒：有人点了「我去处理」、认领着的不再响铃、不再弹提示（哪一端点的都算，包括自己）；
 * 认领满 10 分钟没处理的（lapsed）重新提醒。旧版后端不带 claimStatus：照旧提醒。
 */
export const needsAlert = (call: Pick<ServiceCall, 'claimStatus'>): boolean => call.claimStatus !== 'claimed'

/**
 * 提醒用的键：认领失效后重新提醒算一次「新到」，所以换一个键（带上那次认领的时间）；再认领、再失效又是新的一次。
 * 没人认领过的就是呼叫编号。
 */
export function alertKey(call: Pick<ServiceCall, 'id' | 'claimStatus' | 'claimedAt'>): string {
  return call.claimStatus === 'lapsed' && call.claimedAt ? `${call.id}@${call.claimedAt}` : call.id
}

/** 这次读到的、要提醒的呼叫，按提醒键。认领着的不在里面。 */
export function alerting(calls: readonly ServiceCall[]): Map<string, ServiceCall> {
  return new Map(calls.filter(needsAlert).map((call) => [alertKey(call), call]))
}

/**
 * 这次读到的呼叫里新到的、要提醒的：上次没见过的新呼叫，以及认领满 10 分钟还没处理、重新提醒的（键换了）。
 * 认领着的不算。seen 是上次要提醒的键，为 null 表示第一次读：打开页面时已经挂着的不算新到，不响。
 */
export function arrivals(seen: ReadonlySet<string> | null, calls: readonly ServiceCall[]): ServiceCall[] {
  if (seen === null) return []
  return calls.filter((call) => needsAlert(call) && !seen.has(alertKey(call)))
}
