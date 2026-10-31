import type { components } from '../api/schema'
import { asCustomer } from './service-calls'
import { request } from './staff'

// 「本次手作」页的整桌计时（docs/api.yaml 的 /venue-sessions/me）：员工从桌位开台、绑定了本人账户的那些。
// 扫码入座、到店开台的按座计时在 loyalty.me 的 admissions 里，不在这里。
// 已用、剩余、超时、状态和能不能呼叫店员都由后端按读取时刻算好，这里只挑说法，不自己判。

export type WholeTableSession = components['schemas']['MyVenueSession']

/** 顾客：本人名下进行中的整桌计时，先开的在前。报错只用白名单文案。 */
export const wholeTableSessions = () => asCustomer(() => request<WholeTableSession[]>('/venue-sessions/me'))

export const wholeTableStates: Record<WholeTableSession['displayStatus'], string> = {
  running: '计时中',
  paused: '已暂停',
  companion: '陪客',
  stopped: '计时已停止，等待结账',
}

/** 「A1 桌 · 定时 60 分钟」「A1 桌 · 自由计时」。 */
export function wholeTableTitle(session: Pick<WholeTableSession, 'tableCode' | 'timingMode' | 'durationMinutes'>) {
  const table = session.tableCode ? `${session.tableCode} 桌` : '整桌计时'
  return session.timingMode === 'free' ? `${table} · 自由计时` : `${table} · 定时 ${session.durationMinutes ?? 0} 分钟`
}
