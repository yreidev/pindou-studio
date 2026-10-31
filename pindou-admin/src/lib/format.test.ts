import { describe, expect, it } from 'vitest'
import { clockTime, dateOnly, dateTime, money, parseYuan, storeToday, yuanInput } from './format'

describe('金额', () => {
  it('整数分显示成元，带千分位，负数带符号', () => {
    expect(money(0)).toBe('¥0.00')
    expect(money(5)).toBe('¥0.05')
    expect(money(123456)).toBe('¥1,234.56')
    expect(money(-100)).toBe('-¥1.00')
  })

  it('输入的元换成整数分，不经过浮点；不合法给 null', () => {
    expect(parseYuan('12')).toBe(1200)
    expect(parseYuan('12.3')).toBe(1230)
    expect(parseYuan(' 0.07 ')).toBe(7)
    expect(parseYuan('19.99')).toBe(1999)
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '.5', '12.'] as const) expect(parseYuan(bad)).toBeNull()
    expect(yuanInput(1230)).toBe('12.30')
  })
})

describe('门店时区', () => {
  it('按中国标准时间显示，不跟电脑时区走', () => {
    expect(dateTime('2026-10-04T16:30:00Z')).toBe('2026-10-05 00:30')
    expect(dateOnly('2026-10-04T16:30:00Z')).toBe('2026-10-05')
    expect(clockTime('2026-10-04T16:30:05Z')).toBe('00:30:05')
    expect(storeToday(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01')
    expect(dateTime('不是时间')).toBe('—')
  })
})
