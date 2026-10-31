import { dateOnly, dateTime, money, moneyText } from './format'
import { entryNames, type Entry } from './membership'

/** 顾客和员工看到同一份流水说明，余额快照只读后端记下的数。 */
export function memberEntry(entry: Entry, entries: Entry[]) {
  const consumption = entry.consumption
  const title = consumption
    ? [
        entry.kind === 'consume_reverse' ? '撤销消费' : '消费',
        consumption.headcount === 2 ? '双人' : '单人',
        consumption.packageName,
        consumption.dayType === 'holiday' ? '节假日' : '工作日',
      ].join(' · ')
    : `${entryNames[entry.kind] || entry.kind}${entry.rule ? ` · ${entry.rule.name}` : ''}`
  const lines: string[] = []
  const amount = entry.principalCents + entry.giftCents
  if (consumption) lines.push(`消费金额 ¥${money(consumption.amountCents)}`)
  if (amount !== 0) lines.push(`余额 ${amount > 0 ? '+' : '-'}¥${money(Math.abs(amount))}`)
  if (entry.boardUses) lines.push(`智能豆板 ${entry.boardUses > 0 ? '+' : ''}${entry.boardUses} 次`)
  for (const point of entry.points)
    lines.push(
      `积分 ${point.delta > 0 ? '+' : ''}${point.delta}${point.expiresAt ? ` · 到期 ${dateOnly(point.expiresAt)}` : ''}`,
    )
  if (consumption?.extraCents && entry.kind === 'consume')
    lines.push(`余额不够，另付 ¥${money(consumption.extraCents)}`)
  if (entry.reason) lines.push(entry.reason)
  if (entry.balanceAfter) {
    const after = entry.balanceAfter
    lines.push(`余额 ¥${money(after.principalCents + after.giftCents)} · 豆板剩 ${after.boardUses} 次`)
  }
  return {
    title,
    date: entry.serviceDate || dateTime(entry.createdAt),
    lines,
    reversed: entry.kind === 'consume' && entries.some((e) => e.kind === 'consume_reverse' && e.sourceId === entry.id),
  }
}

/** 门店日期的短写；业务日期原样使用，旧流水再从记账时刻取门店日期。 */
export const entryDate = (entry: Entry) => entry.serviceDate || dateOnly(entry.createdAt)
export function memberDay(value: string, weekday = true) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : dateOnly(value)
  const at = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(at.getTime())) return '--'
  return `${at.getUTCMonth() + 1}月${at.getUTCDate()}日${weekday ? ` 周${'日一二三四五六'[at.getUTCDay()]}` : ''}`
}
export const consumptionContent = (entry: Entry) =>
  entry.consumption
    ? [
        entry.consumption.packageName,
        entry.consumption.headcount === 2 ? '双人' : '单人',
        entry.consumption.dayType === 'holiday' ? '节假日' : '工作日',
      ].join(' · ')
    : ''
export const rechargeName = (entry: Entry) =>
  entry.rule?.name || `${moneyText(entry.principalCents)} 送 ${moneyText(entry.giftCents)}`
export const entryAmount = (entry: Entry) => entry.principalCents + entry.giftCents
export const signedAmount = (amount: number) => `${amount < 0 ? '−' : '+'}¥${moneyText(Math.abs(amount))}`
export const afterBalance = (entry: Entry) =>
  entry.balanceAfter ? `余额 ¥${moneyText(entry.balanceAfter.principalCents + entry.balanceAfter.giftCents)}` : ''

export type CustomerEntry = {
  entry: Entry
  reversal?: Entry
  title: string
  date: string
  notes: string[]
  amount: string
  balance: string
  icon: 'consume' | 'recharge' | 'reverse' | 'other'
}

/** 只有顾客明细合并撤销。原流水和反向流水仍完整保留给员工和消息页。 */
export function customerEntries(entries: Entry[]): CustomerEntry[] {
  const reversals = new Map(entries.filter((e) => e.kind === 'consume_reverse').map((e) => [e.sourceId, e]))
  return entries
    .filter((e) => e.kind !== 'consume_reverse')
    .slice()
    .reverse()
    .map((entry) => {
      const reversal = reversals.get(entry.id)
      const notes: string[] = []
      if (entry.kind === 'consume' && entry.boardUses) notes.push(`用智能豆板 ${Math.abs(entry.boardUses)} 次`)
      if (entry.kind === 'recharge') {
        notes.push(`实付 ¥${moneyText(entry.principalCents)}`)
        if (entry.giftCents || entry.boardUses)
          notes.push(
            [
              entry.giftCents ? `送 ¥${moneyText(entry.giftCents)}` : '',
              entry.boardUses ? `智能豆板 ${entry.boardUses} 次` : '',
            ]
              .filter(Boolean)
              .join(' 和'),
          )
      }
      if (entry.consumption?.extraCents) notes.push(`余额不够，另付 ¥${moneyText(entry.consumption.extraCents)}`)
      if (reversal) notes.push(`门店撤销：${reversal.reason || '已退回余额'}`)
      else if (entry.kind !== 'consume' && entry.reason) notes.push(entry.reason)
      if (entry.kind !== 'consume' && entry.kind !== 'recharge') {
        if (entry.boardUses) notes.push(`智能豆板 ${entry.boardUses > 0 ? '+' : ''}${entry.boardUses} 次`)
        for (const p of entry.points)
          notes.push(`积分 ${p.delta > 0 ? '+' : ''}${p.delta}${p.expiresAt ? ` · 到期 ${dateOnly(p.expiresAt)}` : ''}`)
      }
      return {
        entry,
        reversal,
        title:
          entry.kind === 'consume'
            ? consumptionContent(entry) || '消费'
            : entry.kind === 'recharge'
              ? `充值 ${rechargeName(entry)}`
              : memberEntry(entry, entries).title,
        date: entryDate(entry),
        notes,
        amount: signedAmount(entryAmount(entry)),
        balance: afterBalance(entry),
        icon: entry.kind === 'consume' ? 'consume' : entry.kind === 'recharge' ? 'recharge' : 'other',
      }
    })
}

export function entryMonths(entries: Entry[]) {
  const months = new Map<
    string,
    { key: string; label: string; consumption: number; recharge: number; rows: CustomerEntry[] }
  >()
  for (const row of customerEntries(entries)) {
    const key = row.date.slice(0, 7)
    if (!months.has(key))
      months.set(key, {
        key,
        label: `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`,
        consumption: 0,
        recharge: 0,
        rows: [],
      })
    const month = months.get(key)!
    month.rows.push(row)
    if (row.entry.kind === 'consume' && !row.reversal)
      month.consumption += row.entry.consumption?.amountCents ?? Math.abs(entryAmount(row.entry))
    if (row.entry.kind === 'recharge') month.recharge += row.entry.principalCents
  }
  return [...months.values()].sort((a, b) => b.key.localeCompare(a.key))
}
