// 显示用的格式化。金额一律整数分，时间一律按门店时区（中国标准时间）显示，不跟电脑的时区走。

export const storeTimeZone = 'Asia/Shanghai'

/** 12345 → ¥123.45；负数 → -¥1.00。只用整数运算，不经过浮点。 */
export function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(cents))
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${sign}¥${yuan.toLocaleString('zh-CN')}.${String(fen).padStart(2, '0')}`
}

/** 用户输入的元（最多两位小数）→ 整数分；不合法返回 null。不用 parseFloat，避免 0.1 + 0.2 这类误差。 */
export function parseYuan(text: string): number | null {
  const value = text.trim()
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** 整数分 → 输入框里的元，例如 1230 → "12.30"。 */
export function yuanInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

const parts = (value: string | number | Date, options: Intl.DateTimeFormatOptions) => {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const map: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('zh-CN', {
    timeZone: storeTimeZone,
    hourCycle: 'h23',
    ...options,
  }).formatToParts(date))
    map[part.type] = part.value
  return map
}

/** 门店时区的「年-月-日 时:分」。 */
export function dateTime(value: string | number | Date): string {
  const p = parts(value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '—'
}

/** 门店时区的「年-月-日」。 */
export function dateOnly(value: string | number | Date): string {
  const p = parts(value, { year: 'numeric', month: '2-digit', day: '2-digit' })
  return p ? `${p.year}-${p.month}-${p.day}` : '—'
}

/** 门店时区的「时:分:秒」。 */
export function clockTime(value: string | number | Date): string {
  const p = parts(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return p ? `${p.hour}:${p.minute}:${p.second}` : '—'
}

/** 门店今天的日期（YYYY-MM-DD），按门店时区算，不按电脑时区。 */
export function storeToday(now: Date = new Date()): string {
  return dateOnly(now)
}
