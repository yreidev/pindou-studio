import type { Entry } from './membership'
import { dateOnly, moneyText } from './format'

const money = (cents: number) => `¥${moneyText(cents)}`

/** 只复制这笔流水存下的快照，不拿会员当前资产补算旧记录。 */
export function memberCopy(entry: Entry, entries: Entry[] = [], today = dateOnly(Date.now())): string | null {
  const after = entry.balanceAfter
  if (!after) return null
  const day = entry.serviceDate || dateOnly(entry.createdAt)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const date = `${match[1] === today.slice(0, 4) ? '' : `${match[1]}年`}${Number(match[2])}月${Number(match[3])}日`
  const balance = `余额 ${money(after.principalCents + after.giftCents)}${after.giftCents ? `（其中赠送 ${money(after.giftCents)}）` : ''}`
  if (entry.kind === 'consume' && entry.consumption) {
    if (entries.some((e) => e.kind === 'consume_reverse' && e.sourceId === entry.id)) return null
    const c = entry.consumption
    const uses = -(entry.boardUses ?? 0)
    return [
      'EXAMPLE 示例工坊 · 消费记录',
      `${date} ${c.headcount === 2 ? '双人' : '单人'} · ${c.packageName} · ${c.dayType === 'holiday' ? '节假日' : '工作日'}`,
      `消费 ${money(c.amountCents)}，余额扣 ${money(-entry.principalCents - entry.giftCents)}`,
      ...(c.extraCents ? [`余额不够，另付 ${money(c.extraCents)}`] : []),
      balance,
      uses ? `智能豆板用 ${uses} 次，剩 ${after.boardUses} 次` : `智能豆板剩 ${after.boardUses} 次`,
    ].join('\n')
  }
  if (entry.kind === 'recharge') {
    return [
      'EXAMPLE 示例工坊 · 充值记录',
      `${date} 充值「${entry.rule?.name || '充值'}」`,
      `付 ${money(entry.principalCents)}，到账 ${money(entry.principalCents + entry.giftCents)}${entry.boardUses ? `，送智能豆板 ${entry.boardUses} 次` : ''}`,
      balance,
      `智能豆板剩 ${after.boardUses} 次`,
    ].join('\n')
  }
  return null
}

export function registeredEntry(before: Entry[], after: Entry[], kind: 'consume' | 'recharge') {
  const known = new Set(before.map((entry) => entry.id))
  return after.find((entry) => entry.kind === kind && !known.has(entry.id))
}
