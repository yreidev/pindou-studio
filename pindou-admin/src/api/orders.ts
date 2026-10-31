import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { client, idempotencyKey, read, readPage, type Page, type Schemas } from './client'
import { loyaltyAction } from './loyalty-actions'

// 订单接口（契约的 Order）。金额一律整数分；已退、可退由服务端算好下发，前端只展示。

/**
 * 一张订单。version 是服务端给的不透明版本，写操作原样带回（expectedVersion），不自行计算。
 * customer 是关联顾客的称呼，散客单为 null；重放 0.0.7 之前记下的幂等响应时没有这个字段，按 null 处理。
 * refundableCents 是登记退款金额的上限（已付减已退）；settlement 是收款方式与退款走哪条路，memberCheckout 只有会员结账单才有。
 */
export type Order = Schemas['Order']
export type OrderStatus = Order['status']
export type OrderLine = Schemas['OrderLine']
export type OrderDiscount = Schemas['OrderDiscount']
export type Payment = Schemas['Payment']
export type PaymentMethod = Payment['method']
/** 一次退款。returnedProducts 是这次实际退回并可再售的件数，按商品编号记；退服务费或货没退回时没有。 */
export type Refund = Schemas['Refund']
/** member：会员结账收的款，退款走会员退款（按原付款比例，可分多次）；standard：其余订单，退款走普通退款。 */
export type Settlement = Order['settlement']
/**
 * 会员结账单结账时动过的会员资产与线下补付，服务端按会员流水合计；退款按这几项的比例拆，之后仍是原结账的数字。
 * refunded（累计已退回）与 refundBlocked（退剩余全部收不回积分）只在单张订单的响应里带，列表不带。
 */
export type MemberCheckout = Schemas['OrderMemberCheckout']
/** 会员退款从各来源退回、收回的数（一次的预览，或累计已退回），服务端按原付款比例算好。 */
export type MemberRefundPart = Schemas['MemberRefundPart']
/** 按比例该收回的本单所送积分已被用掉、收不回：缺多少、被哪些流水用掉、现在最多能退多少。 */
export type MemberRefundBlocked = Schemas['MemberRefundBlocked']
/** 用掉本单所送积分的一笔：checkout 会员结账抵扣（sourceId 是那张订单）；exchange 积分兑换；adjust 员工手动扣减（资产调整）。 */
export type PointSpend = MemberRefundBlocked['spentBy'][number]
/** 会员退款预览（refund_quote）：这次将退回、收回什么，依据的订单版本，退不了时的说明。 */
export type MemberRefundQuote = Schemas['LoyaltyRefundQuote']

/** 订单列表的查询条件：都交给服务端。 */
export interface OrderListParams {
  q?: string
  /** open 是「待结账」：草稿和部分付款（分笔付款还没收齐）的一起列。 */
  status?: OrderStatus | 'open'
  /** comp：只看免单结清的订单 */
  settlement?: 'comp'
  /** 从 1 起；超出时服务端落到最后一页，实际页码见 OrderPage.page。 */
  page: number
  pageSize: number
}

export type OrderPage = Page<Order>

/**
 * 登记退款。paymentId 是退哪一笔付款（分几笔收的单必须带，一笔收齐的可以不带）；
 * returnedProducts 只放真的要回补的商品；一件都不回补时不带这个字段。
 */
export type RefundInput = Schemas['RefundInput']

/** 会员退款预览（/loyalty/actions 的 refund_quote 动作）的请求内容。 */
export interface MemberRefundQuoteInput {
  /** 订单的顾客。 */
  accountId?: string
  /** 订单编号。 */
  targetId: string
  /** 读到的订单版本；过期时后端回 409 order_version_conflict。 */
  expectedVersion: string
  /** 这次退的金额（分）；不带为退剩余全部（实付为 0 的单只能这样）。 */
  amountCents?: number
}

/** 会员退款（/loyalty/actions 的 refund 动作）的请求内容：expectedVersion 带预览依据的那一版订单，不自行换新。 */
export interface MemberRefundInput extends MemberRefundQuoteInput {
  reason: string
  /** 实际退回并可再售的件数，同一单累计不超过售出数；一件都不回补时不带。 */
  returnedProducts?: Record<string, number>
}

export const ordersApi = {
  /** 按页取订单：筛选、排序、分页都在服务端，总数与实际页码从响应头读。 */
  list: (params: OrderListParams, signal?: AbortSignal): Promise<OrderPage> =>
    readPage(
      client.GET('/sales-orders', {
        params: {
          query: {
            page: params.page,
            pageSize: params.pageSize,
            status: params.status,
            settlement: params.settlement,
            q: params.q || undefined,
          },
        },
        signal,
      }),
      params.page,
    ),
  get: (orderId: string, signal?: AbortSignal) =>
    read(client.GET('/sales-orders/{salesOrderId}', { params: { path: { salesOrderId: orderId } }, signal })),
  /** 登记退款：带幂等键，同内容重试沿用同一个键；版本冲突（409）交给页面重读后让人再确认。 */
  refund: (orderId: string, input: RefundInput) =>
    read(
      client.POST('/sales-orders/{salesOrderId}/refunds', {
        params: { path: { salesOrderId: orderId }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /**
   * 会员结账单退款：这次的金额按原付款比例拆到线下、本金、赠送和积分（后端算），订单追加一笔退款记录，退满变已退款。
   * 店长、老板；同样带幂等键，版本冲突交给页面重读后让人再确认。
   */
  memberRefund: (input: MemberRefundInput) => loyaltyAction({ action: 'refund', ...input }),
  /** 会员退款预览：只算不写（后端走只读事务），也要幂等键。 */
  memberRefundQuote: (input: MemberRefundQuoteInput) => loyaltyAction({ action: 'refund_quote', ...input }),
}

export function ordersQuery(params: OrderListParams) {
  return queryOptions({
    queryKey: ['sales-orders', 'list', params],
    queryFn: ({ signal }) => ordersApi.list(params, signal),
    // 翻页、换筛选时先留着上一页，不闪成加载中
    placeholderData: keepPreviousData,
  })
}

/** 一张订单的全部会员退款预览，提交被拒后据此重新预览。 */
export const memberRefundQuoteKey = (orderId: string) => ['sales-orders', 'member-refund-quote', orderId] as const

/**
 * 会员退款预览。按订单、读到的版本和金额缓存；只算不写，不随实时事件重读——拆出来的数只取决于订单版本，
 * 不能在员工眼皮底下变；积分够不够扣回以提交时后端的核对为准（和结账报价一样），提交被拒时页面再重新预览。
 * 订单被别人改了时回 409，由页面提示重读。
 */
export function memberRefundQuoteQuery(input: MemberRefundQuoteInput) {
  return queryOptions({
    queryKey: [...memberRefundQuoteKey(input.targetId), input.expectedVersion, input.amountCents ?? 'all'],
    queryFn: () => ordersApi.memberRefundQuote(input),
    staleTime: Infinity,
    retry: false,
    meta: { realtime: false },
  })
}

export function orderQuery(orderId: string) {
  return queryOptions({
    queryKey: ['sales-orders', 'detail', orderId],
    queryFn: ({ signal }) => ordersApi.get(orderId, signal),
  })
}
