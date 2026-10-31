import { z } from 'zod'
import type { Order, Payment } from '../../api/orders'
import { dateTime, money } from '../../lib/format'
import {
  basisPointsPercent,
  hasComp,
  isPartiallyRefunded,
  lineName,
  orderNumber,
  paymentLabel,
  paymentMethodNames,
  paymentNumbers,
} from '../orders/orders'
import { brandLine } from '../table-codes/codes'

// 小票：已付款（含退过款）的订单，浏览器打印，适配 58mm／80mm 小票纸和 A4。
// 只整理接口给的数字和文字：应收、实收、付款、折扣、会员资产变动都原样照订单接口（含 memberCheckout），
// 不在前端相乘、加总或推算。顾客只印称呼，不印手机号和微信标识。
// 现金收款填了实收的，付款下面印「实收现金」「找零」（付款记录上的 cashReceivedCents、changeCents，后端算好记下的）；
// 会员结账单印「本单结账后余额」（memberCheckout.balanceAfter，由会员流水推出的结账那一刻的余额，事后重印也不变）。

export type Paper = '58' | '80' | 'a4'

export const papers: { value: Paper; label: string }[] = [
  { value: '58', label: '58mm 小票' },
  { value: '80', label: '80mm 小票' },
  { value: 'a4', label: 'A4' },
]

export const defaultPaper: Paper = '80'

const paperSchema = z.enum(['58', '80', 'a4'])

/** 网址里的纸宽（?paper=58）：不认识的当没填。 */
export function parseReceiptSearch(raw: Record<string, unknown>): { paper?: Paper } {
  const parsed = paperSchema.safeParse(typeof raw.paper === 'number' ? String(raw.paper) : raw.paper)
  return parsed.success ? { paper: parsed.data } : {}
}

const paperKey = 'pindou-admin.receipt-paper'

/** 这台电脑上次选的纸宽（只是本机的便利，读不到就用默认）。 */
export function rememberedPaper(): Paper {
  try {
    const parsed = paperSchema.safeParse(window.localStorage.getItem(paperKey))
    return parsed.success ? parsed.data : defaultPaper
  } catch {
    return defaultPaper
  }
}

export function rememberPaper(paper: Paper): void {
  try {
    window.localStorage.setItem(paperKey, paper)
  } catch {
    // 隐私模式等存不进去：下次再选一次
  }
}

/** 能打印小票：收过款的订单（已付款、部分或全部退款）。待结账、已撤销的不能。 */
export function canPrintReceipt(order: Pick<Order, 'status'>): boolean {
  return order.status === 'paid' || order.status === 'refunded'
}

export interface ReceiptRow {
  label: string
  value: string
}

export interface ReceiptLine {
  name: string
  /** 「¥20.00 ×2」：单价与数量，原样照明细（不在前端相乘）。 */
  detail: string
}

export interface Receipt {
  store: string
  number: string
  status: string
  /** 收款时间（最后一笔付款）；没有付款记录时（全部用积分抵扣）用下单时间。门店时区。 */
  time: ReceiptRow
  customer?: string
  lines: ReceiptLine[]
  discounts: ReceiptRow[]
  receivable: string
  payments: ReceiptRow[]
  paid: string
  refunds: ReceiptRow[]
  /** 会员结账时本单动过的会员资产（来自 memberCheckout），是 0 的项不印。 */
  member: ReceiptRow[]
  /** 会员结账单：本单结账后的余额与可用积分（memberCheckout.balanceAfter）；接口没给时为空，不印。 */
  balanceAfter: ReceiptRow[]
}

const pointsText = (sign: '+' | '-', count: number) => `${sign}${count.toLocaleString('zh-CN')} 积分`

/** 订单 → 小票上的内容。 */
export function receiptOf(order: Order, store: string = brandLine): Receipt {
  const payments = order.payments ?? []
  const lastPayment = payments.reduce<string | undefined>(
    (latest, payment) => (!latest || Date.parse(payment.createdAt) > Date.parse(latest) ? payment.createdAt : latest),
    undefined,
  )
  const checkout = order.memberCheckout
  const member: ReceiptRow[] = []
  if (order.settlement === 'member' && checkout) {
    if (checkout.principalCents) member.push({ label: '储值本金支付', value: `-${money(checkout.principalCents)}` })
    if (checkout.giftCents) member.push({ label: '赠送余额支付', value: `-${money(checkout.giftCents)}` })
    if (checkout.pointsUsed) member.push({ label: '积分抵扣', value: pointsText('-', checkout.pointsUsed) })
    if (checkout.pointsEarned) member.push({ label: '本单获得积分', value: pointsText('+', checkout.pointsEarned) })
  }
  return {
    store,
    number: orderNumber(order),
    status:
      order.settlement === 'comp'
        ? '免单'
        : order.status === 'refunded'
          ? '已退款'
          : isPartiallyRefunded(order)
            ? '部分退款'
            : hasComp(order)
              ? '已付款（剩余免单）'
              : '已付款',
    time: lastPayment
      ? { label: '收款时间', value: dateTime(lastPayment) }
      : { label: '下单时间', value: dateTime(order.createdAt) },
    // 只印称呼：手机号即使打了码也不印在给顾客的纸上
    customer: order.accountId ? order.customer?.nickname || '会员顾客' : undefined,
    lines: (order.lines ?? []).map((line) => ({
      name: lineName(line),
      detail: `${money(line.unitPriceCents)} ×${line.quantity}`,
    })),
    discounts: (order.discounts ?? []).map((discount) => ({
      label: discount.reason,
      value:
        discount.kind === 'fixed'
          ? `-${money(discount.amountCents ?? 0)}`
          : `减 ${basisPointsPercent(discount.rateBasisPoints ?? 0)}`,
    })),
    receivable: money(order.receivableCents),
    // 分笔付款逐笔印「第 n 笔 方式」，一笔收齐的照旧只印方式
    payments: payments.flatMap((payment) => [
      { label: receiptPaymentLabel(payment, order), value: money(payment.amountCents) },
      // 免单：免掉的金额之后印原因（不是收到的钱，实收照旧是 0）
      ...(payment.method === 'comp' && payment.reason ? [{ label: '免单原因', value: payment.reason }] : []),
      // 现金填了实收的：顾客给了多少、找了多少，照付款记录印（两个数总是一起给）
      ...(payment.cashReceivedCents !== undefined && payment.changeCents !== undefined
        ? [
            { label: '实收现金', value: money(payment.cashReceivedCents) },
            { label: '找零', value: money(payment.changeCents) },
          ]
        : []),
    ]),
    paid: money(order.paidCents),
    refunds: (order.refunds ?? []).map((refund) => ({
      label: `退款 ${dateTime(refund.createdAt)}`,
      value: `-${money(refund.amountCents)}`,
    })),
    member,
    balanceAfter: order.settlement === 'member' && checkout?.balanceAfter ? balanceRows(checkout.balanceAfter) : [],
  }
}

/** 小票上一笔付款的名字：免单写免单；分几笔收的写「第 n 笔 方式」（会员结账那一笔分开写明），一笔收齐的只写方式。 */
function receiptPaymentLabel(payment: Payment, order: Pick<Order, 'payments' | 'settlement'>): string {
  if (payment.method === 'comp') return paymentMethodNames.comp
  const n = paymentNumbers(order).get(payment.id)
  return n ? `第 ${n} 笔 ${paymentLabel(payment, order)}` : paymentLabel(payment, order)
}

/** 本单结账后的余额（接口由会员流水推出的结账那一刻的数，不是打印时的余额），小票上和本单变动分开印。 */
export function balanceRows(balance: { principalCents: number; giftCents: number; points: number }): ReceiptRow[] {
  return [
    { label: '储值本金', value: money(balance.principalCents) },
    { label: '赠送余额', value: money(balance.giftCents) },
    { label: '可用积分', value: `${balance.points.toLocaleString('zh-CN')} 积分` },
  ]
}

/** 结账页、订单详情的描述列表里接在本单变动后面的「结账后…」几行（同小票上的本单结账后余额）；接口没给时为空。 */
export function balanceAfterItems(
  checkout: { balanceAfter?: { principalCents: number; giftCents: number; points: number } } | undefined,
): { key: string; value: string }[] {
  return checkout?.balanceAfter
    ? balanceRows(checkout.balanceAfter).map((row) => ({ key: `结账后${row.label}`, value: row.value }))
    : []
}
