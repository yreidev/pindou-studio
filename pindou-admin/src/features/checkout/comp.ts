import { z } from 'zod'
import { hasRole } from '../../account'
import type { Order } from '../../api/orders'
import type { Account } from '../../session'
import { money } from '../../lib/format'

// 免单（2026-10-06 业主定）：店长、老板把一单直接结清、不收钱，必须写原因。
// 它是一条单独的结清记录（不是 100% 折扣，人工折扣仍不能把应收减到 0）：应收照旧、实收为 0、不能退款，
// 订单、小票、导出里都标「免单」。免掉的是读到的这一版还差的数（分笔付款收了一部分的，是剩下没付的部分，「对剩余免单」），
// 后端按订单版本核对；计时费随时间变了、别人刚收了一笔都会 409，重读再确认。

/** 界面上显示免单入口：店长、老板。只为好用而隐藏，后端照样校验。 */
export function canComp(viewer: Pick<Account, 'roles'>): boolean {
  return hasRole(viewer, 'manager', 'owner')
}

export const compReasonLimit = 200

export const compFormSchema = z.object({ reason: z.string() }).superRefine((values, ctx) => {
  const reason = values.reason.trim()
  if (!reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: '请填写免单原因' })
  else if ([...reason].length > compReasonLimit)
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `原因最多 ${compReasonLimit} 字` })
})

export interface CompState {
  order: Pick<Order, 'status' | 'receivableCents' | 'outstandingCents'>
  /** 明细改过还没保存。 */
  dirty: boolean
  /** 订单已被修改，要先重新读取。 */
  conflict: boolean
}

/**
 * 这次免掉多少：还差的数（接口的 outstandingCents）。草稿就是应收；分笔付款收了一部分的，是剩下没付的部分。
 * 重放旧响应时没有 outstandingCents，草稿按应收算。
 */
export function compAmount(order: Pick<Order, 'status' | 'receivableCents' | 'outstandingCents'>): number {
  if (order.outstandingCents !== undefined) return order.outstandingCents
  return order.status === 'draft' ? order.receivableCents : 0
}

/** 免单按钮为什么点不动；能免单返回空串。 */
export function compBlocker(state: CompState): string {
  if (state.order.status !== 'draft' && state.order.status !== 'partially_paid') return '这张订单已经不是待结账状态'
  if (state.conflict) return '订单已被修改，请先重新读取并核对'
  if (state.dirty) return '明细改过，请先保存并核对金额'
  if (compAmount(state.order) < 1) return '应收是 0，不用免单：计时待填价的行请先填价，误开的台请撤销开台'
  return ''
}

/**
 * 免单前的确认：写清免掉多少、已收多少、后果（不能退免掉的部分、不能改回）和原因。
 * 分笔付款收了一部分的是「对剩余免单」：收到的钱照常记着、之后照常能按笔退。金额都照接口。
 */
export function compConfirmContent(
  order: Pick<Order, 'status' | 'receivableCents' | 'outstandingCents' | 'paidCents'>,
  reason: string,
): string {
  const amount = compAmount(order)
  if (order.status === 'partially_paid' && order.paidCents > 0)
    return `这一单应收 ${money(order.receivableCents)}，已收 ${money(order.paidCents)}；剩余 ${money(amount)} 将记为免单，直接结清：计时随之结束，免掉的部分不能退款，也不能改回收款；已收的钱照常记账、之后可以按笔退。原因：${reason.trim()}`
  return `这一单应收 ${money(amount)} 将记为免单，直接结清、实收 0：商品照常出库，计时随之结束；之后不能退款，也不能改回收款。原因：${reason.trim()}`
}
