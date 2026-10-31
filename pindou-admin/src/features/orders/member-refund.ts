import { z } from 'zod'
import type {
  MemberCheckout,
  MemberRefundBlocked,
  MemberRefundInput,
  MemberRefundPart,
  MemberRefundQuote,
  MemberRefundQuoteInput,
  Order,
  PointSpend,
} from '../../api/orders'
import { dateTime, money, parseYuan } from '../../lib/format'
import { isMemberCheckout, memberRefundableCents, paymentMethodNames } from './orders'
import { refundReasonSchema, returnedCounts, returnedSchema, type ReturnableProduct } from './refund'

// 会员结账单的退款，规则照后端 /loyalty/actions 的 refund 与 refund_quote：
// - 可以分多次退：每次填这次退的金额（元），上限是接口给的 refundableCents；「全部退完」就是退剩余全部；
// - 这次将退回、收回什么（线下、本金、赠送、恢复的积分、扣回的消费积分）由后端按原付款比例算好（refund_quote），
//   前端只展示、不推算；提交带预览依据的订单版本，订单变了回 409，保留输入、重读后由人再确认；
// - 按比例该扣回的积分已被顾客用掉时后端说明缺多少、被哪些流水用掉、现在最多能退多少，页面照原话显示；
// - 回补库存只认员工逐件点清的件数，默认 0，同一单累计不超过售出件数，与金额无关；
// - 原因必填；店长、老板办理，带幂等键。

export interface MemberRefundFormValues {
  /** 这次退的金额（元，最多两位小数）。实付为 0 的单没有这一项，只能整单退。 */
  amount: string
  reason: string
  /** 每种商品退回并可再售的件数（文字），按商品编号记；空着就是 0。 */
  returned: Record<string, string>
}

export const emptyMemberRefundForm = (): MemberRefundFormValues => ({ amount: '', reason: '', returned: {} })

/** 实付为 0（全用积分抵扣）的会员结账单没有金额可分，只能整单退回积分。 */
export function wholeOnly(order: Pick<Order, 'paidCents'>): boolean {
  return order.paidCents === 0
}

/** 金额输入 → 这次退的分；空着、格式不对、超过还可退都返回 null（表单另给提示）。 */
export function refundAmountCents(text: string, refundableCents: number): number | null {
  const cents = parseYuan(text)
  return cents !== null && cents >= 1 && cents <= refundableCents ? cents : null
}

/** 金额还不能预览时说一句为什么（没填、格式不对、超过还可退）。 */
export function memberRefundAmountHint(text: string, refundableCents: number): string {
  if (!text.trim()) return '填好金额后，这里显示这次将退回的线下、本金、赠送和积分。'
  const cents = parseYuan(text)
  if (cents === null || cents < 1) return '金额按元填写，最多两位小数。'
  return `超过本单还可退的 ${money(refundableCents)}。`
}

/** 表单校验：金额 0.01 元到还可退（实付为 0 的单不填），原因必填，件数不超过还可退回的。上限来自读到的那一版订单。 */
export function memberRefundFormSchema(limits: {
  refundableCents: number
  wholeOnly: boolean
  products: readonly ReturnableProduct[]
}) {
  return z.object({
    amount: z.string().superRefine((text, ctx) => {
      if (limits.wholeOnly) return
      const cents = parseYuan(text)
      if (cents === null || cents < 1)
        ctx.addIssue({ code: 'custom', message: '请填写这次退款的金额（元，最多两位小数）' })
      else if (cents > limits.refundableCents)
        ctx.addIssue({ code: 'custom', message: `超过本单还可退的 ${money(limits.refundableCents)}` })
    }),
    reason: refundReasonSchema,
    returned: returnedSchema(limits.products),
  })
}

/**
 * 预览要发的内容：订单、读到的版本、顾客和这次的金额。金额还不合法时返回 null（不预览）；
 * 实付为 0 的单不带金额，就是整单退。
 */
export function memberRefundQuoteInput(
  order: Pick<Order, 'id' | 'version' | 'accountId' | 'paidCents' | 'refundableCents' | 'memberCheckout'>,
  amountText: string,
): MemberRefundQuoteInput | null {
  const base = {
    ...(order.accountId ? { accountId: order.accountId } : {}),
    targetId: order.id,
    expectedVersion: order.version,
  }
  if (wholeOnly(order)) return base
  const amountCents = refundAmountCents(amountText, memberRefundableCents(order))
  return amountCents === null ? null : { ...base, amountCents }
}

/** 预览 + 校验通过的表单 → 请求体：金额与版本照预览（就是预览依据的那一版），不自行换新。 */
export function toMemberRefundInput(
  quoted: MemberRefundQuoteInput,
  quote: Pick<MemberRefundQuote, 'orderVersion'>,
  values: MemberRefundFormValues,
  products: readonly ReturnableProduct[],
): MemberRefundInput {
  const returnedProducts = returnedCounts(values.returned, products)
  return {
    ...quoted,
    expectedVersion: quote.orderVersion,
    reason: values.reason.trim(),
    ...(Object.keys(returnedProducts).length ? { returnedProducts } : {}),
  }
}

const points = (count: number) => `${count.toLocaleString('zh-CN')} 积分`

/** 详情页「会员结账」卡片：本单结账时动过的会员资产，逐项照接口的数字。 */
export function memberCheckoutRows(checkout: MemberCheckout): { key: string; value: string }[] {
  return [
    { key: '储值本金支付', value: money(checkout.principalCents) },
    { key: '赠送余额支付', value: money(checkout.giftCents) },
    { key: '积分抵扣', value: points(checkout.pointsUsed) },
    { key: '本单所得积分', value: points(checkout.pointsEarned) },
    { key: '线下补付', value: money(checkout.offlineCents) },
  ]
}

/** 详情页「已退回」：此前各次退款累计退回、收回的数，照接口的 memberCheckout.refunded。 */
export function memberRefundedRows(refunded: MemberRefundPart): { key: string; value: string }[] {
  return [
    { key: '已退线下', value: money(refunded.offlineCents) },
    { key: '已退本金', value: money(refunded.principalCents) },
    { key: '已退赠送', value: money(refunded.giftCents) },
    { key: '已恢复积分', value: points(refunded.pointsRestored) },
    { key: '已扣回消费积分', value: points(refunded.pointsClawedBack) },
  ]
}

/** 「线下 ¥x、本金 ¥y、赠送 ¥z、积分 n，扣回消费积分 m」：这次将退回什么，数字全部来自后端预览。 */
export function memberRefundSummary(part: MemberRefundPart): string {
  return `线下 ${money(part.offlineCents)}、本金 ${money(part.principalCents)}、赠送 ${money(part.giftCents)}、积分 ${part.pointsRestored.toLocaleString('zh-CN')}，扣回消费积分 ${part.pointsClawedBack.toLocaleString('zh-CN')}`
}

/**
 * 原线下付款方式（现金、微信、支付宝），线下部分按它退还。分笔付款时只看会员结账那一笔（标了 member 的），
 * 别人分笔付的不算；免单不是收到的钱。
 */
export function offlineMethods(order: Pick<Order, 'payments'>): string {
  const payments = order.payments ?? []
  const member = payments.some((payment) => payment.member)
  const names = [
    ...new Set(
      payments
        .filter((payment) => payment.method !== 'balance' && payment.method !== 'comp' && (!member || payment.member))
        .map((payment) => paymentMethodNames[payment.method]),
    ),
  ]
  return names.join('、') || '原付款方式'
}

/** 预览下面的说明，一项一句；是 0 的项不说。 */
export function memberRefundNotes(quote: MemberRefundQuote, order: Pick<Order, 'payments'>): string[] {
  const notes: string[] = []
  if (quote.offlineCents)
    notes.push(`线下的 ${money(quote.offlineCents)} 系统不退，请按原付款方式（${offlineMethods(order)}）退还顾客`)
  if (quote.principalCents || quote.giftCents) notes.push('本金、赠送按原流水各回各的余额，赠送不会退成本金')
  if (quote.pointsRestored) notes.push(`恢复的 ${points(quote.pointsRestored)}回到原批次，保留原到期时间`)
  if (quote.settlesOrder) notes.push('这次退完剩余全部，各项零头在这次结清，订单变为已退款')
  return notes
}

/**
 * 这一版订单还能不能办会员退款；能办返回 null，否则返回给人看的原因。重读后别人已经退完、订单状态变了，
 * 或者送出的积分被用掉、现在一分也退不了，侧边栏据此停在说明上，不给提交按钮。
 * 积分被用掉一部分时还能少退一些：那时不拦，由预览按这次的金额说明。
 */
export function memberRefundBlocker(
  order: Pick<Order, 'status' | 'settlement' | 'memberCheckout' | 'paidCents' | 'refundableCents'>,
): string | null {
  if (!isMemberCheckout(order) || !order.memberCheckout) return '这张订单不是会员结账，请关闭后按普通订单退款。'
  if (order.status === 'refunded') return '这张订单已经全部退完，不能再退。'
  if (order.status !== 'paid') return '只有已付款的订单可以退款。'
  // 分笔付款：会员这一笔退完了，别人付的还没退完，订单仍是已付款
  if (order.paidCents > 0 && memberRefundableCents(order) === 0)
    return '会员结账那一笔已经退完了；别人分笔付的请在付款记录里选那一笔办普通退款。'
  const blocked = order.memberCheckout.refundBlocked
  if (blocked && blocked.maxRefundableCents === 0) return blocked.reason
  return null
}

/** 订单详情上「退剩余全部收不回积分」的标题：缺多少分；还能少退时写出现在最多能退多少。 */
export function memberRefundBlockedTitle(
  blocked: Pick<MemberRefundBlocked, 'pointsShort' | 'maxRefundableCents'>,
): string {
  const short = blocked.pointsShort.toLocaleString('zh-CN')
  return blocked.maxRefundableCents > 0
    ? `退不完剩余全部：本单送出的积分已被用掉，扣回还缺 ${short} 分，现在最多能退 ${money(blocked.maxRefundableCents)}`
    : `暂时不能退：本单送出的积分已被用掉，扣回还缺 ${short} 分`
}

const spendKinds: Record<string, string> = { checkout: '会员结账抵扣', exchange: '积分兑换', adjust: '资产调整扣减' }

/** 用掉本单积分的一条流水，给人看的一句：时间、用途、分数。checkout 那张订单由页面另给链接。 */
export function pointSpendText(spend: PointSpend): string {
  return `${dateTime(spend.createdAt)} ${spendKinds[spend.kind] ?? spend.kind} 用掉 ${points(spend.points)}`
}
