import { z } from 'zod'
import { ApiError } from '../../api/client'
import type { Order, RefundInput } from '../../api/orders'
import { dateTime, money, parseYuan } from '../../lib/format'
import { lineName, paymentMethodNames, type RefundablePayment } from './orders'

// 退款表单的规则，语义照搬小程序订单页：
// - 按笔退（分笔付款、多人合付）：先选退哪一笔付款，退款金额由员工填写，上限是接口给的这一笔的 refundableCents
//   （这笔金额减已退），前端不自行加减；会员结账那一笔走会员退款，免单那一笔不能退；
// - 回补库存只认员工逐件点清的件数，默认 0：退服务费、拆封后不能再卖的材料都不回补，
//   金额退了不等于货回了；
// - 每种商品最多还能退回「本单卖出数 − 此前各次退款已退回数」件，超了直接拦下，不悄悄改小。

export interface ReturnableProduct {
  productId: string
  name: string
  /** 本单卖出的件数（同一商品分几行时合计）。 */
  sold: number
  /** 此前各次退款已经退回的件数。 */
  returned: number
  /** 这次最多还能退回的件数。 */
  remaining: number
}

/** 本单还能退回库存的商品；服务费等不关联商品的明细不在其中，已全部退回的也不列。 */
export function returnableProducts(order: Pick<Order, 'lines' | 'refunds'>): ReturnableProduct[] {
  const products = new Map<string, ReturnableProduct>()
  for (const line of order.lines ?? []) {
    if (!line.productId) continue
    const found = products.get(line.productId)
    if (found) found.sold += line.quantity
    else
      products.set(line.productId, {
        productId: line.productId,
        name: lineName(line),
        sold: line.quantity,
        returned: 0,
        remaining: 0,
      })
  }
  for (const refund of order.refunds ?? []) {
    for (const [productId, count] of Object.entries(refund.returnedProducts ?? {})) {
      const found = products.get(productId)
      if (found) found.returned += count
    }
  }
  return [...products.values()]
    .map((product) => ({ ...product, remaining: Math.max(0, product.sold - product.returned) }))
    .filter((product) => product.remaining > 0)
}

export interface RefundFormValues {
  /** 退款金额，单位元，最多两位小数。 */
  amount: string
  reason: string
  /** 每种商品这次退回的件数（文字），按商品编号记；空着就是 0。 */
  returned: Record<string, string>
}

export const emptyRefundForm = (): RefundFormValues => ({ amount: '', reason: '', returned: {} })

const countPattern = /^\d{1,9}$/

/** 退款原因按字符数算（和后端一致，一个表情算一个字）。原因输入框的字数统计也用它（TextArea 的 getValueLength）。 */
export const reasonLength = (text: string) => [...text].length

/** 退款原因：必填（去掉空格后），最多 200 字。普通退款和会员退款共用。 */
export const refundReasonSchema = z.string().superRefine((text, ctx) => {
  const value = text.trim()
  if (!value) ctx.addIssue({ code: 'custom', message: '请填写退款原因' })
  else if (reasonLength(value) > 200) ctx.addIssue({ code: 'custom', message: '退款原因最多 200 字' })
})

/** 退回件数：空着算 0；须为整数，不超过还可退回的件数，超了直接拦下，不悄悄改小。 */
export function returnedSchema(products: readonly ReturnableProduct[]) {
  return z.record(z.string(), z.string()).superRefine((counts, ctx) => {
    for (const product of products) {
      const text = (counts[product.productId] ?? '').trim()
      if (!text) continue
      if (!countPattern.test(text)) ctx.addIssue({ code: 'custom', path: [product.productId], message: '件数须为整数' })
      else if (Number(text) > product.remaining)
        ctx.addIssue({ code: 'custom', path: [product.productId], message: `最多可退回 ${product.remaining} 件` })
    }
  })
}

/**
 * 表单校验。上限来自读到的那一版订单：可退金额用接口给的这一笔的 refundableCents（分笔付款按笔退），
 * 可退件数用 returnableProducts 算出的 remaining。
 */
export function refundFormSchema(limits: { refundableCents: number; products: readonly ReturnableProduct[] }) {
  return z.object({
    amount: z.string().superRefine((text, ctx) => {
      const cents = parseYuan(text)
      if (cents === null || cents < 1) ctx.addIssue({ code: 'custom', message: '请填写退款金额（元，最多两位小数）' })
      else if (cents > limits.refundableCents)
        ctx.addIssue({ code: 'custom', message: `超过这一笔还可退的 ${money(limits.refundableCents)}` })
    }),
    reason: refundReasonSchema,
    returned: returnedSchema(limits.products),
  })
}

/** 已填写且合法的退回件数（大于 0 的才算），按钮文字和确认弹窗用。 */
export function returnedCounts(
  returned: Record<string, string>,
  products: readonly ReturnableProduct[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const product of products) {
    const text = (returned[product.productId] ?? '').trim()
    if (!countPattern.test(text)) continue
    const count = Number(text)
    if (count > 0 && count <= product.remaining) counts[product.productId] = count
  }
  return counts
}

export function returnedTotal(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/**
 * 校验通过的表单 → 接口请求体（不含 expectedVersion，由页面带上读到的那一版）。paymentId 是员工选的那一笔付款，
 * 分几笔收的单必须带；一笔收齐的单带上也一样（后端认得）。
 */
export function toRefundInput(
  values: RefundFormValues,
  products: readonly ReturnableProduct[],
  paymentId?: string,
): Omit<RefundInput, 'expectedVersion'> {
  const amountCents = parseYuan(values.amount)
  if (amountCents === null) throw new Error('退款金额无效')
  const returnedProducts = returnedCounts(values.returned, products)
  return {
    ...(paymentId ? { paymentId } : {}),
    amountCents,
    reason: values.reason.trim(),
    ...(Object.keys(returnedProducts).length ? { returnedProducts } : {}),
  }
}

/**
 * 退款侧边栏一打开选中哪一笔：页面指定的那笔（付款记录里点的「退这笔」）还能退就用它；
 * 只有一笔能退时就是它；分几笔都能退时让员工自己选，不替他挑。
 */
export function initialRefundPayment(choices: readonly RefundablePayment[], preferred?: string): string | undefined {
  if (preferred && choices.some((choice) => choice.payment.id === preferred)) return preferred
  return choices.length === 1 ? choices[0].payment.id : undefined
}

/** 退款侧边栏里一笔付款的说明：方式、金额、时间，已退多少、还可退多少（数字照接口）。 */
export function refundChoiceText(choice: RefundablePayment): { title: string; extra: string } {
  const { payment } = choice
  const refunded = payment.refundedCents ?? 0
  return {
    title: `${paymentMethodNames[payment.method] ?? payment.method} ${money(payment.amountCents)}`,
    extra: `${dateTime(payment.createdAt)}${refunded ? ` · 已退 ${money(refunded)}` : ''} · 还可退 ${money(choice.refundableCents)}`,
  }
}

/** 确认弹窗与按钮上的回补说明。 */
export function restockText(counts: Record<string, number>, products: readonly ReturnableProduct[]): string {
  const parts = products
    .filter((product) => counts[product.productId] > 0)
    .map((product) => `${product.name} ${counts[product.productId]} 件`)
  return parts.length ? `回补库存：${parts.join('、')}` : '不回补库存（退服务费，或货没退回、不能再卖）'
}

/** 订单在你填写期间被别人改过：版本冲突，或幂等键对应的内容变了。都要重读后让人再确认。 */
export function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'order_version_conflict' || error.code === 'idempotency_conflict')
  )
}

/**
 * 退款失败时给员工看的话。后端的中文说明原样显示；几个契约类错误码的英文说明换成能照着做的中文。
 * 网络断了或服务端出错时结果未知：同样内容再提交会沿用同一个幂等键，不会重复退款。
 */
export function refundErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '操作失败，请重试'
  if (isVersionConflict(error))
    return '订单已被修改，你填写的内容已保留。请重新读取，核对最新的可退金额和件数后再确认。'
  if (error.code === 'forbidden') return '当前账号无权办理退款，需要店长或老板。'
  if (error.status === 0 || error.status >= 500)
    return `${error.message.replace(/[。.]$/, '')}。不确定是否已退时，可以原样再提交一次（同一笔不会重复退款），或重新读取订单核对。`
  return error.message
}
