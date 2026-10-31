import type { components } from '../api/schema'
import { dateTime, money } from './format'

// 计时费说明与免单（2026-10-06 收费政策），规则同网页结账页（pindou-admin/src/features/checkout/timing.ts、comp.ts）。
// 超时按续时方案加收几块、自由计时几块、陪客费都由后端按发布的规则算好，订单的 timing、桌位的 charge 带着一句 summary，
// 这里只把它排成给员工看的几行话，不算任何金额。

type Schemas = components['schemas']
/** 一次计时此刻怎么计价（桌位接口的 charge）。 */
export type SessionCharge = Schemas['SessionCharge']
/** 草稿订单上的计时说明：另带 applied（开头的计时明细就是系统算的这几行）。 */
export type OrderTiming = Schemas['OrderTiming']

export interface TimingNote {
  /** 员工改过计时行、或对不上已发布的价：要人核对。 */
  warning: boolean
  title: string
  lines: string[]
}

/** 计价会不会随时间再变：停止计时的冻结；陪客、对不上价的不随时间变；其余随时间走，收款前若跨块会提示重读。 */
export function chargeFreshness(charge: Pick<SessionCharge, 'frozenAt' | 'kind'>): string {
  if (charge.frozenAt) return `已停止计时（${dateTime(charge.frozenAt)}），按停止那一刻算，不再变。`
  if (charge.kind === 'companion' || charge.kind === 'unpriced') return ''
  return '计时还在走：金额按读取的这一刻算；超时进了下一块、自由计时多了一块时，收款会提示重新读取。'
}

/** 结账页「订单明细」上的计时说明；不是计时会话的草稿（没有 timing）返回 null。 */
export function timingNote(timing: OrderTiming | undefined): TimingNote | null {
  if (!timing) return null
  const total = timing.totalCents === undefined ? '' : `，计时费 ¥${money(timing.totalCents)}`
  if (!timing.applied)
    return {
      warning: true,
      title: '计时明细被改过',
      lines: [
        '这张单开头的计时明细被员工改过（或是旧版本建的单），不会再跟着计时自动改。',
        `系统按计时算：${timing.summary}${total}。请核对明细里的计时费。`,
      ],
    }
  if (timing.kind === 'unpriced') return { warning: true, title: '计时费待填价', lines: [`${timing.summary}。`] }
  const freshness = chargeFreshness(timing)
  return {
    warning: false,
    title: timing.totalCents === undefined ? '计时费待填价' : `计时费 ¥${money(timing.totalCents)}（系统按计时算）`,
    lines: [`${timing.summary}。`, ...(freshness ? [freshness] : [])],
  }
}

export const compReasonLimit = 200

/** 免单原因：必填，最多 200 字（按字符数，和后端一致）。没问题返回空串。 */
export function compReasonError(reason: string): string {
  const text = reason.trim()
  if (!text) return '请填写免单原因'
  if ([...text].length > compReasonLimit) return `原因最多 ${compReasonLimit} 字`
  return ''
}

/** 免单按钮为什么点不动；能免单返回空串。待结账整单免单，部分付款（分笔付款收了一部分）对剩余免单。 */
export function compBlocker(state: {
  order: { status: string; receivableCents: number; outstandingCents?: number }
  dirty: boolean
  conflict: boolean
}): string {
  if (state.order.status !== 'draft' && state.order.status !== 'partially_paid') return '这张订单已经不是待结账状态'
  if (state.conflict) return '订单已被修改，请先重新读取订单并核对'
  if (state.dirty) return '明细改过，请先保存并核对金额'
  if ((state.order.outstandingCents ?? state.order.receivableCents) < 1)
    return '应收是 0，不用免单：计时待填价的行请先填价，误开的台请撤销开台'
  return ''
}

/**
 * 免单前的确认：写清免掉多少、后果和原因。compCents 是要免掉的（接口给的还差的数）；paidCents 是已经收了的：
 * 收过钱的是「对剩余免单」，写清已收多少、剩下多少记免单，已收的照常可退。
 */
export function compConfirmContent(compCents: number, reason: string, paidCents = 0): string {
  if (paidCents > 0)
    return `已收 ¥${money(paidCents)}，剩余 ¥${money(compCents)} 将记为免单，直接结清：免掉的部分不能退款，也不能改回收款；已收的钱照常可以退。原因：${reason.trim()}`
  return `这一单应收 ¥${money(compCents)} 将记为免单，直接结清、实收 0：商品照常出库，计时随之结束；之后不能退款，也不能改回收款。原因：${reason.trim()}`
}

export type PaymentRecord = Schemas['Payment']
const methodNames: Record<PaymentRecord['method'], string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  balance: '储值余额',
  comp: '免单',
}

/**
 * 结账页「已收」里的一笔：方式（会员结账那几条标出来）、金额、时间，现金填了实收的写实收与找零，免单写原因。
 * 都是付款记录上后端记下的数。
 */
export function paymentLine(payment: PaymentRecord): { title: string; amount: string; detail: string } {
  const name = methodNames[payment.method] ?? payment.method
  const extra =
    payment.cashReceivedCents !== undefined && payment.changeCents !== undefined
      ? ` · 实收 ¥${money(payment.cashReceivedCents)} · 找零 ¥${money(payment.changeCents)}`
      : payment.method === 'comp' && payment.reason
        ? ` · ${payment.reason}`
        : ''
  return {
    title: payment.member ? `会员结账 · ${name}` : name,
    amount: `¥${money(payment.amountCents)}`,
    detail: `${dateTime(payment.createdAt)}${extra}`,
  }
}
