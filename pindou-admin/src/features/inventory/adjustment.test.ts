import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import {
  adjustmentDefaults,
  adjustmentPlan,
  adjustmentRequest,
  adjustmentSchema,
  isStockChanged,
  type AdjustmentFormValues,
} from './adjustment'

const count = (counted: string) => ({ mode: 'count' as const, counted, delta: '' })
const delta = (text: string) => ({ mode: 'delta' as const, counted: '', delta: text })

describe('盘点的变化量', () => {
  it('按实盘数量：变化量 = 实盘 − 当前', () => {
    expect(adjustmentPlan(30, count('27'))).toEqual({ ok: true, current: 30, delta: -3, target: 27 })
    expect(adjustmentPlan(0, count('5'))).toEqual({ ok: true, current: 0, delta: 5, target: 5 })
    expect(adjustmentPlan(30, count('0'))).toEqual({ ok: true, current: 30, delta: -30, target: 0 })
    expect(adjustmentPlan(30, count('30'))).toEqual({ ok: false, message: '实盘数量和当前库存一样，不用调整' })
    expect(adjustmentPlan(30, count('-1'))).toEqual({ ok: false, message: '实盘数量填 0 或正整数' })
    expect(adjustmentPlan(30, count('2.5'))).toEqual({ ok: false, message: '实盘数量填 0 或正整数' })
    expect(adjustmentPlan(30, count(''))).toBeNull()
  })

  it('按变化量：不能为 0，调整后不能为负', () => {
    expect(adjustmentPlan(30, delta('+5'))).toEqual({ ok: true, current: 30, delta: 5, target: 35 })
    expect(adjustmentPlan(30, delta('-30'))).toEqual({ ok: true, current: 30, delta: -30, target: 0 })
    expect(adjustmentPlan(30, delta('-31'))).toEqual({ ok: false, message: '当前只有 30 件，调整后不能为负数' })
    expect(adjustmentPlan(30, delta('0'))).toEqual({ ok: false, message: '变化量不能为 0' })
    expect(adjustmentPlan(30, delta('三'))).toEqual({ ok: false, message: '变化量填整数，减少写负数，例如 -2' })
    expect(adjustmentPlan(30, delta(' '))).toBeNull()
  })
})

describe('盘点表单校验', () => {
  const schema = adjustmentSchema((id) => (id === 's1' ? 30 : undefined))
  const messages = (values: AdjustmentFormValues) => {
    const result = schema.safeParse(values)
    return result.success
      ? {}
      : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
  }

  it('必须选商品、写原因', () => {
    expect(messages(adjustmentDefaults())).toEqual({ stockItemId: '请选择要盘点的商品', reason: '请写明调整原因' })
    expect(messages({ ...adjustmentDefaults('s1'), counted: '27', reason: '   ' })).toEqual({
      reason: '请写明调整原因',
    })
  })

  it('按当前库存核对数字，错误落在正在填的那一栏', () => {
    expect(messages({ ...adjustmentDefaults('s1'), reason: '月底盘点' })).toEqual({ counted: '请填写实盘数量' })
    expect(messages({ ...adjustmentDefaults('s1'), mode: 'delta', delta: '-40', reason: '破损' })).toEqual({
      delta: '当前只有 30 件，调整后不能为负数',
    })
    expect(messages({ ...adjustmentDefaults('s1'), counted: '27', reason: '月底盘点' })).toEqual({})
    expect(messages({ ...adjustmentDefaults('gone'), counted: '1', reason: '盘点' })).toEqual({
      stockItemId: '找不到这个库存项目，请刷新后重选',
    })
  })

  it('原因最多 200 个字', () => {
    expect(messages({ ...adjustmentDefaults('s1'), counted: '1', reason: '因'.repeat(201) })).toEqual({
      reason: '原因最多 200 个字',
    })
  })
})

describe('盘点提交', () => {
  it('变化量和确认时看到的当前库存一起提交', () => {
    const plan = adjustmentPlan(30, count('27'))
    if (!plan?.ok) throw new Error('plan')
    expect(adjustmentRequest('s1', plan, '月底盘点')).toEqual({
      stockItemId: 's1',
      quantityDelta: -3,
      reason: '月底盘点',
      expectedQuantity: 30,
    })
    const byDelta = adjustmentPlan(0, delta('+4'))
    if (!byDelta?.ok) throw new Error('plan')
    expect(adjustmentRequest('s2', byDelta, '补录')).toEqual({
      stockItemId: 's2',
      quantityDelta: 4,
      reason: '补录',
      expectedQuantity: 0,
    })
  })

  it('只有「库存已变化」的 409 才要求重读后重新确认', () => {
    const changed = new ApiError(409, 'stock_quantity_conflict', '库存已变化（现为 28 件），请重新核对后再盘点')
    expect(isStockChanged(changed)).toBe(true)
    expect(isStockChanged(new ApiError(409, 'insufficient_stock', '调整后库存会变成负数'))).toBe(false)
    expect(isStockChanged(new ApiError(409, 'idempotency_conflict', 'key already used'))).toBe(false)
    expect(isStockChanged(new Error('库存已变化'))).toBe(false)
  })
})
