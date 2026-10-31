import { describe, expect, it } from 'vitest'
import type { StockMovement } from '../../api/inventory'
import { movementDetail, movementLabel } from './movements'

const movement = (overrides: Partial<StockMovement>): StockMovement => ({
  id: 'm',
  stockItemId: 's1',
  productId: 'p1',
  kind: 'purchase',
  quantityDelta: 1,
  createdAt: '2026-10-04T02:00:00Z',
  ...overrides,
})

describe('库存流水显示', () => {
  it('类型名；会员业务按方向分出库和退回', () => {
    expect(movementLabel(movement({ kind: 'purchase' }))).toBe('采购入库')
    expect(movementLabel(movement({ kind: 'adjustment', quantityDelta: -3 }))).toBe('盘点调整')
    expect(movementLabel(movement({ kind: 'sale', quantityDelta: -2 }))).toBe('销售出库')
    expect(movementLabel(movement({ kind: 'refund' }))).toBe('退款回补')
    expect(movementLabel(movement({ kind: 'loyalty', quantityDelta: -1 }))).toBe('会员出库')
    expect(movementLabel(movement({ kind: 'loyalty', quantityDelta: 1 }))).toBe('会员退回')
  })

  it('说明：盘点写原因，采购写供应商和备注，销售退款写订单号前 8 位', () => {
    expect(movementDetail(movement({ kind: 'adjustment', reason: '月底盘点' }))).toBe('月底盘点')
    expect(movementDetail(movement({ kind: 'purchase', supplierName: '豆子批发', note: '发票 0921' }))).toBe(
      '供应商 豆子批发 · 发票 0921',
    )
    expect(movementDetail(movement({ kind: 'purchase', supplierName: '豆子批发' }))).toBe('供应商 豆子批发')
    expect(movementDetail(movement({ kind: 'sale', referenceId: '12345678-aaaa-bbbb' }))).toBe('订单 12345678')
    expect(movementDetail(movement({ kind: 'refund', referenceId: '87654321-aaaa' }))).toBe('订单 87654321')
  })
})
