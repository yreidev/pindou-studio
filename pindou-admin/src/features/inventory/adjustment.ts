import { z } from 'zod'
import { ApiError } from '../../api/client'
import type { AdjustmentInput } from '../../api/inventory'
import { charCount, nonNegativeInteger, signedInteger } from './fields'

// 盘点调整。后端只收「变化量」（quantityDelta）；店长盘点时手里是数出来的实际数量，
// 所以两种填法都给：填实盘数量就用「实盘 − 当前」，填变化量就直接用。
// 「当前」一律是接口刚读到的库存；这里算出的调整后数量只是给人核对的预览，提交后以接口返回为准。
// 提交时把这个「当前」作为 expectedQuantity 一起交给后端：确认之后有人结账或入库，库里的数就对不上，
// 后端回 409 而不是按旧数算出的变化量去改。

export type AdjustmentMode = 'count' | 'delta'

export interface AdjustmentFormValues {
  stockItemId: string
  mode: AdjustmentMode
  /** 实盘数量（mode = count） */
  counted: string
  /** 变化量（mode = delta），减少写负数 */
  delta: string
  reason: string
}

export const adjustmentDefaults = (stockItemId = ''): AdjustmentFormValues => ({
  stockItemId,
  mode: 'count',
  counted: '',
  delta: '',
  reason: '',
})

export type AdjustmentPlan =
  { ok: true; current: number; delta: number; target: number } | { ok: false; message: string }

/** 按当前库存和填写的数字算出变化量与调整后数量；没填返回 null。 */
export function adjustmentPlan(
  current: number,
  values: Pick<AdjustmentFormValues, 'mode' | 'counted' | 'delta'>,
): AdjustmentPlan | null {
  if (values.mode === 'count') {
    if (!values.counted.trim()) return null
    const target = nonNegativeInteger(values.counted)
    if (target === null) return { ok: false, message: '实盘数量填 0 或正整数' }
    if (target === current) return { ok: false, message: '实盘数量和当前库存一样，不用调整' }
    return { ok: true, current, delta: target - current, target }
  }
  if (!values.delta.trim()) return null
  const delta = signedInteger(values.delta)
  if (delta === null) return { ok: false, message: '变化量填整数，减少写负数，例如 -2' }
  if (delta === 0) return { ok: false, message: '变化量不能为 0' }
  const target = current + delta
  if (target < 0) return { ok: false, message: `当前只有 ${current} 件，调整后不能为负数` }
  return { ok: true, current, delta, target }
}

/**
 * 盘点表单的校验。currentOf 给出库存项目的当前数量（接口读到的）；找不到说明已被删或还没读到。
 */
export function adjustmentSchema(currentOf: (stockItemId: string) => number | undefined) {
  return z
    .object({
      stockItemId: z.string().min(1, '请选择要盘点的商品'),
      mode: z.enum(['count', 'delta']),
      counted: z.string(),
      delta: z.string(),
      reason: z
        .string()
        .refine((value) => value.trim() !== '', '请写明调整原因')
        .refine((value) => charCount(value.trim()) <= 200, '原因最多 200 个字'),
    })
    .superRefine((value, ctx) => {
      if (!value.stockItemId) return
      const current = currentOf(value.stockItemId)
      if (current === undefined) {
        ctx.addIssue({ code: 'custom', path: ['stockItemId'], message: '找不到这个库存项目，请刷新后重选' })
        return
      }
      const field = value.mode === 'count' ? 'counted' : 'delta'
      const plan = adjustmentPlan(current, value)
      if (!plan)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: value.mode === 'count' ? '请填写实盘数量' : '请填写变化量',
        })
      else if (!plan.ok) ctx.addIssue({ code: 'custom', path: [field], message: plan.message })
    })
}

/** 提交的请求：变化量和确认时看到的当前库存（expectedQuantity）一起交给后端。 */
export function adjustmentRequest(
  stockItemId: string,
  plan: Extract<AdjustmentPlan, { ok: true }>,
  reason: string,
): AdjustmentInput {
  return { stockItemId, quantityDelta: plan.delta, reason, expectedQuantity: plan.current }
}

/** 后端说库存在确认之后变了（409 stock_quantity_conflict）：什么都没改，要重读后让人重新核对。 */
export function isStockChanged(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'stock_quantity_conflict'
}
