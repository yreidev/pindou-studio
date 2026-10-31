import { z } from 'zod'
import { hasRole } from '../../account'
import type { Order, OrderDiscount, OrderLine, OrderStatus, Payment, PaymentMethod, Refund } from '../../api/orders'
import type { Account } from '../../session'
import { money } from '../../lib/format'

// 订单列表与详情的展示规则。这里只做筛选、排序、分页和文字，不算任何金额——
// 应收、已付、已退、可退都以接口返回为准。

export const statusNames: Record<OrderStatus, string> = {
  draft: '待结账',
  // 分笔付款收了一部分、还没收齐：计价已冻结，只能接着收下一笔或对剩余免单（2026-10-06 业主定，多人合付）
  partially_paid: '部分付款',
  paid: '已付款',
  refunded: '已退款',
  voided: '已撤销',
}

export const statusColors = {
  draft: 'blue',
  partially_paid: 'cyan',
  paid: 'green',
  refunded: 'orange',
  voided: 'grey',
} as const

export const orderStatuses = Object.keys(statusNames) as OrderStatus[]

/** 列表的状态筛选：open 是「待结账」，草稿和部分付款（还没收齐）的都在内，服务端按 status=open 筛。 */
export type OrderStatusFilter = Exclude<OrderStatus, 'draft'> | 'open'

export const statusFilters: { value: OrderStatusFilter; label: string }[] = [
  { value: 'open', label: '待结账' },
  { value: 'partially_paid', label: '部分付款' },
  { value: 'paid', label: '已付款' },
  { value: 'refunded', label: '已退款' },
  { value: 'voided', label: '已撤销' },
]

/** 还没收齐的单：待结账（草稿）或部分付款，都要去结账页接着收。 */
export function isOpen(order: Pick<Order, 'status'>): boolean {
  return order.status === 'draft' || order.status === 'partially_paid'
}

export const paymentMethodNames: Record<PaymentMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  balance: '储值余额',
  // 免单不是收到的钱：结清记录上记免掉的金额和原因，不计入实收、不能退款
  comp: '免单',
}

/** 整单免单结清的订单（一分没收，结清记录里有一条免单）：没有收到钱，不能退款。由接口的 settlement 判断。 */
export function isComped(order: Pick<Order, 'settlement'>): boolean {
  return order.settlement === 'comp'
}

/**
 * 带免单结清记录的订单：整单免单，或分笔付款收了一部分、剩下免单。后者 settlement 不是 comp，
 * 收到的那几笔照常能退，只有免单那一笔不能退。金额照接口的 compCents。
 */
export function hasComp(order: Pick<Order, 'compCents'>): boolean {
  return (order.compCents ?? 0) > 0
}

/** 收到钱的付款（不含免单）：分笔付款时逐笔列出、退款要选哪一笔。 */
export function moneyPayments(order: Pick<Order, 'payments'>): Payment[] {
  return (order.payments ?? []).filter((payment) => payment.method !== 'comp')
}

/**
 * 会员结账之外还有别人分笔付的钱：会员这一笔（标了 member）和别人付的要分开写、分开退。
 * 会员结账一次收齐的单（全部付款都是会员这一笔）没有这种区分。
 */
export function hasOtherPayers(order: Pick<Order, 'payments'>): boolean {
  const money = moneyPayments(order)
  return money.some((payment) => payment.member) && money.some((payment) => !payment.member)
}

/**
 * 一笔付款怎么称呼：方式；分笔付款时会员结账那一笔里的现金、微信、支付宝写明「会员结账」，和别人付的分开。
 * 储值本身就是会员这一笔，不再重复。
 */
export function paymentLabel(payment: Pick<Payment, 'method' | 'member'>, order?: Pick<Order, 'payments'>): string {
  const name = paymentMethodNames[payment.method] ?? payment.method
  return payment.member && payment.method !== 'balance' && (!order || hasOtherPayers(order))
    ? `${name}（会员结账）`
    : name
}

/** 免单的原因（结清记录上的），没有免单为空串。 */
export function compReason(order: Pick<Order, 'payments'>): string {
  return order.payments?.find((payment) => payment.method === 'comp')?.reason ?? ''
}

/** 现金收款记下的实收与找零（付款记录上的 cashReceivedCents、changeCents，后端算好的）；没记的返回 null。 */
export function cashTenderText(payment: Pick<Payment, 'cashReceivedCents' | 'changeCents'>): string | null {
  if (payment.cashReceivedCents === undefined || payment.changeCents === undefined) return null
  return `实收 ${money(payment.cashReceivedCents)} · 找零 ${money(payment.changeCents)}`
}

/**
 * 收到的钱分成几笔、每条付款记录是第几笔：会员结账那一笔（标了 member 的储值与随会员结账收的线下款）算一笔，
 * 其余现金、微信、支付宝各算一笔；免单不算。只有一笔时没有「第几笔」可说，返回空表。
 */
export function paymentNumbers(
  order: Pick<Order, 'payments'> & Partial<Pick<Order, 'settlement'>>,
): Map<string, number> {
  const numbers = new Map<string, number>()
  const received = moneyPayments(order)
  // 会员结账单的付款都没标 member（重放旧响应）：一次收齐，全是会员这一笔
  if (order.settlement === 'member' && !received.some((payment) => payment.member)) return numbers
  let n = 0
  let member = 0
  for (const payment of received) {
    if (payment.member) {
      if (!member) member = ++n
      numbers.set(payment.id, member)
    } else numbers.set(payment.id, ++n)
  }
  return n > 1 ? numbers : new Map()
}

/**
 * 每笔付款一行（结账页的已结清等描述列表用）：分几笔收的写「第 n 笔 · 方式」，免单写免单；
 * 金额后面接现金实收与找零或免单原因，都照付款记录。key 在一单里不重复。
 */
export function paymentRows(
  order: Pick<Order, 'payments'> & Partial<Pick<Order, 'settlement'>>,
): { key: string; value: string }[] {
  const numbers = paymentNumbers(order)
  return (order.payments ?? []).map((payment) => {
    const tender = cashTenderText(payment)
    if (payment.method === 'comp')
      return { key: '免单', value: `${money(payment.amountCents)}（${payment.reason ?? ''}）` }
    const n = numbers.get(payment.id)
    return {
      key: n ? `第 ${n} 笔 · ${paymentLabel(payment, order)}` : paymentLabel(payment, order),
      value: tender ? `${money(payment.amountCents)}（${tender}）` : money(payment.amountCents),
    }
  })
}

/** 订单编号：订单 ID 的前 8 位，和小程序显示的一致。 */
export function orderNumber(order: Pick<Order, 'id'>): string {
  return order.id.slice(0, 8)
}

/** 部分退款：退过钱但还没退完，状态仍是「已付款」。已退金额来自接口。 */
export function isPartiallyRefunded(order: Pick<Order, 'status' | 'refundedCents'>): boolean {
  return order.status === 'paid' && order.refundedCents > 0
}

export function lineName(line: Pick<OrderLine, 'name' | 'productId'>): string {
  return line.name || (line.productId ? '未命名商品' : '消费项目')
}

/** 列表里的项目摘要：前两项「名称 ×数量」，多出的写共几项。 */
export function lineSummary(order: Pick<Order, 'lines'>): string {
  const lines = order.lines ?? []
  if (!lines.length) return '暂无明细'
  const head = lines
    .slice(0, 2)
    .map((line) => `${lineName(line)} ×${line.quantity}`)
    .join('、')
  return lines.length > 2 ? `${head} 等 ${lines.length} 项` : head
}

/**
 * 顾客的显示名，用订单里服务端带的称呼：散客没有账户；称呼缺失（账户不在了、重放的旧响应）时用编号前 8 位。
 */
export function customerLabel(order: Pick<Order, 'accountId' | 'customer'>): string {
  if (!order.accountId) return '散客'
  const customer = order.customer
  if (!customer) return `顾客 ${order.accountId.slice(0, 8)}`
  return customer.phoneMasked ? `${customer.nickname} · ${customer.phoneMasked}` : customer.nickname
}

/** 比例折扣的整数基点写成百分比：1000 → 10%，1250 → 12.5%，1 → 0.01%。不经过浮点。 */
export function basisPointsPercent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100)
  const fraction = basisPoints % 100
  if (!fraction) return `${whole}%`
  return `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}%`
}

export function discountText(discount: Pick<OrderDiscount, 'kind' | 'amountCents' | 'rateBasisPoints'>): string {
  return discount.kind === 'fixed'
    ? `固定减免 ${money(discount.amountCents ?? 0)}`
    : `按比例减免 ${basisPointsPercent(discount.rateBasisPoints ?? 0)}`
}

/** 退款记录里回补了什么：「拼豆材料包 ×2」，没回补就说清楚。 */
export function returnedText(refund: Pick<Refund, 'returnedProducts'>, order: Pick<Order, 'lines'>): string {
  const entries = Object.entries(refund.returnedProducts ?? {}).filter(([, count]) => count > 0)
  if (!entries.length) return '未回补库存'
  const names = new Map<string, string>()
  for (const line of order.lines ?? [])
    if (line.productId && !names.has(line.productId)) names.set(line.productId, lineName(line))
  return entries.map(([id, count]) => `${names.get(id) ?? `商品 ${id.slice(0, 8)}`} ×${count}`).join('、')
}

// ---- 列表的网址参数：搜索词、状态、页码 ----

const optionalText = z
  .preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().trim().max(100))
  .optional()
  .catch(undefined)

export const orderListSearchSchema = z.object({
  q: optionalText,
  // 旧链接的 status=draft 当「待结账」（open），草稿和部分付款一起列
  status: z
    .enum(['open', 'draft', 'partially_paid', 'paid', 'refunded', 'voided'])
    .transform((value): OrderStatusFilter => (value === 'draft' ? 'open' : value))
    .optional()
    .catch(undefined),
  settlement: z.enum(['comp']).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
})

export interface OrderListSearch {
  q?: string
  status?: OrderStatusFilter
  /** comp：只看免单结清的订单（服务端按结清记录筛） */
  settlement?: 'comp'
  page?: number
}

/** 网址参数里不认识的值一律当没填；空搜索词、第 1 页不写进网址。 */
export function parseOrderListSearch(raw: Record<string, unknown>): OrderListSearch {
  const parsed = orderListSearchSchema.parse(raw)
  return {
    q: parsed.q || undefined,
    status: parsed.status,
    settlement: parsed.settlement,
    page: parsed.page && parsed.page > 1 ? parsed.page : undefined,
  }
}

/** 订单列表每页条数；筛选、排序、分页都在服务端（GET /sales-orders 的 pageSize）。 */
export const pageSize = 20

// ---- 详情页上的退款入口 ----

export type RefundEntry =
  /** 可以办理退款 */
  | 'available'
  /** 已付款的单，但已经全部退完 */
  | 'fully-refunded'
  /** 已付款的单，当前账号不是店长或老板 */
  | 'no-permission'
  /** 待结账、已撤销的单不能退款 */
  | 'not-paid'
  /** 部分付款（分笔付款还没收齐）：先收齐或对剩余免单，再退款 */
  | 'not-settled'
  /** 整单免单结清：没有收到钱，没有可退的 */
  | 'comped'

/** 会员结账收的款：退款走会员退款（按原付款比例拆到储值、积分与线下，可分多次）。由接口的 settlement 判断，缺省当普通订单。 */
export function isMemberCheckout(order: Pick<Order, 'settlement'>): boolean {
  return order.settlement === 'member'
}

/** 一笔还能单独退的付款（现金、微信、支付宝；不含会员结账那一笔和免单）和它还能退多少（接口的 refundableCents）。 */
export interface RefundablePayment {
  payment: Payment
  refundableCents: number
}

/**
 * 普通退款能选的那几笔：接口在已付款订单的现金、微信、支付宝付款上给了 refundableCents，大于 0 的才列。
 * 重放旧响应时付款上没有这个数：普通订单只有一笔收到的钱，就拿订单的 refundableCents 当它的上限。
 * 会员结账那一笔（member）走会员退款，免单那一笔不能退，都不在里面。
 */
export function refundablePayments(
  order: Pick<Order, 'status' | 'payments' | 'refundableCents' | 'settlement'>,
): RefundablePayment[] {
  if (order.status !== 'paid' && order.status !== 'refunded') return []
  const money = moneyPayments(order).filter((payment) => !payment.member)
  if (money.some((payment) => payment.refundableCents !== undefined))
    return money
      .filter((payment) => (payment.refundableCents ?? 0) > 0)
      .map((payment) => ({ payment, refundableCents: payment.refundableCents ?? 0 }))
  if (!isMemberCheckout(order) && money.length === 1 && order.refundableCents > 0)
    return [{ payment: money[0], refundableCents: order.refundableCents }]
  return []
}

/** 会员结账那一笔还能退多少：接口的 memberCheckout.refundableCents（分笔付款只算会员这一笔）；没有时是订单的可退。 */
export function memberRefundableCents(order: Pick<Order, 'refundableCents' | 'memberCheckout'>): number {
  return order.memberCheckout?.refundableCents ?? order.refundableCents
}

/**
 * 会员结账那一笔还能不能办会员退款：订单已付款、会员这一笔还有可退的。全用积分抵扣、已付为 0 的单
 * 也照样能整单退（退回积分），所以不看金额。
 */
export function memberRefundAvailable(
  order: Pick<Order, 'status' | 'settlement' | 'paidCents' | 'refundableCents' | 'memberCheckout'>,
): boolean {
  if (!isMemberCheckout(order) || order.status !== 'paid') return false
  return order.paidCents === 0 || memberRefundableCents(order) > 0
}

/**
 * 详情页显示什么退款入口。只为好用而隐藏，真正能不能退由后端校验（店长、老板）。
 * 分笔付款要先收齐才能退；整单免单没有收到钱。会员结账单的会员这一笔走会员退款，别人分笔付的几笔走普通退款，
 * 哪样还有可退的就给入口；普通订单按接口给的可退金额。
 */
export function refundEntry(
  order: Pick<Order, 'status' | 'refundableCents' | 'settlement' | 'paidCents' | 'payments' | 'memberCheckout'>,
  viewer: Pick<Account, 'roles'>,
): RefundEntry {
  if (order.status === 'partially_paid') return 'not-settled'
  if (order.status !== 'paid' && order.status !== 'refunded') return 'not-paid'
  if (isComped(order) && order.refundableCents === 0) return 'comped'
  if (!hasRole(viewer, 'manager', 'owner')) return 'no-permission'
  if (isMemberCheckout(order))
    return memberRefundAvailable(order) || refundablePayments(order).length > 0 ? 'available' : 'fully-refunded'
  return order.refundableCents > 0 ? 'available' : 'fully-refunded'
}
