import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import type { Role } from './customer'
import { money } from './format'
import { decimalHundredths, integerInput } from './staff-workflow'
import { catalogLabel, queryString, request, type CatalogItem } from './staff'

// 手机上的「收货入库」（2026-10-06 业主改定）：货到时扫商品条码或按名称搜，一张入库单可含多行，
// 提交一次 POST /stock-receipts。商品资料、盘点、库存流水仍在电脑后台。
// 库存、上次进价、最近的供应商都以接口为准，本机不记；入库成功后重读。

type Schemas = components['schemas']
export type StockItem = Schemas['StockItem']
export type PurchasePrefill = Schemas['PurchasePrefill']
export type PurchaseInput = Schemas['PurchaseInput']

export const receiving = {
  catalog: () => request<CatalogItem[]>('/catalog-items'),
  stock: () => request<StockItem[]>('/stock-items'),
  /** 最近一次入库的供应商、每件商品上次的进价（后端从采购单现算）。 */
  prefill: () => request<PurchasePrefill>('/stock-receipts/prefill'),
  /** 按条码精确找商品：找到是只有一件的列表，没登记过是空列表。 */
  findByBarcode: (barcode: string) => request<CatalogItem[]>(`/catalog-items?${queryString({ barcode })}`),
  /** 店长、老板把条码登记到一件已有商品上：只带 barcode，不动名称和售价。被占用时后端回 409 barcode_taken。 */
  bindBarcode: (productId: string, barcode: string) =>
    request<CatalogItem>(
      `/catalog-items/${encodeURIComponent(productId)}`,
      'PATCH',
      { barcode } satisfies Schemas['CatalogPatch'],
      true,
    ),
  /**
   * 提交一张入库单。带幂等键；结果未知时 services/staff.ts 记下原请求，再点同一按钮先原样重发它，
   * 上次已生效就抛 previous_applied（「上次已生效」），不再提交这一次。
   */
  submit: (body: PurchaseInput) => request<Schemas['PurchaseReceipt']>('/stock-receipts', 'POST', body, true),
}

/** 条码最长 64 位，和后端一致。 */
export const maxBarcodeLength = 64

/**
 * 规范扫到或输入的条码，规则同后端：去掉首尾空白，余下须为 1–64 个可打印 ASCII（不含空格），
 * 覆盖 EAN-13、UPC、Code128，区分大小写。空的返回空串，格式不对返回 null。
 */
export function barcodeOf(raw: string): string | null {
  const code = (raw || '').trim()
  if (!code) return ''
  return code.length <= maxBarcodeLength && /^[!-~]+$/.test(code) ? code : null
}

/** 能当场把没登记的条码绑到已有商品上的角色：店长、老板（后端同样只允许他们改商品资料）。 */
export const canBindBarcode = (roles: readonly Role[]) => roles.includes('manager') || roles.includes('owner')

export const unboundBarcodeMessage = '这个条码还没登记到商品，请店长或老板绑定'

export type ScanOutcome =
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'found'; item: CatalogItem }
  /** 条码没登记过：店长、老板可以当场绑定到已有商品（canBind），店员只能请他们来绑。 */
  | { kind: 'unknown'; barcode: string; canBind: boolean }

type ScanResult = { result?: string }

/**
 * 扫一个商品条码并按条码找商品。只用相机，一维码为主，二维码也接受（内容合乎条码规则才算）。
 * 取消扫码不提示；扫到的不是条码、查询失败都给出要显示的话。
 */
export async function scanProduct(
  roles: readonly Role[],
  scan: () => Promise<ScanResult> = () => Taro.scanCode({ onlyFromCamera: true, scanType: ['barCode', 'qrCode'] }),
  find: (barcode: string) => Promise<CatalogItem[]> = receiving.findByBarcode,
): Promise<ScanOutcome> {
  let scanned: ScanResult
  try {
    scanned = await scan()
  } catch (error) {
    if (/cancel/.test((error as { errMsg?: string } | undefined)?.errMsg || '')) return { kind: 'cancelled' }
    return { kind: 'error', message: '没有扫到条码，请对准商品条码再试一次' }
  }
  const barcode = barcodeOf(scanned.result || '')
  if (!barcode)
    return { kind: 'error', message: '扫到的不是商品条码：条码只能是 1–64 位英文字母、数字或符号，不能有空格或中文' }
  let found: CatalogItem[]
  try {
    found = await find(barcode)
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : '查找商品失败，请稍后重试' }
  }
  return found[0] ? { kind: 'found', item: found[0] } : { kind: 'unknown', barcode, canBind: canBindBarcode(roles) }
}

/** 收货单上的一行。数量、进价是输入框里的文字，提交时才换成整数（进价换成分）。 */
export type ReceiptRow = { productId: string; quantity: string; costYuan: string }

/** 这件商品上次入库的进价（分）；没入过库为 undefined。 */
export function lastUnitCost(prefill: PurchasePrefill | null, productId: string): number | undefined {
  return prefill?.lastUnitCosts.find((entry) => entry.productId === productId)?.unitCostCents
}

/**
 * 把一件商品加进收货单。已经有这件商品的行（扫同一条码再扫一次、或又搜了一次）：那一行数量 +1；
 * 没有：末尾加一行，数量 1，进价预填这件商品上次入库的进价，没有记录留空（必须填）。
 */
export function addProduct(
  rows: readonly ReceiptRow[],
  productId: string,
  prefill: PurchasePrefill | null,
): { rows: ReceiptRow[]; merged: boolean } {
  const index = rows.findIndex((row) => row.productId === productId)
  if (index >= 0) {
    const bump = (text: string) => (/^\d+$/.test(text.trim()) ? String(Number(text.trim()) + 1) : '1')
    return { rows: rows.map((row, i) => (i === index ? { ...row, quantity: bump(row.quantity) } : row)), merged: true }
  }
  const cost = lastUnitCost(prefill, productId)
  return {
    rows: [...rows, { productId, quantity: '1', costYuan: cost === undefined ? '' : money(cost) }],
    merged: false,
  }
}

/** 一行的数量、进价上限，与后端一致：挡住多按几个 0 这类手误。 */
export const maxReceiptQuantity = 1_000_000
export const maxUnitCostCents = 100_000_000

export function rowErrors(row: ReceiptRow): { quantity?: string; cost?: string } {
  const errors: { quantity?: string; cost?: string } = {}
  try {
    integerInput(row.quantity, 1, maxReceiptQuantity)
  } catch {
    errors.quantity = `数量须为 1 到 ${maxReceiptQuantity} 的整数`
  }
  if (!row.costYuan.trim()) errors.cost = '请填写进价（元），没有入库记录可预填'
  else
    try {
      if (decimalHundredths(row.costYuan, true) > maxUnitCostCents)
        errors.cost = `进价不能超过 ¥${money(maxUnitCostCents)}`
    } catch {
      errors.cost = '进价须为不小于 0 的金额，最多两位小数'
    }
  return errors
}

const valid = (row: ReceiptRow) => {
  const errors = rowErrors(row)
  return !errors.quantity && !errors.cost
}

/**
 * 合计件数与金额（整数分，只作展示：数量 × 进价逐行相乘再相加，不经浮点）。
 * 有填错的行不计入，complete 为 false，页面据此说明合计不全。
 */
export function receiptTotals(rows: readonly ReceiptRow[]): { quantity: number; cents: number; complete: boolean } {
  let quantity = 0,
    cents = 0,
    complete = true
  for (const row of rows) {
    if (!valid(row)) {
      complete = false
      continue
    }
    const count = integerInput(row.quantity, 1, maxReceiptQuantity)
    quantity += count
    cents += count * decimalHundredths(row.costYuan, true)
  }
  return { quantity, cents, complete }
}

const characters = (text: string) => [...text].length

/** 提交的请求体。供应商必填（去首尾空白，最多 100 字），备注选填（最多 200 字），至少一行且每行都填对；不对就抛出要显示的话。 */
export function receiptBody(
  supplier: string,
  note: string,
  rows: readonly ReceiptRow[],
  catalog: readonly CatalogItem[] = [],
): PurchaseInput {
  const supplierName = supplier.trim()
  if (!supplierName) throw new Error('请填写供应商')
  if (characters(supplierName) > 100) throw new Error('供应商最多 100 个字')
  const text = note.trim()
  if (characters(text) > 200) throw new Error('备注最多 200 个字')
  if (!rows.length) throw new Error('请先扫码或按名称搜索，添加要入库的商品')
  const items = rows.map((row, index) => {
    const errors = rowErrors(row)
    const problem = errors.quantity || errors.cost
    if (problem) {
      const item = catalog.find((entry) => entry.id === row.productId)
      throw new Error(`第 ${index + 1} 行${item ? `（${catalogLabel(item)}）` : ''}：${problem}`)
    }
    return {
      productId: row.productId,
      quantity: integerInput(row.quantity, 1, maxReceiptQuantity),
      unitCostCents: decimalHundredths(row.costYuan, true),
    }
  })
  return { supplierName, ...(text ? { note: text } : {}), items }
}

/**
 * 按名称（不分大小写，包含即可）或条码（区分大小写，开头相同）在目录里找：相机扫不出时手输条码也能找到。
 * 没输关键字时不列：目录会越来越长，手机上一屏摆不下。没有名称的历史占位商品按「未命名商品」显示。
 */
export function searchCatalog(catalog: readonly CatalogItem[], keyword: string, limit = 20): CatalogItem[] {
  const typed = keyword.trim()
  const word = typed.toLowerCase()
  if (!word) return []
  return catalog
    .filter((item) => catalogLabel(item).toLowerCase().includes(word) || (item.barcode || '').startsWith(typed))
    .slice(0, limit)
}
