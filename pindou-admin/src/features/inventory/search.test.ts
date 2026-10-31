import { describe, expect, it } from 'vitest'
import { inventorySearchSchema, resolveTab, visibleTabs } from './search'

describe('商品与库存的网址参数', () => {
  it('合法参数原样保留', () => {
    expect(
      inventorySearchSchema.parse({
        tab: 'movements',
        q: '珠光',
        low: true,
        page: 2,
        item: 's1',
        kind: 'adjustment',
        from: '2026-10-01',
        to: '2026-10-04',
      }),
    ).toEqual({
      tab: 'movements',
      q: '珠光',
      low: true,
      page: 2,
      item: 's1',
      kind: 'adjustment',
      from: '2026-10-01',
      to: '2026-10-04',
    })
  })

  it('手改坏的参数丢掉那一项，不让整页报错', () => {
    expect(
      inventorySearchSchema.parse({ tab: 'nope', page: 0, low: 'yes', kind: 'theft', from: '10/01', q: '豆' }),
    ).toEqual({ q: '豆' })
  })

  it('店员看不到盘点；手输 ?tab=adjust 回到库存', () => {
    expect(visibleTabs(true)).toEqual(['stock', 'purchase', 'adjust', 'movements', 'catalog'])
    expect(visibleTabs(false)).toEqual(['stock', 'purchase', 'movements', 'catalog'])
    expect(resolveTab('adjust', false)).toBe('stock')
    expect(resolveTab('adjust', true)).toBe('adjust')
    expect(resolveTab('catalog', false)).toBe('catalog')
    expect(resolveTab(undefined, true)).toBe('stock')
  })
})
