import { describe, expect, it } from 'vitest'
import {
  addScannedProduct,
  emptyPurchaseLine,
  lastCosts,
  prefillPurchase,
  purchaseDefaults,
  purchaseSchema,
  toPurchaseInput,
  unitCostAfterProductChange,
  type PurchaseFormValues,
} from './purchase'

const messages = (values: PurchaseFormValues) => {
  const result = purchaseSchema.safeParse(values)
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
}

describe('采购入库表单', () => {
  it('空表单：供应商、商品、单价都要填', () => {
    expect(messages(purchaseDefaults())).toEqual({
      supplierName: '请填写供应商',
      'lines.0.productId': '请选择商品',
      'lines.0.unitCost': '请填写采购单价',
    })
  })

  it('数量必须是正整数，单价按元最多两位小数，供应商和备注限长', () => {
    expect(
      messages({
        supplierName: '豆'.repeat(101),
        note: '备'.repeat(201),
        lines: [{ productId: 'p1', quantity: '1.5', unitCost: '1.234' }],
      }),
    ).toEqual({
      supplierName: '供应商最多 100 个字',
      note: '备注最多 200 个字',
      'lines.0.quantity': '数量填正整数',
      'lines.0.unitCost': '单价按元填写，最多两位小数',
    })
    expect(messages({ supplierName: '甲', note: '', lines: [] })).toEqual({ lines: '至少登记一种商品' })
  })

  it('同一商品分两行要求合并', () => {
    expect(
      messages({
        supplierName: '甲',
        note: '',
        lines: [
          { productId: 'p1', quantity: '1', unitCost: '1' },
          { productId: 'p2', quantity: '1', unitCost: '1' },
          { productId: 'p1', quantity: '2', unitCost: '1' },
        ],
      }),
    ).toEqual({ 'lines.2.productId': '和第 1 行是同一商品，请合并数量' })
  })

  it('转成接口请求体：数量整数、单价整数分（不用浮点）；备注为空不传；赠品单价可以为 0', () => {
    const values: PurchaseFormValues = {
      supplierName: '  义乌豆子批发 ',
      note: ' ',
      lines: [
        { productId: 'p1', quantity: '12', unitCost: '0.29' },
        { productId: 'p2', quantity: '3', unitCost: '0' },
      ],
    }
    expect(messages(values)).toEqual({})
    expect(toPurchaseInput(values)).toEqual({
      supplierName: '义乌豆子批发',
      items: [
        { productId: 'p1', quantity: 12, unitCostCents: 29 },
        { productId: 'p2', quantity: 3, unitCostCents: 0 },
      ],
    })
    expect(toPurchaseInput({ ...values, note: ' 发票 0921 ' }).note).toBe('发票 0921')
  })

  it('从库存表点「入库」进来时预选商品', () => {
    expect(purchaseDefaults('p9').lines).toEqual([{ productId: 'p9', quantity: '1', unitCost: '' }])
  })
})

describe('入库预填（后端给的上次供应商与进价）', () => {
  const prefill = {
    supplierName: '义乌豆子批发',
    lastUnitCosts: [
      { productId: 'p1', unitCostCents: 29 },
      { productId: 'p2', unitCostCents: 800 },
    ],
  }
  const costs = lastCosts(prefill)

  it('打开表单：空着的供应商填最近一次的；预选了商品、进价空着的行填上次进价', () => {
    expect(prefillPurchase(purchaseDefaults('p1'), prefill)).toEqual({
      supplierName: '义乌豆子批发',
      note: '',
      lines: [{ productId: 'p1', quantity: '1', unitCost: '0.29' }],
    })
    // 没入过库的商品、没选商品的行不填
    expect(prefillPurchase(purchaseDefaults('p9'), prefill).lines[0].unitCost).toBe('')
    expect(prefillPurchase(purchaseDefaults(), prefill).lines[0].unitCost).toBe('')
    // 还没入过库：没有供应商，什么都不填
    expect(prefillPurchase(purchaseDefaults('p1'), { lastUnitCosts: [] })).toEqual(purchaseDefaults('p1'))
    expect(prefillPurchase(purchaseDefaults('p1'), undefined)).toEqual(purchaseDefaults('p1'))
  })

  it('员工已经填了的不覆盖', () => {
    const typed: PurchaseFormValues = {
      supplierName: '本地文具店',
      note: '',
      lines: [{ productId: 'p1', quantity: '2', unitCost: '0.35' }],
    }
    expect(prefillPurchase(typed, prefill)).toEqual(typed)
  })

  it('某行换商品：空着的填这件商品上次的进价；员工填的不动；上一件预填的价跟着换', () => {
    expect(unitCostAfterProductChange('', '', 'p1', costs)).toBe('0.29')
    expect(unitCostAfterProductChange('', '', 'p9', costs)).toBe('')
    expect(unitCostAfterProductChange('1.00', '', 'p1', costs)).toBe('1.00')
    expect(unitCostAfterProductChange('1.00', 'p1', 'p2', costs)).toBe('1.00')
    // 0.29 是 p1 预填进来的：换成 p2 的 8.00；换成没入过库的商品就清空，不把别的商品的价留下
    expect(unitCostAfterProductChange('0.29', 'p1', 'p2', costs)).toBe('8.00')
    expect(unitCostAfterProductChange('0.29', 'p1', 'p9', costs)).toBe('')
  })
})

describe('手机转来的商品条码', () => {
  const costs = new Map([['p-bead', 850]])
  it('已有这件商品的行数量 +1；数量格正在改、不是正整数时按 1 算', () => {
    const lines = [
      { productId: 'p-other', quantity: '2', unitCost: '1.00' },
      { productId: 'p-bead', quantity: '3', unitCost: '9.00' },
    ]
    expect(addScannedProduct(lines, 'p-bead', costs)).toEqual({
      lines: [lines[0], { productId: 'p-bead', quantity: '4', unitCost: '9.00' }],
      index: 1,
      merged: true,
    })
    expect(addScannedProduct([{ ...lines[1], quantity: '' }], 'p-bead', costs).lines[0].quantity).toBe('1')
  })

  it('填进最前面的空行，进价按上次的预填、员工已填的不动；没有空行就加在末尾，没入过库的进价留空', () => {
    const blank = emptyPurchaseLine()
    expect(addScannedProduct([blank], 'p-bead', costs)).toEqual({
      lines: [{ productId: 'p-bead', quantity: '1', unitCost: '8.50' }],
      index: 0,
      merged: false,
    })
    expect(addScannedProduct([{ ...blank, unitCost: '7' }], 'p-bead', costs).lines[0].unitCost).toBe('7')
    const filled = [{ productId: 'p-bead', quantity: '1', unitCost: '8.50' }]
    expect(addScannedProduct(filled, 'p-new', costs)).toEqual({
      lines: [...filled, { productId: 'p-new', quantity: '1', unitCost: '' }],
      index: 1,
      merged: false,
    })
  })
})
