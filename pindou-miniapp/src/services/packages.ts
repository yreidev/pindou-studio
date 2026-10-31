import { money, storeOffsetMinutes } from './format'

// 计时套餐的写法。「到打烊」的套餐（untilClose）没有固定时长，开台时按当天打烊（「营业与预约」的每天结束时间）算；
// 系统内收费关着时不写价格（钱在美团、大众点评收，套餐可以不填价）。

type PackageLike = { name: string; durationMinutes: number; amountCents: number; untilClose?: boolean }

/** 「120 分钟」或「到打烊」。 */
export const packageDuration = (rule: Pick<PackageLike, 'durationMinutes' | 'untilClose'>) =>
  rule.untilClose ? '到打烊' : `${rule.durationMinutes} 分钟`

/** 「两小时 · 120 分钟 · ¥59.00」；收费关着时不写价格。 */
export const packageLine = (rule: PackageLike, billing: boolean) =>
  [rule.name, packageDuration(rule), ...(billing ? [`¥${money(rule.amountCents)}`] : [])].join(' · ')

/**
 * 套餐按时长从短到长排，「到打烊」的放最后，同样长的按名字。后端按规则编号返回，编号是随机的，
 * 不排的话顾客「预约座位」和员工消费登记会排成 3 小时、1 小时、全天、2 小时。
 */
export const byDuration = <T extends Pick<PackageLike, 'name' | 'durationMinutes' | 'untilClose'>>(
  list: readonly T[],
) =>
  [...list].sort(
    (a, b) =>
      Number(!!a.untilClose) - Number(!!b.untilClose) ||
      (a.untilClose ? 0 : a.durationMinutes - b.durationMinutes) ||
      a.name.localeCompare(b.name, 'zh-Hans-CN'),
  )

/** 列可选开始时间时按多长算：「到打烊」的只要在打烊前开始就行（至少 1 分钟）。 */
export const slotMinutesOf = (rule: Pick<PackageLike, 'durationMinutes' | 'untilClose'>) =>
  rule.untilClose ? 1 : rule.durationMinutes

/** 门店时区（中国标准时间）里这一刻是当天第几分钟。 */
export function storeMinute(at: Date): number {
  const shifted = new Date(at.getTime() + storeOffsetMinutes * 60000)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/** 预约（或开台）实际占多久：「到打烊」的从开始算到打烊，其余按套餐时长。 */
export function bookingMinutes(
  rule: Pick<PackageLike, 'durationMinutes' | 'untilClose'>,
  start: Date,
  closeMinute: number,
): number {
  if (!rule.untilClose) return rule.durationMinutes
  return Math.max(0, closeMinute - storeMinute(start))
}
