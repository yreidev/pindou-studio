import { ApiError } from '../../api/client'
import type { LoyaltyQuote, OfflineMethod } from '../../api/checkout'
import type { Order } from '../../api/orders'
import { money, parseYuan } from '../../lib/format'
import { hasUnpricedLine } from './lines'

// 收款登记，规则照搬小程序结账页：
// - 只登记线下收款（现金、微信、支付宝），核实到账后再确认；默认微信；
// - 一单可以分几笔收（2026-10-06 业主定，多人合付）：每笔的金额空着就是全部，可以改小，不超过还差的数（接口的
//   outstandingCents）；没收齐时订单是部分付款，结账页接着「收下一笔」，店长、老板也可以对剩余免单；
// - 订单关联了顾客、还没收过钱时第一笔走会员结账（先报价、再按报价确认），收的是报价里的「线下补付」，可以只收一部分
//   （offlineCents），余额和积分那部分不走收款方式；之后余下的按普通收款分笔收；
// - 明细改过没保存、应收为 0、会员优惠还没算好时不能收款，并说清为什么；
// - 金额全部来自接口（订单的 outstandingCents、报价的 offlineCents），前端不加减；
// - 现金可选填「实收现金」：后端算出找零记在付款记录上。提交前页面给员工看的「应找零」是唯一在前端算的数
//   （整数分相减，只为当场点钱），记下来的找零以接口返回的 changeCents 为准。

export const offlineMethods: { value: OfflineMethod; label: string }[] = [
  { value: 'cash', label: '现金' },
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
]

export const defaultMethod: OfflineMethod = 'wechat'

/** 订单关联了顾客。 */
export function isMemberOrder(order: Pick<Order, 'accountId'>): boolean {
  return Boolean(order.accountId)
}

/**
 * 这一笔走会员结账（报价→确认）：关联了顾客、还没收过钱（草稿）。会员结账只能是第一笔，会员价按整单定；
 * 收了一部分之后（部分付款）余下的都按普通收款分笔收，散客单一直是普通收款。
 */
export function isMemberCheckoutStep(order: Pick<Order, 'accountId' | 'status'>): boolean {
  return isMemberOrder(order) && order.status === 'draft'
}

/** 还差多少没收：接口的 outstandingCents；重放旧响应时没有，草稿就是应收。 */
export function outstandingOf(order: Pick<Order, 'status' | 'receivableCents' | 'outstandingCents'>): number {
  if (order.outstandingCents !== undefined) return order.outstandingCents
  return order.status === 'draft' ? order.receivableCents : 0
}

/**
 * 这一笔最多收多少（也是收款金额空着时的默认）：会员结账是报价里的线下补付；其余是还差的数（第一笔就是应收）。
 * 都原样用接口的数。
 */
export function amountDue(
  order: Pick<Order, 'accountId' | 'status' | 'receivableCents' | 'outstandingCents'>,
  quote: Pick<LoyaltyQuote, 'offlineCents'> | undefined,
): { label: string; cents: number } | null {
  if (isMemberCheckoutStep(order)) return quote ? { label: '线下补付', cents: quote.offlineCents } : null
  return {
    label: order.status === 'partially_paid' ? '还差' : '应收金额',
    cents: outstandingOf(order),
  }
}

export interface CollectAmount {
  /** 这一笔收多少（整数分）；格式不对时没有。 */
  cents?: number
  /** 填得不对时的原因，收款按钮据此灰着。 */
  error?: string
}

/**
 * 这一笔收多少（元，分笔付款时填这一笔的金额）：空着就是全部（max）；填了要是合法金额、不超过 max。
 * 会员结账（allowZero）可以填 0：这次不收线下款，余下的之后分笔收。max 还没有（会员优惠在算、明细没保存）时只核对格式。
 */
export function collectAmount(text: string, maxCents: number | null, allowZero = false): CollectAmount {
  if (!text.trim()) return maxCents === null ? {} : { cents: maxCents }
  const cents = parseYuan(text)
  if (cents === null) return { error: '收款金额按元填写，最多两位小数' }
  if (cents === 0 && !allowZero) return { error: '这一笔至少收 ¥0.01' }
  if (maxCents !== null && cents > maxCents)
    return {
      cents,
      error: allowZero
        ? `这次收的线下款不能超过报价的线下补付 ${money(maxCents)}`
        : `这一笔不能超过还差的 ${money(maxCents)}`,
    }
  return { cents }
}

/**
 * 会员结账只收一部分线下款时：会员这一笔要收到钱（用储值，或这次至少收一部分线下款），否则后端拒绝（分不出哪笔是会员的）。
 * 提前说明；没问题返回 null。
 */
export function memberCollectProblem(
  quote: Pick<LoyaltyQuote, 'principalCents' | 'giftCents' | 'offlineCents'> | undefined,
  offlineCents: number | undefined,
): string | null {
  if (!quote || offlineCents === undefined || offlineCents >= quote.offlineCents) return null
  if (quote.principalCents + quote.giftCents + offlineCents > 0) return null
  return '会员结账这一笔要收到钱：用储值，或这次至少收一部分线下款，余下的再分笔收'
}

export interface PaymentState {
  order: Pick<Order, 'accountId' | 'receivableCents' | 'lines' | 'status'>
  /** 明细改过还没保存。 */
  dirty: boolean
  /** 订单已被修改（409 或实时刷新到了新版本），要先重新读取。 */
  conflict: boolean
  /** 会员单：页面上展示的报价；还在算或算不出来时没有。 */
  quote?: LoyaltyQuote
  /** 会员单：报价正在算（积分、余额刚改过，或在重算）。 */
  quoting: boolean
  /** 会员单：积分填得不对、报价失败等，给人看的原因。 */
  memberProblem?: string
  /** 这一笔的金额填得不对（collectAmount 的 error，或会员这一笔没收到钱）。 */
  amountProblem?: string
  /** 现金实收填得不对（cashTender 的 error）。 */
  cashProblem?: string
}

/** 收款按钮为什么点不动；能收款返回空串。按钮灰着时必须说清原因。 */
export function paymentBlocker(state: PaymentState): string {
  const { order } = state
  if (order.status !== 'draft' && order.status !== 'partially_paid') return '这张订单已经不是待结账状态'
  if (state.conflict) return '订单已被修改，请先重新读取并核对'
  if (order.status === 'draft') {
    if (state.dirty) return '明细改过，请先保存并核对金额'
    if (order.receivableCents <= 0 && hasUnpricedLine(order)) return '有明细还没填单价，填好并保存才能收款'
    if (order.receivableCents <= 0) return '应收金额为 0，请检查明细'
    if (isMemberOrder(order)) {
      if (state.memberProblem) return state.memberProblem
      if (state.quoting || !state.quote) return '正在计算会员优惠…'
    }
  }
  if (state.amountProblem) return state.amountProblem
  if (state.cashProblem) return state.cashProblem
  return ''
}

/** 收了一笔之后的提示：收齐了说收款成功；没收齐（部分付款）说已收多少、还差多少，金额照接口。 */
export function collectedText(order: Pick<Order, 'status' | 'paidCents' | 'outstandingCents'>): string {
  if (order.status !== 'partially_paid') return '收款成功'
  return `已收 ${money(order.paidCents)}，还差 ${money(order.outstandingCents ?? 0)}`
}

/** 找零上限（¥1,000），与后端 MaxCashChangeCents 一致：多半是多打了一个 0。这里只提前提示，后端照样校验。 */
export const maxCashChangeCents = 100_000

export interface CashTender {
  /** 填了的实收现金（整数分）；空着为 undefined，收款请求不带它。 */
  receivedCents?: number
  /** 应找零：实收 − 这次要收的数。只给员工当场点钱看，记下来的以接口为准。 */
  changeCents?: number
  /** 填得不对时的原因，收款按钮据此灰着。 */
  error?: string
}

/**
 * 现金的「实收现金」（元，选填）：空着就不带；填了要是合法金额、不少于这一笔要收的数（分笔付款时只算这一笔），
 * 找零不超过 ¥1,000。dueCents 是这一笔要收的数，还没有（会员优惠在算、明细没保存、金额没填对）时只核对格式。
 */
export function cashTender(text: string, dueCents: number | null): CashTender {
  if (!text.trim()) return {}
  const received = parseYuan(text)
  if (received === null || received <= 0) return { error: '实收现金须为大于 0 的金额，最多两位小数' }
  if (dueCents === null) return { receivedCents: received }
  if (received < dueCents) return { receivedCents: received, error: `实收现金不能少于本次收款 ${money(dueCents)}` }
  const change = received - dueCents
  if (change > maxCashChangeCents)
    return { receivedCents: received, error: `找零不能超过 ${money(maxCashChangeCents)}，请核对实收现金` }
  return { receivedCents: received, changeCents: change }
}

/** 收款按钮上的字：按钮上的数就是要登记的数。 */
export function payButtonText(due: { cents: number } | null): string {
  return due ? `确认收款 ${money(due.cents)}` : '确认收款'
}

/** 使用积分：空着算 0；须为不小于 0 的整数。不合法返回 null。 */
export function parsePoints(text: string): number | null {
  const value = text.trim()
  if (!value) return 0
  if (!/^\d{1,10}$/.test(value)) return null
  const points = Number(value)
  return points <= 1_000_000_000 ? points : null
}

/**
 * 这次用多少储值（元，选填）：会员只用储值付自己那份时填（多人合付，2026-10-06 业主定）。空着就是能用多少用多少（cents 为空）；
 * 填了要是不小于 0、最多两位小数的金额，换成整数分。超不超过可用储值和这一笔应付由后端核对（报价失败时原样显示原因）。
 */
export function parseBalanceCap(text: string): { cents?: number; error?: string } {
  if (!text.trim()) return {}
  const cents = parseYuan(text)
  if (cents === null) return { error: '储值金额按元填写，不小于 0，最多两位小数' }
  return { cents }
}

/** 订单在你操作期间被别人改过：版本冲突，或幂等键对应的内容变了。都要重读后让人再确认。 */
export function isOrderConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'order_version_conflict' || error.code === 'idempotency_conflict')
  )
}

/** 会员结账被拒：会员资产或权益在报价之后变了、余额积分不足、订单变了等，后端都回 loyalty_conflict。 */
export function isLoyaltyConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'loyalty_conflict'
}

/** 结果不确定（断网、服务端出错）：同样内容再提交沿用同一个幂等键，不会重复执行。 */
export function isUncertain(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500)
}

/**
 * 结账页上的失败说明。后端的中文说明原样显示；版本冲突、库存不足、无权、结果不确定换成能照着做的话。
 * what 是这次做的事（「收款」「保存明细」「折扣」），用在「不确定是否已…」里。
 */
export function checkoutErrorMessage(error: unknown, what: string): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '操作失败，请重试'
  if (isOrderConflict(error)) return '订单已被修改，你填写的内容已保留。请重新读取，核对明细和金额后再确认。'
  if (error.code === 'insufficient_stock')
    return '商品库存不足：请核对商品数量，并在「商品与库存」登记采购入库；计时或服务费请选择自定义服务后保存明细。'
  if (error.code === 'forbidden')
    return what === '折扣'
      ? '当前账号无权打折，人工折扣需店长或老板办理。'
      : what === '免单'
        ? '当前账号无权免单，免单需店长或老板办理。'
        : '当前账号无权执行此操作。'
  if (isUncertain(error))
    return `${error.message.replace(/[。.]$/, '')}。不确定是否已${what}时，可以原样再提交一次（同一笔不会重复${what}），或重新读取订单核对。`
  return error.message
}
