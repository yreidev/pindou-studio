import type { LoyaltyEntry, OfflineMethod } from '../../api/members'
import { dateTime, money } from '../../lib/format'
import { shortId } from './members'

// 资产流水的显示：类型中文名、积分变化、原因与来源，以及哪笔充值还能退。
// 流水不可改写：退款和纠错都是另起一条，这里只按已有流水判断「已退过」。

export const entryKindNames: Record<string, string> = {
  recharge: '充值入账',
  consume: '消费',
  consume_reverse: '撤销消费',
  tier: '等级权益',
  adjust: '资产调整',
  recharge_refund: '充值退款',
  exchange: '积分兑换',
  birthday: '生日福利',
  fulfill_gift: '礼物核销',
  checkout: '消费扣款',
  earned: '消费积分',
  refund: '消费退款',
  birthday_used: '生日折扣使用',
}

export const methodNames: Record<OfflineMethod, string> = {
  cash: '现金',
  wechat: '微信线下收款',
  alipay: '支付宝线下收款',
}

export function entryKindName(kind: string): string {
  return entryKindNames[kind] ?? kind
}

export function methodName(method: string | undefined): string {
  return method && method in methodNames ? methodNames[method as OfflineMethod] : ''
}

/** 这条流水的积分净变化（各批次之和）。 */
export function pointsChange(entry: Pick<LoyaltyEntry, 'points'>): number {
  return (entry.points ?? []).reduce((sum, change) => sum + change.delta, 0)
}

/** 这条流水发放的积分最早什么时候到期；不发积分或永久有效返回 undefined。 */
export function grantedPointsExpiry(entry: Pick<LoyaltyEntry, 'points'>): string | undefined {
  const dates = (entry.points ?? [])
    .filter((change) => change.delta > 0 && change.expiresAt)
    .map((change) => change.expiresAt as string)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
  return dates[0]
}

/** 最新的在前（接口按时间升序给）。同一时刻按编号倒序，保证顺序稳定。 */
export function newestFirst(entries: LoyaltyEntry[]): LoyaltyEntry[] {
  return entries
    .slice()
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
}

/** 已经退过款的充值流水编号。 */
export function refundedRechargeIds(entries: LoyaltyEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.kind === 'recharge_refund').map((entry) => entry.sourceId))
}

/** 充值流水且还没退过，才给「退款」。后端仍会再校验（余额或积分批次不足时拒绝）。 */
export function canRefundRecharge(entry: LoyaltyEntry, refunded: Set<string>): boolean {
  return entry.kind === 'recharge' && !refunded.has(entry.id)
}

/**
 * 流水的原因。生日折扣使用的 reason 字段存的是订单编号（后端历史写法），不是人写的原因，不当原因显示。
 */
export function entryReason(entry: LoyaltyEntry): string {
  if (entry.kind === 'birthday_used') return ''
  return entry.reason.trim()
}

const order = (id: string) => (id ? `订单 ${shortId(id)}` : '订单')

/** 流水来源的说明：充值方案与收款方式、被退的那笔充值、关联订单等。 */
export function entrySource(entry: LoyaltyEntry, byId: Map<string, LoyaltyEntry>): string {
  const original = byId.get(entry.sourceId)
  switch (entry.kind) {
    case 'consume':
      return entry.consumption ? `消费金额 ${money(entry.consumption.amountCents)}` : '消费登记'
    case 'consume_reverse':
      return original ? `撤销 ${entryDate(original)} 的${entryTitle(original)}` : `原消费 ${shortId(entry.sourceId)}`
    case 'recharge':
      return [entry.rule?.name ?? '充值', methodName(entry.method)].filter(Boolean).join(' · ')
    case 'recharge_refund':
      if (!original) return `原充值 ${shortId(entry.sourceId)}`
      return [
        `退回 ${dateTime(original.createdAt)} 的充值${original.rule?.name ? `（${original.rule.name}）` : ''}`,
        methodName(entry.method || original.method),
      ]
        .filter(Boolean)
        .join(' · ')
    case 'tier':
      return entry.rule?.name ? `达到 ${entry.rule.name}` : '充值达标'
    case 'adjust':
      return '人工调整'
    case 'exchange':
    case 'birthday':
      return entry.rule?.name ?? '—'
    case 'fulfill_gift':
      return original?.rule?.name ? `核销 ${original.rule.name}` : '核销生日礼物'
    case 'checkout':
    case 'earned':
      return order(entry.sourceId)
    case 'refund':
      return original ? `${order(original.sourceId)} 退款` : `原流水 ${shortId(entry.sourceId)}`
    case 'birthday_used':
      return [original?.rule?.name, order(entry.reason)].filter(Boolean).join(' · ')
    default:
      return entry.sourceId ? shortId(entry.sourceId) : '—'
  }
}

export function entriesById(entries: LoyaltyEntry[]): Map<string, LoyaltyEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]))
}

/** 消费内容使用登记时保存的快照，不受后续套餐改名影响。 */
export function entryTitle(entry: LoyaltyEntry): string {
  if (entry.kind === 'consume' && entry.consumption) {
    const c = entry.consumption
    return `消费 · ${c.headcount === 1 ? '单人' : '双人'} · ${c.packageName} · ${c.dayType === 'holiday' ? '节假日' : '工作日'}`
  }
  return entryKindName(entry.kind)
}

export function entryDate(entry: LoyaltyEntry): string {
  return entry.serviceDate || dateTime(entry.createdAt)
}

export function entryBalanceAfter(entry: LoyaltyEntry): string {
  const after = entry.balanceAfter
  return after ? `记完余额 ${money(after.principalCents + after.giftCents)} · 豆板 ${after.boardUses} 次` : ''
}

export function reversedConsumptionIds(entries: LoyaltyEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.kind === 'consume_reverse').map((entry) => entry.sourceId))
}

export function canReverseConsumption(entry: LoyaltyEntry, reversed: Set<string>): boolean {
  return entry.kind === 'consume' && !reversed.has(entry.id)
}
