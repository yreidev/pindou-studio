import { describe, expect, it } from 'vitest'
import { parseCount, parsePercent, percent, percentInput } from './units'

describe('百分比与基点', () => {
  it('百分比换成整数基点，不经过浮点；可带 % 号', () => {
    expect(parsePercent('12.5%')).toBe(1250)
    expect(parsePercent('12.5')).toBe(1250)
    expect(parsePercent(' 98.75 ')).toBe(9875)
    expect(parsePercent('90')).toBe(9000)
    expect(parsePercent('100%')).toBe(10000)
    expect(parsePercent('0.01')).toBe(1)
    expect(parsePercent('0')).toBe(0)
    expect(parsePercent('7 ％')).toBe(700)
    // 0.1 + 0.2 这类浮点误差不会出现：29.15 × 100 用浮点是 2914.9999…
    expect(parsePercent('29.15')).toBe(2915)
  })

  it('格式不对给 null，范围交给表单规则', () => {
    for (const bad of ['', '-1', '12.345', 'abc', '1e2', '.5', '12.', '1000', '%', '5%%'])
      expect(parsePercent(bad)).toBeNull()
    expect(parsePercent('100.5')).toBe(10050)
  })

  it('基点显示成百分比，去掉多余的 0', () => {
    expect(percentInput(9000)).toBe('90')
    expect(percentInput(1250)).toBe('12.5')
    expect(percentInput(9875)).toBe('98.75')
    expect(percentInput(1)).toBe('0.01')
    expect(percentInput(0)).toBe('0')
    expect(percent(10000)).toBe('100%')
    expect(percent(1250)).toBe('12.5%')
    expect(parsePercent(percentInput(1205))).toBe(1205)
  })
})

describe('整数', () => {
  it('只收非负整数', () => {
    expect(parseCount('0')).toBe(0)
    expect(parseCount(' 180 ')).toBe(180)
    expect(parseCount('007')).toBe(7)
    for (const bad of ['', '-1', '1.5', '1e3', '十', '12345678901']) expect(parseCount(bad)).toBeNull()
  })
})
