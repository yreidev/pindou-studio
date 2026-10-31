import { nonNegativeInteger } from './fields'

// 预警线（后端 alertAt）：库存不高于它就显示「库存偏低」。只有店长、老板能改，后端同样校验。
// 是否偏低只用接口返回的 lowStock，这里不推算。

/** 和后端 maxStockAlert 一致：挡住多敲几个 0 这类手误。 */
export const maxAlertAt = 1_000_000

export type AlertInput = { ok: true; value: number } | { ok: false; message: string }

/** 检查输入的新预警线：0 到上限的整数，且和原来不同。 */
export function parseAlertAt(text: string, current: number): AlertInput {
  if (!text.trim()) return { ok: false, message: '请填写预警线' }
  const value = nonNegativeInteger(text)
  if (value === null || value > maxAlertAt) return { ok: false, message: `预警线填 0 到 ${maxAlertAt} 之间的整数` }
  if (value === current) return { ok: false, message: '和原来的预警线一样，不用修改' }
  return { ok: true, value }
}

/** 确认框的内容：商品、原值和新值、当前库存，以及「偏低」的判断规则。 */
export function alertChangeLines(change: { name: string; quantity: number; from: number; to: number }): string[] {
  return [
    `商品：${change.name}`,
    `预警线：${change.from} 件 → ${change.to} 件`,
    `当前库存：${change.quantity} 件`,
    '库存不高于预警线时，库存表显示「库存偏低」，「只看预警」也会列出它。',
  ]
}
