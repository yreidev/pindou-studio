import { describe, expect, it } from 'vitest'
import { discountFormZeroesOrder, discountZeroesOrder, zeroReceivableMessage } from './discount'

// 应收为 0 的单收不了款（收款至少 1 分），草稿会一直挂在待结账里。整单不收钱要用免单，后端拒绝把应收减到 0 的
// 人工折扣（409 zero_receivable），结账页提交前先说。
describe('人工折扣不能把应收减到 0', () => {
  it('减免 100%、固定减免不少于应收的拦下；留 1 分的照常', () => {
    expect(discountZeroesOrder({ kind: 'percentage', rateBasisPoints: 10000 }, 2990)).toBe(true)
    expect(discountZeroesOrder({ kind: 'fixed', amountCents: 2990 }, 2990)).toBe(true)
    expect(discountZeroesOrder({ kind: 'fixed', amountCents: 5000 }, 2990)).toBe(true)
    expect(discountZeroesOrder({ kind: 'fixed', amountCents: 2989 }, 2990)).toBe(false)
    expect(discountZeroesOrder({ kind: 'percentage', rateBasisPoints: 9999 }, 2990)).toBe(false)
    expect(zeroReceivableMessage).toMatch(/请用「免单」/)
  })

  it('本来就是 0 元的单（待填价的占位行）不算折扣减出来的', () => {
    expect(discountZeroesOrder({ kind: 'fixed', amountCents: 100 }, 0)).toBe(false)
  })

  it('表单上一填就能看出来：填写中、不合法的不算', () => {
    expect(discountFormZeroesOrder({ kind: 'percentage', value: '100' }, 2990)).toBe(true)
    expect(discountFormZeroesOrder({ kind: 'percentage', value: '99.99' }, 2990)).toBe(false)
    expect(discountFormZeroesOrder({ kind: 'fixed', value: '29.9' }, 2990)).toBe(true)
    expect(discountFormZeroesOrder({ kind: 'fixed', value: '29.89' }, 2990)).toBe(false)
    expect(discountFormZeroesOrder({ kind: 'fixed', value: '' }, 2990)).toBe(false)
    expect(discountFormZeroesOrder({ kind: 'fixed', value: '29.9.9' }, 2990)).toBe(false)
  })
})
