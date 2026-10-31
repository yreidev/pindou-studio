import type { CatalogItem, StockItem } from '../../api/inventory'

// 库存列表只有商品编号，名称要从商品资料里找；历史上只入过库、没建资料的商品名称为空。
// 这里只做查找、筛选和排序，数量、是否偏低都原样用接口给的。

/** 商品显示名：没有名称时用「未命名商品 · 编号前 8 位」，和小程序一致。 */
export function productName(item: Pick<CatalogItem, 'name'> | undefined, productId: string): string {
  return item?.name.trim() || `未命名商品 · ${productId.slice(0, 8)}`
}

export function catalogIndex(catalog: CatalogItem[] | undefined): Map<string, CatalogItem> {
  return new Map((catalog ?? []).map((item) => [item.id, item]))
}

/** 关键字匹配：忽略首尾空格和大小写；空关键字匹配全部。 */
export function matchesKeyword(text: string, keyword: string | undefined): boolean {
  const needle = (keyword ?? '').trim().toLocaleLowerCase('zh-CN')
  return !needle || text.toLocaleLowerCase('zh-CN').includes(needle)
}

/** 条码精确匹配：去掉首尾空白（扫码枪会带回车）后整串相同，区分大小写；空的不算。 */
export function matchesBarcode(barcode: string | undefined, text: string | undefined): boolean {
  const code = (text ?? '').trim()
  return Boolean(code) && barcode === code
}

/** 按条码找商品（同一条码后端只许属于一件商品）。 */
export function findByBarcode(catalog: CatalogItem[] | undefined, text: string): CatalogItem | undefined {
  return (catalog ?? []).find((item) => matchesBarcode(item.barcode, text))
}

/**
 * 采购入库选商品的下拉框的搜索（Semi Select 的 filter 函数）：输入正好是某件商品的条码时只列这一件——
 * Semi 默认高亮第一项、回车选中高亮项，所以柜台的 USB 扫码枪对着搜索框扫一下（键入条码再回车）就选中它；
 * 否则按商品名包含匹配，忽略大小写。
 */
export function productFilter(catalog: CatalogItem[] | undefined) {
  return (input: string, option: { value?: unknown; label?: unknown }): boolean => {
    const scanned = findByBarcode(catalog, input)
    if (scanned) return option.value === scanned.id
    return matchesKeyword(String(option.label ?? ''), input)
  }
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
  a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id)

export interface StockRow extends StockItem {
  name: string
  /** 商品资料里有名称；没有时 name 是「未命名商品 · 编号」 */
  named: boolean
  /** 商品条码；没登记时没有。 */
  barcode?: string
}

/**
 * 库存表的行：带上商品名和条码，按关键字（商品名包含，或正好是条码）和「只看预警」筛选，
 * 按名称排序（接口返回的顺序不固定）。
 */
export function stockRows(
  stock: StockItem[] | undefined,
  catalog: CatalogItem[] | undefined,
  filters: { keyword?: string; lowOnly?: boolean } = {},
): StockRow[] {
  const index = catalogIndex(catalog)
  return (stock ?? [])
    .map((item) => {
      const product = index.get(item.productId)
      return {
        ...item,
        name: productName(product, item.productId),
        named: Boolean(product?.name.trim()),
        ...(product?.barcode ? { barcode: product.barcode } : {}),
      }
    })
    .filter(
      (row) =>
        (!filters.lowOnly || row.lowStock) &&
        (matchesKeyword(row.name, filters.keyword) || matchesBarcode(row.barcode, filters.keyword)),
    )
    .sort(byName)
}

export interface CatalogRow extends CatalogItem {
  label: string
  named: boolean
  /** 这个商品的库存项目；从没入过库的商品没有。 */
  stock?: StockItem
}

/** 商品资料表的行：带上显示名和对应库存，按关键字（商品名包含，或正好是条码）筛选、按名称排序。 */
export function catalogRows(
  catalog: CatalogItem[] | undefined,
  stock: StockItem[] | undefined,
  keyword?: string,
): CatalogRow[] {
  const byProduct = new Map((stock ?? []).map((item) => [item.productId, item]))
  return (catalog ?? [])
    .map((item) => ({
      ...item,
      label: productName(item, item.id),
      named: Boolean(item.name.trim()),
      stock: byProduct.get(item.id),
    }))
    .filter((row) => matchesKeyword(row.label, keyword) || matchesBarcode(row.barcode, keyword))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id))
}

/** 下拉框的选项：商品按显示名排序。 */
export function productOptions(catalog: CatalogItem[] | undefined): { value: string; label: string }[] {
  return (catalog ?? [])
    .map((item) => ({ value: item.id, label: productName(item, item.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN') || a.value.localeCompare(b.value))
}

/** 盘点、流水筛选用的库存项目选项（值是库存项目编号），按名称排序。 */
export function stockOptions(
  stock: StockItem[] | undefined,
  catalog: CatalogItem[] | undefined,
): { value: string; label: string }[] {
  return stockRows(stock, catalog).map((row) => ({ value: row.id, label: row.name }))
}
