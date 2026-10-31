import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { client, read, readPage, type Page, type Schemas } from './client'
import { loyaltyAction } from './loyalty-actions'

// 会员资产：查会员、代开会员、登记消费与充值、兑换和核销；店长老板可撤销消费，老板可退充值。
// 资产以接口为准，前端计算只用于提交前的确认展示。

export type OfflineMethod = NonNullable<LoyaltyEntry['method']>

/** 已发布的会员规则（充值方案、兑换商品等），会员记录里带着当前生效的那些。 */
export type LoyaltyRule = Schemas['LoyaltyRule']

/** 余额；expiringPoints 是后端按批次算出的「即将到期」积分（当前口径 30 天内），rateBasisPoints 10000 为不打折。 */
export type LoyaltyBalance = Schemas['LoyaltyBalance']

/**
 * 一条不可改写的资产流水；退款、纠错另起一条冲正流水。sourceId：充值是规则，充值退款是原充值流水，
 * 结账与消费积分是订单，消费退款是原结账流水。rule 是当时的规则快照。
 */
export type LoyaltyEntry = Schemas['LoyaltyEntry']

/** 生日资料：birthday 仅月日 MM-DD，未设置为空串。 */
export type LoyaltyProfile = Schemas['LoyaltyProfile']

/**
 * 员工读到的一位顾客的会员记录（/loyalty/account）。流水按时间升序。version 是该顾客的会员资产版本：
 * 只覆盖已发布规则与他自己的流水、生日资料和申请。
 */
export type LoyaltyMember = Schemas['LoyaltyMember']

/** 会员列表（/loyalty/members）的一行：脱敏摘要与当前余额。phoneMasked 没留手机号时为空串。 */
export type LoyaltyMemberSummary = Schemas['LoyaltyMemberSummary']

/** 会员列表的查询条件：关键字筛选、排序（昵称拼音）、分页都在服务端。 */
export interface MemberListParams {
  /** 昵称或打码手机号包含它、编号以它开头，或完整手机号等于它。 */
  q?: string
  /** 从 1 起；超出时服务端落到最后一页，实际页码见 Page.page。 */
  page: number
  pageSize: number
}

export interface AdjustInput {
  accountId: string
  /** 员工确认时看到的会员资产版本，原样回传；变了后端回 409，重读后再确认。 */
  expectedVersion: string
  principalCents: number
  giftCents: number
  points: number
  boardUses: number
  reason: string
}

/**
 * 柜台三项（所有员工都能办，和小程序「会员与计时 › 会员」同一个接口、同样的请求内容）：
 * 对哪位会员、办哪一项（充值方案、兑换商品的规则编号，或要核销的那条生日福利流水），
 * 以及员工点下去时看到的会员资产版本。充值、兑换时后端核对版本，变了回 409，重读后再确认。
 */
export interface CounterInput {
  accountId: string
  targetId: string
  expectedVersion: string
}

export interface RechargeInput extends CounterInput {
  serviceDate: string
  /** 顾客这笔钱是怎么付的（线下收款，系统只登记）。 */
  method: OfflineMethod
}

export interface RechargeRefundInput {
  accountId: string
  /** 要退的那条充值流水。 */
  targetId: string
  reason: string
}

export const membersApi = {
  openAccount: (input: Schemas['MemberAccountInput']) => read(client.POST('/member-accounts', { body: input })),
  consume: (input: {
    accountId: string
    expectedVersion: string
    serviceDate: string
    consumption: Schemas['LoyaltyConsumptionInput']
    reason?: string
  }) => loyaltyAction({ action: 'consume', ...input }),
  reverseConsumption: (input: { accountId: string; targetId: string; expectedVersion: string; reason: string }) =>
    loyaltyAction({ action: 'consume_reverse', ...input }),
  /** 按页取会员：余额只算这一页的人，总数与实际页码从响应头读。 */
  members: (params: MemberListParams, signal?: AbortSignal): Promise<Page<LoyaltyMemberSummary>> =>
    readPage(
      client.GET('/loyalty/members', {
        params: { query: { page: params.page, pageSize: params.pageSize, q: params.q || undefined } },
        signal,
      }),
      params.page,
    ),
  account: (accountId: string, signal?: AbortSignal) =>
    read(client.GET('/loyalty/account', { params: { query: { accountId } }, signal })),
  /** 充值登记：员工确认已收到线下付款后，按已发布的充值方案入账本金、赠送余额与积分。 */
  recharge: (input: RechargeInput) => loyaltyAction({ action: 'recharge', ...input }),
  /** 积分兑换：按已发布的兑换商品扣积分、出库一件；次数、总量、积分、库存都由后端核对。 */
  exchange: (input: CounterInput) => loyaltyAction({ action: 'exchange', ...input }),
  /** 生日礼物核销：顾客领取的礼物交到手上，出库一件；过期、已核销、库存不足由后端拒绝。 */
  fulfillGift: (input: CounterInput) => loyaltyAction({ action: 'fulfill_gift', ...input }),
  /** 手动加减（所有员工，2026-10-10 起）：本金、赠送余额、积分可正可负，必须写原因、扣不成负数，生成一条「资产调整」流水。 */
  adjust: (input: AdjustInput) => loyaltyAction({ action: 'adjust', ...input }),
  /** 充值退款（仅老板）：整笔退回本金并收回该笔赠送余额与积分，生成「充值退款」冲正流水。 */
  rechargeRefund: (input: RechargeRefundInput) => loyaltyAction({ action: 'recharge_refund', ...input }),
}

export const loyaltyMembersQuery = (params: MemberListParams) =>
  queryOptions({
    queryKey: ['loyalty', 'members', params],
    queryFn: ({ signal }) => membersApi.members(params, signal),
    // 翻页、换搜索词时先留着上一页，不闪成加载中
    placeholderData: keepPreviousData,
  })

export const loyaltyAccountQuery = (accountId: string) =>
  queryOptions({
    queryKey: ['loyalty', 'account', accountId],
    queryFn: ({ signal }) => membersApi.account(accountId, signal),
  })
