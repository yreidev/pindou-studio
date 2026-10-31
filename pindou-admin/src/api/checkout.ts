import { queryOptions } from '@tanstack/react-query'
import { client, idempotencyKey, read, type Schemas } from './client'
import { loyaltyAction } from './loyalty-actions'
import type { Order } from './orders'

// 结账接口：改明细、人工折扣、普通收款（/sales-orders/{id}…），会员结账的报价与确认（/loyalty/actions 的 quote、checkout）。
// 语义照搬小程序 services/staff.ts、services/membership.ts：写请求都带幂等键和读到的订单版本（expectedVersion），
// 版本冲突（409）交给页面提示重读、由人再确认，绝不自动换版本重提。金额一律由后端算。

export type OrderLineInput = Schemas['OrderLine']
/** 人工折扣（店长、老板）：固定金额用整数分 amountCents，比例用整数基点 rateBasisPoints，必须写原因。 */
export type DiscountInput = Schemas['OrderDiscountInput']
/** 线下收款方式；会员结账里的储值余额支付由后端按报价记成 balance。 */
export type OfflineMethod = Schemas['PaymentInput']['method']
/** 会员结账报价：先会员或生日折扣，再积分、本金、赠送余额，最后线下补付。version 绑定订单与该顾客的会员资产。 */
export type LoyaltyQuote = Schemas['LoyaltyQuote']
/** 计时会话。admissionId 有值的是会员扫码入座的套餐会话：订单按购买快照结算，不能改明细或打折。 */
export type VenueSession = Schemas['ServiceTableSession']

export interface QuoteInput {
  /** 订单编号。 */
  targetId: string
  /** 读到的订单版本。 */
  expectedVersion: string
  /** 要用的积分，0 表示不用。 */
  points: number
  /** 是否用储值余额（先本金、后赠送）。 */
  useBalance: boolean
  /**
   * 这次最多用多少储值（本金 + 赠送，整数分）：会员只用储值付自己那份时填，要和 useBalance 一起；不带就是能用多少用多少。
   * 超过可用储值或这一笔应付时后端拒绝（报价失败，原样显示原因）。确认收款时要带和报价时一样的值。
   */
  balanceCents?: number
}

export interface MemberCheckoutInput extends QuoteInput {
  /** 页面上展示、员工核对过的那份报价的版本；会员资产或权益变了后端会拒收（409 loyalty_conflict）。 */
  quoteVersion: string
  /** 线下补付的方式；补付为 0 时后端不看它。 */
  method: OfflineMethod
  /** 补付走现金时选填的实收现金（整数分），后端算出找零记在付款记录上；不填就不带。 */
  cashReceivedCents?: number
  /**
   * 这次随会员结账收多少线下补付（整数分，0 到报价的 offlineCents）；不带就是全部、一次收齐。
   * 少收时订单变为部分付款，余下的按普通收款分笔收（多人合付）。
   */
  offlineCents?: number
}

export const checkoutApi = {
  /** 保存明细（整份替换）。店员只能按商品资料的售价记商品，改价找店长或老板（后端校验）。 */
  saveLines: (orderId: string, lines: OrderLineInput[], expectedVersion: string) =>
    read(
      client.PATCH('/sales-orders/{salesOrderId}', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: { lines, expectedVersion },
      }),
    ),
  /**
   * 给待结账订单绑定、更换顾客账户，或改成散客（accountId 为 null）；所有员工都可以。
   * 换了顾客订单版本跟着变，之前的会员报价作废，页面按新版本重新报价。套餐订单后端回 409 loyalty_conflict。
   */
  setCustomer: (orderId: string, input: Schemas['OrderCustomerInput']) =>
    read(
      client.PATCH('/sales-orders/{salesOrderId}/customer', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /** 人工折扣，只对待结账订单；店长、老板（后端校验）。 */
  discount: (orderId: string, input: DiscountInput) =>
    read(
      client.POST('/sales-orders/{salesOrderId}/discounts', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /**
   * 收一笔线下款：金额不超过还差的数（outstandingCents），收齐结清、没收齐是部分付款（可以接着收下一笔）。
   * 第一笔时商品扣库存、计时停住、明细冻结。现金可带实收现金（cashReceivedCents），后端按这一笔记找零。
   */
  pay: (orderId: string, input: Schemas['PaymentInput']) =>
    read(
      client.POST('/sales-orders/{salesOrderId}/payments', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /**
   * 免单（店长、老板）：这一单不收钱（或部分付款的单剩下的不收了）、直接结清，必须写原因。记成一条免单结清记录
   * （不是 100% 折扣），应收照旧、实收不增加、免掉的部分不能退款；免掉的是读到的这一版还差的数
   * （带 expectedVersion，计时费变了、别人刚收了一笔都会 409）。
   */
  comp: (orderId: string, input: Schemas['CompInput']) =>
    read(
      client.POST('/sales-orders/{salesOrderId}/comps', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /** 会员结账报价：只算不写（后端走只读事务），也要幂等键。 */
  quote: (input: QuoteInput) => loyaltyAction({ action: 'quote', ...input }),
  /**
   * 会员结账确认（只能是第一笔）：扣余额与积分、送积分、登记这次收的线下补付、扣库存，一次成功或失败。
   * 线下补付只收一部分（offlineCents）时订单为部分付款，积分只按会员这一笔收到的钱送。
   */
  memberCheckout: (input: MemberCheckoutInput) => loyaltyAction({ action: 'checkout', ...input }),
  session: (sessionId: string, signal?: AbortSignal) =>
    read(client.GET('/venue-sessions/{venueSessionId}', { params: { path: { venueSessionId: sessionId } }, signal })),
}

/**
 * 会员结账报价。按订单版本、积分和是否用余额缓存；只算不写，不随实时事件重读——
 * 金额不能在员工眼皮底下悄悄变，会员资产变了由确认收款时后端拒收、页面重算后让人再核对（和小程序一样）。
 */
export function quoteQuery(
  order: Pick<Order, 'id' | 'version'>,
  points: number,
  useBalance: boolean,
  balanceCents?: number,
) {
  // 只有用储值时才带上限；不带时请求和以前一样
  const cap = useBalance && balanceCents !== undefined ? { balanceCents } : {}
  return queryOptions({
    queryKey: ['loyalty', 'quote', order.id, order.version, points, useBalance, cap.balanceCents ?? null],
    queryFn: () =>
      checkoutApi.quote({ targetId: order.id, expectedVersion: order.version, points, useBalance, ...cap }),
    staleTime: Infinity,
    retry: false,
    meta: { realtime: false },
  })
}

export function venueSessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: ['venue-sessions', sessionId],
    queryFn: ({ signal }) => checkoutApi.session(sessionId, signal),
  })
}
