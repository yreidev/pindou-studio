import { queryOptions } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'
import { loyaltyAction } from './loyalty-actions'

export { catalogItemsQuery, type CatalogItem } from './inventory'

// 经营规则（/loyalty/settings 与 /loyalty/actions 里和规则有关的部分）。
// 规则全部经 /loyalty/actions 按 action 区分：preview_rule、save_rule、publish、disable，
// 每个都要幂等键；save_rule、publish、disable 还要回传读到的规则设置 version（只覆盖规则草稿与发布记录）。

/** 金额为整数分，比例为整数基点（10000 = 100%）。后端总是返回全部字段；草稿 id 空串表示新建。 */
export type LoyaltyRule = Schemas['LoyaltyRule']
export type RuleKind = LoyaltyRule['kind']

export const ruleKinds = [
  'tier',
  'recharge',
  'earn',
  'redeem',
  'exchange',
  'birthday',
  'package',
  'free_timing',
  'companion',
] as const satisfies readonly RuleKind[]

/** 一次发布或停用（rule.enabled 区分），只追加不改写。impact 是老板填写的影响说明。 */
export type LoyaltyPublication = Schemas['LoyaltyPublication']

/** 规则设置（/loyalty/settings）：草稿（发布、停用时也会写回）、当前生效的规则、发布记录（新的在前）与版本。 */
export type LoyaltySettings = Schemas['LoyaltySettings']

/** 规则设置里的发布记录：另带发布人的称呼（账户不在了为 null）。发布、停用动作的响应不带。 */
export type PublicationRecord = LoyaltySettings['publications'][number]

export const rulesApi = {
  settings: (signal?: AbortSignal) => read(client.GET('/loyalty/settings', { signal })),
  /** 服务端按规则算出的计算示例，不改任何资产；店长和老板可用。 */
  preview: async (rule: LoyaltyRule) => (await loyaltyAction({ action: 'preview_rule', rule })).preview,
  /** 保存草稿（新建或修改），不影响已发布的规则。 */
  save: (rule: LoyaltyRule, expectedVersion: string) => loyaltyAction({ action: 'save_rule', rule, expectedVersion }),
  /** 老板发布草稿或停用规则；reason 即影响说明，必填。 */
  publish: (targetId: string, expectedVersion: string, reason: string) =>
    loyaltyAction({ action: 'publish', targetId, expectedVersion, reason }),
  disable: (targetId: string, expectedVersion: string, reason: string) =>
    loyaltyAction({ action: 'disable', targetId, expectedVersion, reason }),
}

export function loyaltySettingsQuery() {
  return queryOptions({ queryKey: ['loyalty', 'settings'], queryFn: ({ signal }) => rulesApi.settings(signal) })
}

/** 规则的计算示例。没有副作用，按规则内容缓存；queryKey 仍以 loyalty 开头。 */
export function rulePreviewQuery(rule: LoyaltyRule) {
  return queryOptions({
    queryKey: ['loyalty', 'preview', rule],
    queryFn: () => rulesApi.preview(rule),
    staleTime: Infinity,
    retry: false,
    // 只算不写，结果只由规则内容决定：不随实时事件重读（以前每次广播都重算，发布确认框开着就循环不止）
    meta: { realtime: false },
  })
}
