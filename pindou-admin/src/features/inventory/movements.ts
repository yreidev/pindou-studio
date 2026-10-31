import type { MovementKind, StockMovement } from '../../api/inventory'

// 库存流水的显示：类型名、说明。数量变化原样用接口给的，不在前端累加出结存。

export const movementKindLabels: Record<MovementKind, string> = {
  purchase: '采购入库',
  adjustment: '盘点调整',
  sale: '销售出库',
  refund: '退款回补',
  loyalty: '会员业务',
}

/** Semi 标签自带的颜色：入库绿、出库橙、盘点蓝、会员紫。 */
export const movementKindColors: Record<MovementKind, 'green' | 'orange' | 'blue' | 'cyan' | 'purple'> = {
  purchase: 'green',
  adjustment: 'blue',
  sale: 'orange',
  refund: 'cyan',
  loyalty: 'purple',
}

/** 会员业务分出库（会员结账、积分兑换、生日礼物核销）和退回（会员退款）。 */
export function movementLabel(movement: Pick<StockMovement, 'kind' | 'quantityDelta'>): string {
  if (movement.kind === 'loyalty') return movement.quantityDelta < 0 ? '会员出库' : '会员退回'
  return movementKindLabels[movement.kind] ?? movement.kind
}

const shortId = (value: string | undefined) => (value ? value.slice(0, 8) : '')

/** 说明栏：盘点写原因，采购写供应商和备注，销售退款写订单号。 */
export function movementDetail(movement: StockMovement): string {
  switch (movement.kind) {
    case 'adjustment':
      return movement.reason || '—'
    case 'purchase':
      return [movement.supplierName && `供应商 ${movement.supplierName}`, movement.note].filter(Boolean).join(' · ')
    case 'sale':
    case 'refund':
      return movement.referenceId ? `订单 ${shortId(movement.referenceId)}` : '—'
    case 'loyalty':
      return movement.quantityDelta < 0
        ? `会员结账、积分兑换或礼物核销 · ${shortId(movement.referenceId)}`
        : `会员退款 · 订单 ${shortId(movement.referenceId)}`
    default:
      return '—'
  }
}
