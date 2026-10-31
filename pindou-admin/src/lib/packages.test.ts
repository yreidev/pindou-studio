import { describe, expect, it } from 'vitest'
import { packageDuration, packageLine } from './packages'

describe('计时套餐的写法', () => {
  it('到打烊的不写分钟，收费关着时不写价格', () => {
    expect(packageDuration({ durationMinutes: 120 })).toBe('120 分钟')
    expect(packageDuration({ durationMinutes: 0, untilClose: true })).toBe('到打烊')
    const pkg = { name: '两小时', durationMinutes: 120, amountCents: 5900 }
    expect(packageLine(pkg, true)).toBe('两小时 · 120 分钟 · ¥59.00')
    expect(packageLine(pkg, false)).toBe('两小时 · 120 分钟')
    expect(packageLine({ name: '全天', durationMinutes: 0, amountCents: 0, untilClose: true }, false)).toBe(
      '全天 · 到打烊',
    )
  })
})
