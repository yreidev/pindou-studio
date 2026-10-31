import {
  ruleKinds,
  type CatalogItem,
  type LoyaltyPublication,
  type LoyaltyRule,
  type PublicationRecord,
  type RuleKind,
} from '../../api/rules'
import { money } from '../../lib/format'
import { percent } from './units'

// 规则页的显示：类别名、选项名、规则要点、状态、发布记录。只是把已配置的数值换成话，
// 计算示例（某笔交易会怎样）一律向后端要，不在这里算。

export const ruleKindNames: Record<RuleKind, string> = {
  tier: '会员等级',
  recharge: '充值方案',
  earn: '消费积分',
  redeem: '积分抵扣',
  exchange: '积分兑换',
  birthday: '生日福利',
  package: '计时套餐',
  free_timing: '自由计时价',
  companion: '陪客费',
}

export const ruleKindHelp: Record<RuleKind, string> = {
  tier: '按充值本金（不计赠送余额）达到门槛获得等级，消费时按会员价计价。已获得的等级按获得时的规则保留。',
  recharge: '顾客到店付款后由员工登记充值，本金与赠送余额分开记账，可同时赠送积分和不过期的智能豆板次数。',
  earn: '按扣除优惠和积分抵扣后的实付额送积分。全店同时只能启用一项消费积分规则。',
  redeem: '结账时用积分抵扣现金，按完整份数使用。全店同时只能启用一项积分抵扣规则。',
  exchange: '用积分兑换库存商品，兑换时扣积分并出库一件。',
  birthday: '顾客设置生日后，在生日当天或生日月领取。积分即时到账，礼物由员工核销出库，折扣在有效期内用一次。',
  package:
    '顾客扫码选座、预约时选择的计时套餐，员工到店开台也按它计时。「到打烊」的套餐不设时长，开台时算到当天打烊，不能续时、暂停。价格可以不填：系统内收费关着时只管时长，打开后没填价的套餐不能用。超时处理选「按续时方案自动加收」时，超出宽限后从套餐结束时起按续时方案分块加收；已发布的旧套餐保持原来的超时处理，改用新方式要重新发布。未发布的套餐不能用来开台。',
  free_timing:
    '员工开台选「自由计时」时按实际使用时长（不含暂停）每 30 分钟一块计价，不足一块按一块。全店同时只能启用一项。没有发布时，自由计时结账要员工填价。',
  companion:
    '陪客不计时、仍占座，陪客会话结账时自动带一行陪客费。全店同时只能启用一项。没有发布时，陪客按 0 元。需要减免时由店长、老板用人工折扣或免单。',
}

export const modeNames: Record<string, string> = {
  cumulative: '按累计充值升级',
  single: '按单次充值升级',
  month: '生日当月可领',
  day: '仅生日当天可领',
}

export const scopeNames: Record<string, string> = {
  all: '全部消费',
  goods: '商品消费',
  service: '服务消费',
  points: '赠积分',
  gift: '送礼物',
  discount: '消费折扣',
}

export const overtimeNames: Record<string, string> = {
  manual: '超时提示员工处理，不自动加价',
  free: '超时免费，不追加费用',
  renewal: '按续时方案自动加收（超出宽限后按续时价分块收，不足一块按一块）',
}

/** 套餐要点里的超时处理。 */
function overtimeSummary(rule: LoyaltyRule): string {
  if (rule.overtime === 'renewal') return `超时宽限 ${rule.overtimeGraceMinutes ?? 0} 分钟，之后按续时方案自动加收`
  return rule.overtime === 'free' ? '超时免费' : '超时提示员工处理'
}

export type RulesTab = RuleKind | 'history'

/** 网址里的标签页参数：认不得的一律回到第一个类别。 */
export function parseRulesSearch(search: Record<string, unknown>): { tab?: RulesTab } {
  const tab = search.tab
  if (tab === 'history' || (ruleKinds as readonly unknown[]).includes(tab)) return { tab: tab as RulesTab }
  return {}
}

export function productName(products: CatalogItem[] | undefined, id: string): string {
  if (!id) return '未选择商品'
  const item = products?.find((product) => product.id === id)
  return item?.name || `商品 ${id.slice(0, 8)}`
}

/** 套餐价格：没填（0）写「未定价」。 */
const packagePrice = (rule: LoyaltyRule) => (rule.amountCents > 0 ? money(rule.amountCents) : '未定价')

const days = (n: number, permanent = '永久有效') => (n > 0 ? `${n} 天内有效` : permanent)

/** 规则要点，一行话说清配置了什么。 */
export function ruleSummary(rule: LoyaltyRule, products?: CatalogItem[]): string {
  switch (rule.kind) {
    case 'tier':
      return [
        `${rule.mode === 'single' ? '单次' : '累计'}充值满 ${money(rule.amountCents)}`,
        `会员价为原价的 ${percent(rule.rateBasisPoints)}`,
        rule.validDays > 0 ? `等级 ${rule.validDays} 天内有效` : '等级永久有效',
      ].join(' · ')
    case 'recharge':
      return [
        `充值 ${money(rule.amountCents)}`,
        `赠送余额 ${money(rule.giftCents)}`,
        rule.points > 0 ? `赠 ${rule.points} 积分（${days(rule.validDays)}）` : '不赠积分',
        rule.boardUses ? `送智能豆板 ${rule.boardUses} 次（不过期）` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    case 'earn':
      return [
        `${scopeNames[rule.scope] ?? rule.scope}每满 ${money(rule.amountCents)} 得 ${rule.points} 积分`,
        `积分${days(rule.validDays)}`,
      ].join(' · ')
    case 'redeem':
      return [
        `每 ${rule.points} 积分抵 ${money(rule.amountCents)}`,
        `每单最多抵应付的 ${percent(rule.maxBasisPoints)}`,
        `最低使用 ${rule.minimumPoints} 积分`,
        rule.stack ? '可与会员折扣叠加' : '不与会员折扣叠加',
      ].join(' · ')
    case 'exchange':
      return [
        `${rule.points} 积分兑换「${productName(products, rule.productId)}」`,
        `累计可兑 ${rule.quantity} 件`,
        `每人限 ${rule.perUserLimit} 次`,
      ].join(' · ')
    case 'birthday': {
      const benefit =
        rule.scope === 'points'
          ? `赠 ${rule.points} 积分`
          : rule.scope === 'gift'
            ? `送礼物「${productName(products, rule.productId)}」`
            : `消费按原价的 ${percent(rule.rateBasisPoints)} 计价`
      return [
        rule.mode === 'day' ? '生日当天' : '生日当月',
        benefit,
        `每年限领 ${rule.perUserLimit} 次`,
        `领取后 ${rule.validDays} 天内有效`,
      ].join(' · ')
    }
    case 'package':
      if (rule.untilClose) return [`到打烊 ${packagePrice(rule)}`, '不能续时、暂停', overtimeSummary(rule)].join(' · ')
      return [
        `${rule.durationMinutes} 分钟 ${packagePrice(rule)}`,
        rule.renewalMinutes > 0 ? `续时每次 ${rule.renewalMinutes} 分钟 ${money(rule.renewalCents)}` : '不提供续时',
        rule.pauseLimitMinutes > 0 ? `累计免费暂停 ${rule.pauseLimitMinutes} 分钟` : '不能暂停',
        overtimeSummary(rule),
      ].join(' · ')
    case 'free_timing':
      return [
        `每 ${rule.durationMinutes} 分钟 ${money(rule.amountCents)}`,
        rule.durationMinutes > 0 ? `折合每小时 ${money((rule.amountCents * 60) / rule.durationMinutes)}` : '',
        '不足一块按一块',
      ]
        .filter(Boolean)
        .join(' · ')
    case 'companion':
      return `陪客会话结账带一行 ${money(rule.amountCents)} · 不计时`
  }
}

/** 两份规则内容是否一样（不比 enabled：那是发布状态，不是内容）。 */
export function sameContent(a: LoyaltyRule, b: LoyaltyRule): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  keys.delete('enabled')
  return [...keys].every((key) => left[key] === right[key])
}

/**
 * 一条规则此刻的状态：生效中（已发布且启用）、已停用（发布过但最后一次是停用）、未发布（只是草稿）。
 * changed 表示生效中但草稿又改过，改动还没发布。
 */
export type RuleStatus = 'active' | 'disabled' | 'unpublished'

export interface RuleRow {
  draft: LoyaltyRule
  /** 生效中的版本（可能和草稿不同） */
  active?: LoyaltyRule
  status: RuleStatus
  changed: boolean
  /** 最近一次发布或停用 */
  latest?: PublicationRecord
}

const statusOrder: Record<RuleStatus, number> = { active: 0, unpublished: 1, disabled: 2 }

/** 某个类别下的全部规则，生效中的在前，其次未发布、已停用，同状态按名称。 */
export function ruleRows(
  data: { drafts: Record<string, LoyaltyRule>; rules: LoyaltyRule[]; publications: PublicationRecord[] },
  kind: RuleKind,
): RuleRow[] {
  return Object.values(data.drafts)
    .filter((draft) => draft.kind === kind)
    .map((draft): RuleRow => {
      const active = data.rules.find((rule) => rule.id === draft.id)
      const latest = data.publications.find((publication) => publication.rule.id === draft.id)
      const status: RuleStatus = active ? 'active' : latest ? 'disabled' : 'unpublished'
      return { draft, active, status, changed: Boolean(active && !sameContent(active, draft)), latest }
    })
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.draft.name.localeCompare(b.draft.name, 'zh-CN'))
}

export const statusNames: Record<RuleStatus, string> = {
  active: '生效中',
  disabled: '已停用',
  unpublished: '未发布',
}

/** 发布人：服务端带的称呼里的昵称；账户不在了显示编号前 8 位。 */
export function actorName(publication: Pick<PublicationRecord, 'actor' | 'actorId'>): string {
  return publication.actor?.nickname || `账号 ${publication.actorId.slice(0, 8)}`
}

/** 发布记录里这一条是发布还是停用。 */
export function publicationAction(publication: LoyaltyPublication): '发布' | '停用' {
  return publication.rule.enabled ? '发布' : '停用'
}
