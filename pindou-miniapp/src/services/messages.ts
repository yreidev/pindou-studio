import type { components } from '../api/schema'
import { CustomerError } from './customer'
import { request } from './staff'
import { clockTime, dateOnly, moneyText } from './format'
import {
  afterBalance,
  consumptionContent,
  entryAmount,
  memberDay,
  memberEntry,
  rechargeName,
  signedAmount,
} from './member-entry'
import type { Entry, Table } from './membership'

export type Message = components['schemas']['Message']
export type MessageFeed = components['schemas']['MessageFeed']
async function read<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
  try {
    return await request<T>(path, method)
  } catch (error) {
    const failure = error as { code: string; message: string; status: number }
    throw new CustomerError(failure.code, failure.message, failure.status)
  }
}
export const messages = {
  me: () => read<MessageFeed>('/messages/me'),
  preview: () => read<MessageFeed>('/messages/me?limit=1'),
  markRead: () => read<void>('/messages/me/reads', 'POST'),
}

export function messageText(message: Message, tables: Pick<Table, 'id' | 'code'>[] = [], graceMinutes = 30) {
  let title = '会员记录',
    lines: string[] = [],
    icon = 'other',
    target = ''
  if (message.entry) {
    const entry: Entry = { ...message.entry, points: message.entry.points || [] }
    const balance = entry.balanceAfter ? `${afterBalance(entry)} · 智能豆板剩 ${entry.balanceAfter.boardUses} 次` : ''
    const consume = entry.consumption
    if (entry.kind === 'consume') {
      title = `消费 ¥${moneyText(consume?.amountCents ?? Math.abs(entryAmount(entry)))}`
      lines = [
        [consumptionContent(entry), entry.boardUses ? `用豆板 ${Math.abs(entry.boardUses)} 次` : '']
          .filter(Boolean)
          .join(' · '),
        balance,
      ]
      if (consume?.extraCents) lines.push(`余额不够，另付 ¥${moneyText(consume.extraCents)}`)
      icon = 'consume'
    } else if (entry.kind === 'recharge') {
      title = `充值到账 ¥${moneyText(entryAmount(entry))}`
      lines = [`${rechargeName(entry)}${entry.boardUses ? `，另送智能豆板 ${entry.boardUses} 次` : ''}`, balance]
      icon = 'recharge'
    } else if (entry.kind === 'consume_reverse') {
      title = '门店撤销了一笔消费'
      lines = [
        `当天 ¥${moneyText(consume?.amountCents ?? entryAmount(entry))} 的消费，已退回余额`,
        entry.reason ? `原因：${entry.reason}` : '',
      ]
      icon = 'reverse'
    } else {
      const detail = memberEntry(entry, [])
      title = detail.title
      lines = [
        [
          entryAmount(entry) ? `余额 ${signedAmount(entryAmount(entry))}` : '',
          entry.boardUses ? `智能豆板 ${entry.boardUses > 0 ? '+' : ''}${entry.boardUses} 次` : '',
          ...entry.points.map((p) => `积分 ${p.delta > 0 ? '+' : ''}${p.delta}`),
        ]
          .filter(Boolean)
          .join(' · '),
        entry.reason || balance,
      ]
    }
    target = `/pages/customer/consumption-detail/index?id=${encodeURIComponent(
      entry.kind === 'consume_reverse' && entry.sourceId ? entry.sourceId : entry.id,
    )}`
  } else if (message.reservation) {
    const view = message.reservation,
      reservation = view.reservation
    const cancelled = message.kind === 'reservation_cancelled'
    title = cancelled ? '预约被取消' : '预约成功'
    const table =
      tables.find((t) => t.id === reservation.serviceTableId)?.code ||
      (view.tableNumber ? String(view.tableNumber) : '')
    lines = [
      `${memberDay(reservation.startAt)} ${clockTime(reservation.startAt).slice(0, 5)}${table ? ` · ${table} 号桌` : ''}`,
      cancelled
        ? `原因：${reservation.reason || '门店取消了这次预约'}`
        : `${reservation.packageName} · 开始后 ${graceMinutes} 分钟内到店`,
    ]
    icon = cancelled ? 'reverse' : 'reservation'
    target = '/pages/customer/my-reservations/index'
  }
  return { title, lines: lines.filter(Boolean), icon, target, time: clockTime(message.at).slice(0, 5) }
}

export function messageDays(items: Message[], now = Date.now()) {
  const today = dateOnly(now),
    yesterday = dateOnly(now - 86400000)
  const groups = new Map<string, { key: string; title: string; items: Message[] }>()
  for (const item of [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const key = dateOnly(item.at)
    if (!groups.has(key))
      groups.set(key, { key, title: key === today ? '今天' : key === yesterday ? '昨天' : memberDay(key), items: [] })
    groups.get(key)!.items.push(item)
  }
  return [...groups.values()]
}
export function messagePreview(message?: Message) {
  if (!message) return '预约、充值和消费记录都在这里'
  const text = messageText(message)
  return [
    text.title,
    message.entry?.balanceAfter ? afterBalance({ ...message.entry, points: message.entry.points || [] }) : '',
  ]
    .filter(Boolean)
    .join('，')
}
