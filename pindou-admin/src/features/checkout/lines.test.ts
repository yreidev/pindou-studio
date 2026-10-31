import { describe, expect, it } from 'vitest'
import type { Order } from '../../api/orders'
import {
  blankLine,
  hasUnpricedLine,
  hasUnsavedLines,
  lineErrors,
  linesSchema,
  orderLines,
  parseQuantity,
  productLine,
  toOrderLines,
} from './lines'

const order = (lines: Order['lines']): Pick<Order, 'lines'> => ({ lines })

describe('订单明细：元↔分只做换算', () => {
  it('订单明细换成编辑用的行：单价写成元', () => {
    expect(
      orderLines(
        order([
          { productId: 'p1', name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
          { name: '计时 60 分钟', quantity: 1, unitPriceCents: 0 },
          { name: '续时', quantity: 1, unitPriceCents: 5 },
        ]),
      ),
    ).toEqual([
      { productId: 'p1', name: '拼豆材料包', quantity: '2', unitPriceYuan: '20.00' },
      { productId: '', name: '计时 60 分钟', quantity: '1', unitPriceYuan: '0.00' },
      { productId: '', name: '续时', quantity: '1', unitPriceYuan: '0.05' },
    ])
  })

  it('从商品目录加一行：名称、单价预填商品资料；没名称的商品用编号', () => {
    expect(productLine({ id: 'p1', name: '钥匙扣', unitPriceCents: 1290 })).toEqual({
      productId: 'p1',
      name: '钥匙扣',
      quantity: '1',
      unitPriceYuan: '12.90',
    })
    expect(productLine({ id: 'abcdef123456', name: '', unitPriceCents: 0 }).name).toBe('未命名商品 · abcdef12')
  })

  it('保存时元换成整数分，不经过浮点；商品编号、名称为空时不带', () => {
    expect(
      toOrderLines([
        { productId: 'p1', name: ' 拼豆材料包 ', quantity: '2', unitPriceYuan: '19.99' },
        { productId: '', name: '计时服务费', quantity: '1', unitPriceYuan: '0.1' },
        { productId: 'p2', name: '', quantity: '3', unitPriceYuan: '0' },
      ]),
    ).toEqual([
      { productId: 'p1', name: '拼豆材料包', quantity: 2, unitPriceCents: 1999 },
      { name: '计时服务费', quantity: 1, unitPriceCents: 10 },
      { productId: 'p2', quantity: 3, unitPriceCents: 0 },
    ])
    expect(() => toOrderLines([])).toThrow('请至少填写一项订单明细')
    expect(() => toOrderLines([{ ...blankLine(), name: '服务', unitPriceYuan: '1.234' }])).toThrow('请检查第 1 项明细')
  })

  it('逐项指出问题：名称或商品至少一样、数量是正整数、单价最多两位小数', () => {
    expect(lineErrors({ productId: '', name: ' ', quantity: '0', unitPriceYuan: '-1' })).toEqual({
      name: '请填写服务名称或选择商品',
      quantity: '数量须为大于零的整数',
      price: '单价须为非负金额，最多两位小数',
    })
    expect(lineErrors({ productId: 'p1', name: '', quantity: '2', unitPriceYuan: '0' })).toEqual({})
    for (const bad of ['', '1.5', '-2', 'abc', '1e3']) expect(parseQuantity(bad)).toBeNull()
    expect(parseQuantity(' 12 ')).toBe(12)
    // 数量乘单价超出安全整数：多半是填错了
    expect(lineErrors({ productId: '', name: '服务', quantity: '999999999', unitPriceYuan: '999999999.99' })).toEqual({
      quantity: '数量或单价过大，请核对',
    })
  })

  it('表单校验把错误落到对应的那一格', () => {
    const result = linesSchema.safeParse({
      lines: [
        { productId: '', name: '服务', quantity: '1', unitPriceYuan: '10' },
        { productId: '', name: '', quantity: 'x', unitPriceYuan: '10' },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['lines.1.name', '请填写服务名称或选择商品'],
      ['lines.1.quantity', '数量须为大于零的整数'],
    ])
    expect(linesSchema.safeParse({ lines: [] }).error?.issues[0].message).toBe('请至少填写一项订单明细')
  })

  it('改过、加过、删过都算没保存；原样不算', () => {
    const saved = order([{ productId: 'p1', name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 }])
    const lines = orderLines(saved)
    expect(hasUnsavedLines(saved, lines)).toBe(false)
    expect(hasUnsavedLines(saved, [{ ...lines[0], quantity: '3' }])).toBe(true)
    expect(hasUnsavedLines(saved, [...lines, blankLine()])).toBe(true)
    expect(hasUnsavedLines(saved, [])).toBe(true)
  })

  it('单价为 0 的占位行：收款前要填价', () => {
    expect(hasUnpricedLine(order([{ name: '计时 75 分钟', quantity: 1, unitPriceCents: 0 }]))).toBe(true)
    expect(hasUnpricedLine(order([{ name: '计时 60 分钟', quantity: 1, unitPriceCents: 6000 }]))).toBe(false)
  })
})
