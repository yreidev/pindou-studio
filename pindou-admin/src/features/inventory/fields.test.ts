import { describe, expect, it } from 'vitest'
import { charCount, formatDelta, nonNegativeInteger, positiveInteger, signedInteger } from './fields'

describe('数量输入', () => {
  it('只认整数，不经过 parseFloat', () => {
    expect(positiveInteger('12')).toBe(12)
    expect(positiveInteger(' 3 ')).toBe(3)
    for (const text of ['0', '-1', '1.5', '1e3', '', '１２', '0x10']) expect(positiveInteger(text)).toBeNull()
    expect(nonNegativeInteger('0')).toBe(0)
    expect(nonNegativeInteger('-0')).toBeNull()
    expect(positiveInteger('9007199254740993')).toBeNull()
  })

  it('变化量带正负号', () => {
    expect(signedInteger('+3')).toBe(3)
    expect(signedInteger('-2')).toBe(-2)
    expect(Object.is(signedInteger('-0'), 0)).toBe(true)
    expect(signedInteger('- 2')).toBeNull()
    expect(signedInteger('2.0')).toBeNull()
    expect(formatDelta(3)).toBe('+3')
    expect(formatDelta(-2)).toBe('-2')
    expect(formatDelta(0)).toBe('0')
  })

  it('字数按字符算，和后端按 rune 计一致', () => {
    expect(charCount('豆豆')).toBe(2)
    expect(charCount('🎨')).toBe(1)
  })
})
