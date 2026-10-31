import type { Schemas } from '../../api/client'
import type { Order } from '../../api/orders'
import { dateTime, money } from '../../lib/format'

// 计时费说明（2026-10-06 收费政策）：超时按续时方案加收几块、自由计时几块、陪客费，都由后端按发布的规则算好，
// 订单的 timing、桌位的 charge 带着一句 summary（如「超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块」）。
// 这里只把它们排成给员工看的几行话，不算任何金额。

/** 一次计时此刻怎么计价（桌位视图的 charge）。 */
export type SessionCharge = Schemas['SessionCharge']
/** 草稿订单上的计时说明：另带 applied（开头的计时明细就是系统算的这几行）。 */
export type OrderTiming = Schemas['OrderTiming']

export interface TimingNote {
  /** info：计时明细由系统按计时算、跟着走；warning：员工改过或对不上价，要人核对。 */
  type: 'info' | 'warning'
  title: string
  lines: string[]
}

/** 计时说明的标题：计时费多少，或待填价。 */
export function chargeTitle(charge: Pick<SessionCharge, 'totalCents'>): string {
  return charge.totalCents !== undefined ? `计时费 ${money(charge.totalCents)}` : '计时费待填价'
}

/** 计价会不会随时间再变：停止计时的冻结；陪客、对不上价的不随时间变；其余随时间走，收款前若跨块会提示重读。 */
export function chargeFreshness(charge: Pick<SessionCharge, 'frozenAt' | 'kind'>): string | null {
  if (charge.frozenAt) return `已停止计时（${dateTime(charge.frozenAt)}），按停止那一刻算，不再变。`
  if (charge.kind === 'companion' || charge.kind === 'unpriced') return null
  return '计时还在走：金额按读取的这一刻算；超时进了下一块、自由计时多了一块时，收款会提示重新读取。'
}

/** 结账页「订单明细」上方的计时说明；不是计时会话的草稿（没有 timing）返回 null。 */
export function timingNote(order: Pick<Order, 'timing'>): TimingNote | null {
  const timing = order.timing
  if (!timing) return null
  if (!timing.applied) {
    return {
      type: 'warning',
      title: '计时明细被改过',
      lines: [
        `这张单开头的计时明细被员工改过（或是旧版本建的单），不会再跟着计时自动改。`,
        `系统按计时算：${timing.summary}${timing.totalCents !== undefined ? `，计时费 ${money(timing.totalCents)}` : ''}。请核对明细里的计时费。`,
      ],
    }
  }
  if (timing.kind === 'unpriced') {
    return { type: 'warning', title: chargeTitle(timing), lines: [`${timing.summary}。`] }
  }
  const freshness = chargeFreshness(timing)
  return {
    type: 'info',
    title: `${chargeTitle(timing)}（系统按计时算）`,
    lines: [`${timing.summary}。`, ...(freshness ? [freshness] : [])],
  }
}
