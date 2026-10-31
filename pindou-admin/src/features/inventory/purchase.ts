import { z } from 'zod'
import type { PurchaseInput, PurchasePrefill } from '../../api/inventory'
import { parseYuan, yuanInput } from '../../lib/format'
import { charCount, positiveInteger } from './fields'

// 采购入库表单：供应商、备注、若干条明细（商品、数量、单价）。输入框里都是文字，
// 校验通过后再转成接口要的整数（数量是件数，单价是整数分，用 parseYuan，不用 parseFloat）。

export interface PurchaseLineValues {
  productId: string
  quantity: string
  unitCost: string
}

export interface PurchaseFormValues {
  supplierName: string
  note: string
  lines: PurchaseLineValues[]
}

export const emptyPurchaseLine = (productId = ''): PurchaseLineValues => ({ productId, quantity: '1', unitCost: '' })

export function purchaseDefaults(productId?: string): PurchaseFormValues {
  return { supplierName: '', note: '', lines: [emptyPurchaseLine(productId ?? '')] }
}

const lineSchema = z.object({
  productId: z.string().min(1, '请选择商品'),
  quantity: z.string().refine((value) => positiveInteger(value) !== null, '数量填正整数'),
  unitCost: z
    .string()
    .refine((value) => value.trim() !== '', '请填写采购单价')
    .refine((value) => value.trim() === '' || parseYuan(value) !== null, '单价按元填写，最多两位小数'),
})

export const purchaseSchema = z
  .object({
    supplierName: z
      .string()
      .refine((value) => value.trim() !== '', '请填写供应商')
      .refine((value) => charCount(value.trim()) <= 100, '供应商最多 100 个字'),
    note: z.string().refine((value) => charCount(value.trim()) <= 200, '备注最多 200 个字'),
    lines: z.array(lineSchema).min(1, '至少登记一种商品'),
  })
  .superRefine((value, ctx) => {
    // 同一商品分两行登记容易看漏，要求合并成一行
    const seen = new Map<string, number>()
    value.lines.forEach((line, index) => {
      if (!line.productId) return
      const first = seen.get(line.productId)
      if (first === undefined) seen.set(line.productId, index)
      else
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'productId'],
          message: `和第 ${first + 1} 行是同一商品，请合并数量`,
        })
    })
  })

/** 校验通过的表单 → 接口请求体。备注为空时不传。 */
export function toPurchaseInput(values: PurchaseFormValues): PurchaseInput {
  const note = values.note.trim()
  return {
    supplierName: values.supplierName.trim(),
    ...(note ? { note } : {}),
    items: values.lines.map((line) => {
      const quantity = positiveInteger(line.quantity)
      const unitCostCents = parseYuan(line.unitCost)
      if (quantity === null || unitCostCents === null) throw new Error('采购明细未通过校验')
      return { productId: line.productId, quantity, unitCostCents }
    }),
  }
}

// 预填：最近一次入库的供应商、每件商品上次的进价，数据由后端给（GET /stock-receipts/prefill），
// 前端不在本机记。只填空着的格，员工已经填了的一律不动。

/** 每件商品上次的进价（整数分），按商品编号查。 */
export function lastCosts(prefill: PurchasePrefill | undefined): Map<string, number> {
  return new Map((prefill?.lastUnitCosts ?? []).map((cost) => [cost.productId, cost.unitCostCents]))
}

/**
 * 表单开始时（打开页面、提交成功清空后）套用预填：供应商空着就填最近一次的供应商；
 * 已选了商品、进价空着的行填这件商品上次的进价。其余原样返回。
 */
export function prefillPurchase(values: PurchaseFormValues, prefill: PurchasePrefill | undefined): PurchaseFormValues {
  if (!prefill) return values
  const costs = lastCosts(prefill)
  return {
    ...values,
    supplierName: values.supplierName.trim() ? values.supplierName : (prefill.supplierName ?? values.supplierName),
    lines: values.lines.map((line) => {
      const cost = costs.get(line.productId)
      return line.productId && !line.unitCost.trim() && cost !== undefined
        ? { ...line, unitCost: yuanInput(cost) }
        : line
    }),
  }
}

/**
 * 某行换了商品之后的进价：员工自己填的不动；空着的、或者还是上一件商品预填进来的价，换成这件商品上次的进价
 * （没入过库的留空让员工填）。
 */
export function unitCostAfterProductChange(
  current: string,
  previousProductId: string,
  nextProductId: string,
  costs: Map<string, number>,
): string {
  const previous = costs.get(previousProductId)
  const prefilled = previousProductId !== '' && previous !== undefined && current === yuanInput(previous)
  if (current.trim() !== '' && !prefilled) return current
  const next = costs.get(nextProductId)
  return next === undefined ? '' : yuanInput(next)
}

/**
 * 手机「扫码给电脑」转来一件商品的条码（2026-10-06）：已有这件商品的行数量 +1；有还没选商品的空行就填进
 * 最前面那一行（进价按这件商品上次的预填，没入过库留空）；都没有就在末尾加一行。返回新的明细、落在第几行（从 0 起）
 * 和是不是加在已有的行上。数量格里不是正整数时（员工正在改）按 1 重新算，不硬加。
 */
export function addScannedProduct(
  lines: readonly PurchaseLineValues[],
  productId: string,
  costs: Map<string, number>,
): { lines: PurchaseLineValues[]; index: number; merged: boolean } {
  const existing = lines.findIndex((line) => line.productId === productId)
  if (existing >= 0) {
    const quantity = positiveInteger(lines[existing].quantity)
    return {
      lines: lines.map((line, i) => (i === existing ? { ...line, quantity: String((quantity ?? 0) + 1) } : line)),
      index: existing,
      merged: true,
    }
  }
  const cost = costs.get(productId)
  const filled = (line: PurchaseLineValues): PurchaseLineValues => ({
    ...line,
    productId,
    unitCost: line.unitCost.trim() || cost === undefined ? line.unitCost : yuanInput(cost),
  })
  const empty = lines.findIndex((line) => !line.productId)
  if (empty >= 0)
    return { lines: lines.map((line, i) => (i === empty ? filled(line) : line)), index: empty, merged: false }
  return { lines: [...lines, filled(emptyPurchaseLine())], index: lines.length, merged: false }
}
