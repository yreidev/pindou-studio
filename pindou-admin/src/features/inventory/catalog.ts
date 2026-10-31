import { z } from 'zod'
import type { CatalogInput, CatalogItem, CatalogPatch } from '../../api/inventory'
import { parseYuan, yuanInput } from '../../lib/format'
import { charCount } from './fields'

// 商品资料：名称、参考售价和条码。参考售价只预填结账新明细，不改历史订单（后端保证）。

export interface CatalogFormValues {
  name: string
  price: string
  /** 商品条码，可空；柜台扫码枪对着这一格扫一下就填上了。 */
  barcode: string
}

export function catalogDefaults(item?: CatalogItem): CatalogFormValues {
  return item
    ? { name: item.name, price: yuanInput(item.unitPriceCents), barcode: item.barcode ?? '' }
    : { name: '', price: '', barcode: '' }
}

const normalized = (name: string) => name.trim().toLocaleLowerCase('zh-CN')

/**
 * 条码的写法，和后端一致：去掉首尾空白后是 1–64 个可打印 ASCII（英文字母、数字、符号，不含空格），
 * 覆盖 EAN-13、UPC、Code128，区分大小写；空着表示没有条码。这里只是提前提示，以后端为准。
 */
export function validBarcode(text: string): boolean {
  const code = text.trim()
  return code === '' || /^[!-~]{1,64}$/.test(code)
}

export const barcodeRule = '条码只能是 1–64 位英文字母、数字或符号，不能有空格或中文'

/**
 * existing 是现有商品，editingId 是正在改的那个（新增时不传）。
 * 名称和别的商品重复时拦下：结账、采购的下拉框里分不清是哪一个。改价时名称没动不查重，
 * 免得历史上已有的重名商品连价格都改不了。
 * 条码被别的商品占用不在这里查：以后端为准（409 barcode_taken 会说清被哪件商品占了）。
 */
export function catalogSchema(existing: CatalogItem[], editing?: CatalogItem) {
  return z.object({
    name: z
      .string()
      .refine((value) => value.trim() !== '', '请填写商品名称')
      .refine((value) => charCount(value.trim()) <= 100, '商品名称最多 100 个字')
      .refine(
        (value) =>
          value.trim() === '' ||
          value.trim() === editing?.name.trim() ||
          !existing.some((item) => item.id !== editing?.id && normalized(item.name) === normalized(value)),
        '已有同名商品',
      ),
    price: z
      .string()
      .refine((value) => value.trim() !== '', '请填写参考售价')
      .refine((value) => value.trim() === '' || parseYuan(value) !== null, '售价按元填写，最多两位小数'),
    barcode: z.string().refine(validBarcode, barcodeRule),
  })
}

function priceCents(values: CatalogFormValues): number {
  const unitPriceCents = parseYuan(values.price)
  if (unitPriceCents === null) throw new Error('参考售价未通过校验')
  return unitPriceCents
}

/** 新增商品的请求体：没填条码就不带。 */
export function toCatalogInput(values: CatalogFormValues): CatalogInput {
  const barcode = values.barcode.trim()
  return { name: values.name.trim(), unitPriceCents: priceCents(values), ...(barcode ? { barcode } : {}) }
}

/**
 * 修改商品资料的请求体：名称、售价照旧带上；条码只在改过时带（清空即发空串，后端清除），
 * 没动条码的修改和以前的请求一样。
 */
export function toCatalogPatch(values: CatalogFormValues, item: CatalogItem): CatalogPatch {
  const barcode = values.barcode.trim()
  return {
    name: values.name.trim(),
    unitPriceCents: priceCents(values),
    ...(barcode !== (item.barcode ?? '') ? { barcode } : {}),
  }
}
