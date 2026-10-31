import { money } from './format'

// 计时套餐的写法。「到打烊」的套餐（untilClose）没有固定时长，开台时按当天打烊算；
// 系统内收费关着时不写价格（钱在美团、大众点评收，套餐可以不填价）。

interface PackageLike {
  name: string
  durationMinutes: number
  amountCents: number
  untilClose?: boolean
}

/** 「120 分钟」或「到打烊」。 */
export function packageDuration(rule: Pick<PackageLike, 'durationMinutes' | 'untilClose'>): string {
  return rule.untilClose ? '到打烊' : `${rule.durationMinutes} 分钟`
}

/** 「两小时 · 120 分钟 · ¥59.00」；收费关着时不写价格。 */
export function packageLine(rule: PackageLike, billing: boolean): string {
  return [rule.name, packageDuration(rule), ...(billing ? [money(rule.amountCents)] : [])].join(' · ')
}
