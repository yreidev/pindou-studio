// 输入框里的文字转成整数。数量一律整数，不经过 parseFloat：「1.5」「1e3」「 」都不算数。

/** 字数按字符算（和后端按 rune 计一致），emoji 不会被算成两个。 */
export function charCount(text: string): number {
  return Array.from(text).length
}

function integer(text: string, pattern: RegExp): number | null {
  const value = text.trim()
  if (!pattern.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/** 0 或正整数，例如实盘数量。 */
export function nonNegativeInteger(text: string): number | null {
  return integer(text, /^\d+$/)
}

/** 正整数，例如采购数量。 */
export function positiveInteger(text: string): number | null {
  const value = nonNegativeInteger(text)
  return value !== null && value > 0 ? value : null
}

/** 带正负号的整数，例如盘点的变化量「+3」「-2」。 */
export function signedInteger(text: string): number | null {
  const value = integer(text, /^[+-]?\d+$/)
  // 「-0」按 0 算，不要冒出 JavaScript 的 -0
  return value === null ? null : value + 0
}

/** 变化量的写法：+3、-2、0。 */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}
