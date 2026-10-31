// 规则里的比例存整数基点（10000 = 100%），界面上按百分比输入和显示，最多两位小数。
// 和金额一样只做整数运算，不经过浮点：12.5% → 1250，98.75% → 9875。

/** 百分比文字 → 整数基点；可带 % 号。格式不对返回 null（范围由表单规则另行检查）。 */
export function parsePercent(text: string): number | null {
  const value = text.trim().replace(/\s*[%％]$/, '')
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** 整数基点 → 输入框里的百分比数字，去掉多余的 0：9000 → "90"，1250 → "12.5"，9875 → "98.75"。 */
export function percentInput(basisPoints: number): string {
  const value = Math.trunc(basisPoints)
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const whole = Math.floor(abs / 100)
  const fraction = String(abs % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`
}

/** 整数基点 → 显示用的百分比：1250 → "12.5%"。 */
export function percent(basisPoints: number): string {
  return `${percentInput(basisPoints)}%`
}

/** 非负整数文字 → 数字（积分、天数、分钟、次数）。格式不对返回 null。 */
export function parseCount(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,10}$/.test(value)) return null
  return Number(value)
}
