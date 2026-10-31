import type { ServiceTable, VenueSession } from './staff'

// 工作台的「快到点 / 已超时」（docs/plan-live-board.md 第 3 节，与网页「现场」看板同一套规则）：
//
// · 快到点、已超时只认桌位接口的 timingStatus（后端按当前时间算：剩余 10 分钟以内 expiring，
//   过了结束时间 overdue），前端不按秒数自己判；自由计时没有结束时间，后端不给 timingStatus，不提醒。
// · 暂停中（时间不走）和已停止计时、保留座位等结账的不提醒：前者不会到点，后者已经在走结账了。
// · 分钟数在两次重读之间按 endsAt 倒数，向上取整（还剩 30 秒也写 1 分钟，超时至少写 1 分钟）。

export type TimingAlert = {
  table: ServiceTable
  overdue: boolean
  /** 剩余秒数，负数是已超时多久。 */
  seconds: number
  /** 「剩余 8 分钟」「已超时 5 分钟」 */
  text: string
}

/** 一张桌以哪个会话为准：和桌位接口算计时摘要的那个开始时间对得上的；对不上取第一个。 */
function primarySession(table: ServiceTable, sessions: VenueSession[]): VenueSession | undefined {
  const mine = sessions.filter((session) => session.serviceTableId === table.id)
  if (mine.length <= 1) return mine[0]
  const started = table.startedAt ? Date.parse(table.startedAt) : Number.NaN
  return mine.find((session) => Date.parse(session.startedAt) === started) || mine[0]
}

/** 快到点与已超时的桌，按剩余时间排：超时最久的在最前。 */
export function timingAlerts(tables: ServiceTable[], sessions: VenueSession[], now: number): TimingAlert[] {
  const alerts: TimingAlert[] = []
  for (const table of tables) {
    if (!table.enabled || table.occupancy !== 'occupied') continue
    if (table.timingStatus !== 'expiring' && table.timingStatus !== 'overdue') continue
    const endsAt = table.endsAt ? Date.parse(table.endsAt) : Number.NaN
    if (!Number.isFinite(endsAt)) continue
    const session = primarySession(table, sessions)
    if (session?.stoppedAt || session?.status === 'paused') continue
    const seconds = Math.floor((endsAt - now) / 1000)
    const overdue = table.timingStatus === 'overdue'
    const text = overdue
      ? `已超时 ${overdueMinutes(-seconds)} 分钟`
      : `剩余 ${Math.max(0, Math.ceil(seconds / 60))} 分钟`
    alerts.push({ table, overdue, seconds, text })
  }
  return alerts.sort((a, b) => a.seconds - b.seconds || (a.table.code || '').localeCompare(b.table.code || ''))
}

/**
 * 超时分钟：按整分钟向下取整、至少 1，和计价口径一致（不足一分钟不算；超时 10 分 30 秒写 10 分钟，
 * 计价说明也写「超时 10 分钟」——2026-10-06 业主定）。剩余分钟仍向上取整（还剩 30 秒写 1 分钟）。
 */
export function overdueMinutes(overdueSeconds: number): number {
  return Math.max(1, Math.floor(overdueSeconds / 60))
}
