import { z } from 'zod'
import type { OrderLineInput } from '../../api/checkout'
import type { CatalogItem } from '../../api/inventory'
import type { Order } from '../../api/orders'
import { parseYuan, yuanInput } from '../../lib/format'
import { productName } from '../inventory/products'

// 结账页的订单明细，规则照搬小程序结账页（services/staff-workflow.ts）：
// - 一行是商品目录里的商品（收款时扣库存），或自定义服务（计时、服务费，不扣库存）；
// - 名称和商品至少有一样，数量是不小于 1 的整数，单价是元（最多两位小数，可以是 0），只做元↔分换算；
// - 改过的明细要先保存（整份替换），应收由后端按保存后的明细重新算，前端不加总、不估算；
// - 计时会话自动生成的行（套餐、续时、单价为 0 的占位行）和别的行一样：占位行填上单价再保存。

/** 编辑中的一行。数量、单价是输入框里的文字，保存时再换成整数。 */
export interface DraftLine {
  productId: string
  name: string
  quantity: string
  unitPriceYuan: string
}

export const blankLine = (): DraftLine => ({ productId: '', name: '', quantity: '1', unitPriceYuan: '' })

/** 从商品目录加一行：名称、单价预填商品资料里的（参考售价只预填新明细，不追改历史订单）。 */
export const productLine = (item: CatalogItem): DraftLine => ({
  productId: item.id,
  name: productName(item, item.id),
  quantity: '1',
  unitPriceYuan: yuanInput(item.unitPriceCents),
})

/** 订单里已保存的明细 → 编辑用的行。 */
export function orderLines(order: Pick<Order, 'lines'>): DraftLine[] {
  return (order.lines ?? []).map((line) => ({
    productId: line.productId ?? '',
    name: line.name ?? '',
    quantity: String(line.quantity),
    unitPriceYuan: yuanInput(line.unitPriceCents),
  }))
}

/** 明细和订单里保存的不一样（改过、加过、删过）：要先保存，才能打折、收款。 */
export function hasUnsavedLines(order: Pick<Order, 'lines'>, lines: readonly DraftLine[]): boolean {
  return JSON.stringify(orderLines(order)) !== JSON.stringify(lines.map(normalized))
}

const normalized = (line: DraftLine): DraftLine => ({
  productId: line.productId,
  name: line.name,
  quantity: line.quantity,
  unitPriceYuan: line.unitPriceYuan,
})

const quantityPattern = /^\d{1,9}$/

/** 数量：不小于 1 的整数；不合法返回 null。 */
export function parseQuantity(text: string): number | null {
  const value = text.trim()
  if (!quantityPattern.test(value)) return null
  const quantity = Number(value)
  return quantity >= 1 ? quantity : null
}

export interface LineErrors {
  name?: string
  quantity?: string
  price?: string
}

/** 一行的问题，逐项给出；没有问题返回空对象。 */
export function lineErrors(line: DraftLine): LineErrors {
  const errors: LineErrors = {}
  if (!line.name.trim() && !line.productId.trim()) errors.name = '请填写服务名称或选择商品'
  const quantity = parseQuantity(line.quantity)
  const price = parseYuan(line.unitPriceYuan)
  if (quantity === null) errors.quantity = '数量须为大于零的整数'
  if (price === null) errors.price = '单价须为非负金额，最多两位小数'
  // 两个都合法时，数量乘单价也得是安全整数（后端按整数分相乘），否则就是填错了
  if (quantity !== null && price !== null && !Number.isSafeInteger(quantity * price))
    errors.quantity = '数量或单价过大，请核对'
  return errors
}

/** 明细表单的校验：至少一行，逐行逐项报错（路径 lines[i].字段，表单上对应到那一格）。 */
export const linesSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: z.string(),
        name: z.string(),
        quantity: z.string(),
        unitPriceYuan: z.string(),
      }),
    )
    .superRefine((lines, ctx) => {
      if (!lines.length) ctx.addIssue({ code: 'custom', message: '请至少填写一项订单明细' })
      lines.forEach((line, index) => {
        const errors = lineErrors(line)
        if (errors.name) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: errors.name })
        if (errors.quantity) ctx.addIssue({ code: 'custom', path: [index, 'quantity'], message: errors.quantity })
        if (errors.price) ctx.addIssue({ code: 'custom', path: [index, 'unitPriceYuan'], message: errors.price })
      })
    }),
})

/** 校验通过的行 → 接口的明细（整数分）。有不合法的行直接抛错，不悄悄改数。 */
export function toOrderLines(lines: readonly DraftLine[]): OrderLineInput[] {
  if (!lines.length) throw new Error('请至少填写一项订单明细')
  return lines.map((line, index) => {
    const quantity = parseQuantity(line.quantity)
    const unitPriceCents = parseYuan(line.unitPriceYuan)
    if (Object.keys(lineErrors(line)).length || quantity === null || unitPriceCents === null)
      throw new Error(`请检查第 ${index + 1} 项明细`)
    const productId = line.productId.trim()
    const name = line.name.trim()
    return {
      ...(productId ? { productId } : {}),
      ...(name ? { name } : {}),
      quantity,
      unitPriceCents,
    }
  })
}

/** 还没填单价的行（单价为 0，多是计时会话对不上套餐时生成的占位行）。收款按钮据此说明为什么不能收。 */
export function hasUnpricedLine(order: Pick<Order, 'lines'>): boolean {
  return (order.lines ?? []).some((line) => line.unitPriceCents === 0)
}
