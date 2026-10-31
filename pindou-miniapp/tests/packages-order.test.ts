import { describe, expect, it } from 'vitest'
import { moneyText } from '../src/services/format'
import { byDuration } from '../src/services/packages'

describe('套餐顺序与金额写法', () => {
  it('按时长排，到打烊的放最后', () => {
    const list = [
      { name: '3 小时', durationMinutes: 180 },
      { name: '全天不限时', durationMinutes: 600, untilClose: true },
      { name: '1 小时', durationMinutes: 60 },
      { name: '2 小时', durationMinutes: 120 },
    ]
    expect(byDuration(list).map((p) => p.name)).toEqual(['1 小时', '2 小时', '3 小时', '全天不限时'])
    expect(list[0].name).toBe('3 小时')
  })

  it('金额三位一逗号，负数和小额照常', () => {
    expect(moneyText(100800)).toBe('1,008.00')
    expect(moneyText(7990)).toBe('79.90')
    expect(moneyText(-123456789)).toBe('-1,234,567.89')
    expect(moneyText(5)).toBe('0.05')
  })
})
