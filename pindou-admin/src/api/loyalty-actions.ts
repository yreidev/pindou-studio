import { client, idempotencyKey, read, type Schemas } from './client'

// /loyalty/actions：会员、规则、计时操作都走这一个接口，按 action 区分，都要幂等键。

export type LoyaltyActionInput = Schemas['LoyaltyAction']

/** 动作名必须是契约里的动作，结果必须是契约里 LoyaltyActionResult 的一种，否则这里报错。 */
type ResultsOf<T extends { [A in LoyaltyActionInput['action']]?: Schemas['LoyaltyActionResult'] }> = T

/**
 * 网页后台用到的动作各自返回什么（后端 membership.go 的 loyaltyAction）。契约只能把响应写成各种资源的并集
 * （LoyaltyActionResult，anyOf，没有可区分的字段），看不出哪个动作回哪一种，所以在这里按动作写明。
 */
type ActionResults = ResultsOf<{
  preview_rule: Schemas['LoyaltyRulePreview']
  save_rule: Schemas['LoyaltyRule']
  publish: Schemas['LoyaltyPublication']
  disable: Schemas['LoyaltyPublication']
  adjust: Schemas['LoyaltyMember']
  consume: Schemas['LoyaltyMember']
  consume_reverse: Schemas['LoyaltyMember']
  recharge_refund: Schemas['LoyaltyMember']
  recharge: Schemas['LoyaltyMember']
  exchange: Schemas['LoyaltyMember']
  fulfill_gift: Schemas['LoyaltyMember']
  refund: Schemas['Order']
  refund_quote: Schemas['LoyaltyRefundQuote']
  quote: Schemas['LoyaltyQuote']
  checkout: { order: Schemas['Order']; quote: Schemas['LoyaltyQuote'] }
}>

export async function loyaltyAction<A extends keyof ActionResults>(
  input: LoyaltyActionInput & { action: A },
): Promise<ActionResults[A]> {
  const result = await read(client.POST('/loyalty/actions', { params: { header: idempotencyKey() }, body: input }))
  return result as ActionResults[A]
}
