import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { Order } from '../../api/orders'
import {
  initialRefundPayment,
  isVersionConflict,
  refundChoiceText,
  refundErrorMessage,
  refundFormSchema,
  restockText,
  returnableProducts,
  returnedCounts,
  returnedTotal,
  toRefundInput,
} from './refund'

// 3 包材料加一笔服务费；之前已经退回过 1 包。
const order: Pick<Order, 'lines' | 'refunds'> = {
  lines: [
    { productId: 'p-bead', name: '拼豆材料包', quantity: 2, unitPriceCents: 5000 },
    { name: '计时服务费', quantity: 1, unitPriceCents: 15000 },
    { productId: 'p-bead', name: '拼豆材料包', quantity: 1, unitPriceCents: 5000 },
    { productId: 'p-pen', name: '熨斗笔', quantity: 1, unitPriceCents: 2000 },
  ],
  refunds: [
    { id: 'r1', reason: '首次退货', amountCents: 5000, returnedProducts: { 'p-bead': 1 }, createdAt: 'x' },
    { id: 'r2', reason: '笔坏了', amountCents: 2000, returnedProducts: { 'p-pen': 1 }, createdAt: 'x' },
  ],
}

describe('可退件数', () => {
  it('同一商品分几行合计；扣掉以往退回的；服务费和已全部退回的不列', () => {
    expect(returnableProducts(order)).toEqual([
      { productId: 'p-bead', name: '拼豆材料包', sold: 3, returned: 1, remaining: 2 },
    ])
    expect(returnableProducts({ lines: [{ name: '计时', quantity: 1, unitPriceCents: 1 }] })).toEqual([])
  })
})

describe('退款表单', () => {
  const products = returnableProducts(order)
  const schema = refundFormSchema({ refundableCents: 25000, products })
  const errorsOf = (values: Parameters<typeof schema.safeParse>[0]) => {
    const result = schema.safeParse(values)
    return result.success
      ? {}
      : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
  }

  it('金额必填、最多两位小数、不超过接口给的可退金额', () => {
    expect(errorsOf({ amount: '', reason: '退货', returned: {} })).toEqual({
      amount: '请填写退款金额（元，最多两位小数）',
    })
    expect(errorsOf({ amount: '0', reason: '退货', returned: {} })).toHaveProperty('amount')
    expect(errorsOf({ amount: '1.234', reason: '退货', returned: {} })).toHaveProperty('amount')
    expect(errorsOf({ amount: '250.01', reason: '退货', returned: {} })).toEqual({
      amount: '超过这一笔还可退的 ¥250.00',
    })
    expect(errorsOf({ amount: '250', reason: '退货', returned: {} })).toEqual({})
  })

  it('原因必填（去掉空格后），最多 200 字', () => {
    expect(errorsOf({ amount: '10', reason: '   ', returned: {} })).toEqual({ reason: '请填写退款原因' })
    expect(errorsOf({ amount: '10', reason: '字'.repeat(201), returned: {} })).toEqual({
      reason: '退款原因最多 200 字',
    })
    expect(errorsOf({ amount: '10', reason: '字'.repeat(200), returned: {} })).toEqual({})
  })

  it('退回件数超过还可退的直接拦下，不悄悄改小；不是整数也拦', () => {
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '3' } })).toEqual({
      'returned.p-bead': '最多可退回 2 件',
    })
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '1.5' } })).toEqual({
      'returned.p-bead': '件数须为整数',
    })
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '2' } })).toEqual({})
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '' } })).toEqual({})
  })

  it('请求体：金额换整数分，原因去空格，只带大于 0 的件数，全是 0 时不带这个字段', () => {
    expect(toRefundInput({ amount: '100.5', reason: ' 未拆封退货 ', returned: { 'p-bead': '2' } }, products)).toEqual({
      amountCents: 10050,
      reason: '未拆封退货',
      returnedProducts: { 'p-bead': 2 },
    })
    expect(toRefundInput({ amount: '150', reason: '服务未提供', returned: { 'p-bead': '0' } }, products)).toEqual({
      amountCents: 15000,
      reason: '服务未提供',
    })
    // 按笔退：带上选的那一笔
    expect(toRefundInput({ amount: '40', reason: '朋友先走', returned: {} }, products, 'pay-2')).toEqual({
      paymentId: 'pay-2',
      amountCents: 4000,
      reason: '朋友先走',
    })
  })

  it('按笔退：页面指定的那笔还能退就选它；只有一笔能退时就是它；几笔都能退时让员工自己选', () => {
    const at = '2026-10-06T02:00:00Z'
    const choice = (id: string, refundableCents: number) => ({
      payment: {
        id,
        method: 'wechat' as const,
        amountCents: 5000,
        createdAt: at,
        refundedCents: 5000 - refundableCents,
      },
      refundableCents,
    })
    const two = [choice('a', 5000), choice('b', 2000)]
    expect(initialRefundPayment(two)).toBeUndefined()
    expect(initialRefundPayment(two, 'b')).toBe('b')
    expect(initialRefundPayment(two, 'gone')).toBeUndefined()
    expect(initialRefundPayment([choice('a', 5000)])).toBe('a')
    expect(initialRefundPayment([])).toBeUndefined()
    expect(refundChoiceText(choice('b', 2000))).toEqual({
      title: '微信 ¥50.00',
      extra: '2026-10-06 10:00 · 已退 ¥30.00 · 还可退 ¥20.00',
    })
  })

  it('按钮和确认弹窗只数合法的件数', () => {
    expect(returnedTotal(returnedCounts({ 'p-bead': '2' }, products))).toBe(2)
    expect(returnedTotal(returnedCounts({ 'p-bead': '9' }, products))).toBe(0)
    expect(returnedTotal(returnedCounts({ 'p-bead': 'abc' }, products))).toBe(0)
    expect(restockText({ 'p-bead': 2 }, products)).toBe('回补库存：拼豆材料包 2 件')
    expect(restockText({}, products)).toMatch(/^不回补库存/)
  })
})

describe('退款失败', () => {
  it('版本冲突和幂等键冲突都要重读后再确认', () => {
    expect(isVersionConflict(new ApiError(409, 'order_version_conflict', '订单已被修改'))).toBe(true)
    expect(isVersionConflict(new ApiError(409, 'idempotency_conflict', 'key already used'))).toBe(true)
    expect(isVersionConflict(new ApiError(409, 'loyalty_conflict', '会员结账请从会员管理办理退款'))).toBe(false)
    expect(refundErrorMessage(new ApiError(409, 'order_version_conflict', 'x'))).toMatch(/已保留/)
  })

  it('后端中文说明原样显示；英文的契约错误换成中文；结果未知时说明可以原样重试', () => {
    expect(refundErrorMessage(new ApiError(409, 'loyalty_conflict', '会员结账请从会员管理办理退款'))).toBe(
      '会员结账请从会员管理办理退款',
    )
    expect(refundErrorMessage(new ApiError(400, 'invalid_request', '退回数量超出本单已售数量'))).toBe(
      '退回数量超出本单已售数量',
    )
    expect(refundErrorMessage(new ApiError(403, 'forbidden', 'forbidden'))).toBe(
      '当前账号无权办理退款，需要店长或老板。',
    )
    expect(refundErrorMessage(new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试'))).toMatch(
      /^网络连接失败，请检查网络后重试。.*不会重复退款/,
    )
    expect(refundErrorMessage(new ApiError(503, 'persistence_failed', '数据没能保存，请重试。'))).toMatch(
      /^数据没能保存，请重试。不确定/,
    )
  })
})
