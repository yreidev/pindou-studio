import type { LoyaltyEntry, LoyaltyRule, OfflineMethod } from '../../api/members'
import { money } from '../../lib/format'
import { methodNames, newestFirst } from './entries'

// 柜台三项：充值登记、积分兑换、生日礼物核销（2026-10-06 业主定网页也能办，小程序那份保留）。
// 和小程序员工端「会员与计时 › 会员」同一套规则、同一句确认话：哪些方案、哪些礼物能点，从接口给的
// 已发布规则和流水里挑出来显示；能不能办、扣多少、入账多少都由后端定，这里不推算余额、积分、次数或库存。

/** 充值的线下收款方式，次序、默认值与小程序一致（默认微信）。系统只登记，不经手收款。 */
export const rechargeMethods: { value: OfflineMethod; label: string }[] = (['wechat', 'cash', 'alipay'] as const).map(
  (value) => ({ value, label: methodNames[value] }),
)

export const defaultRechargeMethod: OfflineMethod = 'wechat'

/** 已发布的充值方案（会员记录里的 rules 只有正在生效的规则）。 */
export function rechargeRules(rules: LoyaltyRule[]): LoyaltyRule[] {
  return rules.filter((rule) => rule.kind === 'recharge')
}

/** 已发布的积分兑换商品。积分够不够、次数和总量用没用完由后端核对，不在这里预先拦。 */
export function exchangeRules(rules: LoyaltyRule[]): LoyaltyRule[] {
  return rules.filter((rule) => rule.kind === 'exchange')
}

/**
 * 待核销的生日礼物：顾客领取的生日福利是礼物，且还没有对应的「礼物核销」流水；最新领取的在前。
 * 和小程序的判断一样，过没过有效期由后端核对（过期了拒绝并说明），不在这里按日期推算。
 */
export function pendingGifts(entries: LoyaltyEntry[]): LoyaltyEntry[] {
  const fulfilled = new Set(entries.filter((entry) => entry.kind === 'fulfill_gift').map((entry) => entry.sourceId))
  return newestFirst(entries).filter(
    (entry) => entry.kind === 'birthday' && entry.rule?.scope === 'gift' && !fulfilled.has(entry.id),
  )
}

/** 充值登记的确认话（同小程序）：钱收到了没有、入账什么，数字是方案上写的。 */
export function rechargeConfirmText(rule: LoyaltyRule): string {
  return `已收到该顾客 ${money(rule.amountCents)}？确认后本金入账，赠送 ${money(rule.giftCents)} 和 ${rule.points.toLocaleString('zh-CN')} 积分${rule.boardUses ? `，另送智能豆板 ${rule.boardUses} 次（不过期）` : ''}。`
}

/** 积分兑换的确认话（同小程序）。 */
export function exchangeConfirmText(rule: LoyaltyRule): string {
  return `扣除 ${rule.points.toLocaleString('zh-CN')} 积分并出库一件 ${rule.name}？`
}

/** 生日礼物核销的确认话（同小程序）。 */
export const giftConfirmText = '确认交付生日礼物并扣减库存？'
