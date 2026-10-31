import { describe, expect, it } from 'vitest'
import type { CatalogItem, StockItem } from '../../api/inventory'
import {
  catalogRows,
  findByBarcode,
  matchesBarcode,
  matchesKeyword,
  productFilter,
  productName,
  productOptions,
  stockRows,
} from './products'

const catalog: CatalogItem[] = [
  { id: 'p-board', name: '拼豆板 方形', unitPriceCents: 800 },
  { id: 'p-beads', name: '珠光豆 5mm', unitPriceCents: 1200, barcode: '6901234567892' },
  { id: 'p-legacy', name: '', unitPriceCents: 0 },
]
const stock: StockItem[] = [
  { id: 's-beads', productId: 'p-beads', quantity: 30, alertAt: 10, lowStock: false },
  { id: 's-board', productId: 'p-board', quantity: 2, alertAt: 5, lowStock: true },
  { id: 's-legacy', productId: 'p-legacy', quantity: 0, alertAt: 0, lowStock: true },
  { id: 's-orphan', productId: 'abcdef12-0000', quantity: 4, alertAt: 0, lowStock: false },
]

describe('商品名称与筛选', () => {
  it('没有名称的商品显示「未命名商品 · 编号前 8 位」', () => {
    expect(productName({ name: '珠光豆' }, 'p1')).toBe('珠光豆')
    expect(productName({ name: '  ' }, 'abcdef12-3456')).toBe('未命名商品 · abcdef12')
    expect(productName(undefined, 'abcdef12-3456')).toBe('未命名商品 · abcdef12')
  })

  it('关键字忽略首尾空格和大小写，空关键字匹配全部', () => {
    expect(matchesKeyword('珠光豆 5MM', ' 5mm ')).toBe(true)
    expect(matchesKeyword('珠光豆', '板')).toBe(false)
    expect(matchesKeyword('珠光豆', '')).toBe(true)
    expect(matchesKeyword('珠光豆', undefined)).toBe(true)
  })

  it('库存行带上商品名，按名称排序；数量和是否偏低原样用接口的', () => {
    const rows = stockRows(stock, catalog)
    expect(rows.map((row) => row.name)).toEqual([
      '拼豆板 方形',
      '未命名商品 · abcdef12',
      '未命名商品 · p-legacy',
      '珠光豆 5mm',
    ])
    expect(rows.find((row) => row.id === 's-board')).toMatchObject({ quantity: 2, lowStock: true, named: true })
    expect(rows.find((row) => row.id === 's-legacy')?.named).toBe(false)
  })

  it('搜索和只看预警可以叠加', () => {
    expect(stockRows(stock, catalog, { lowOnly: true }).map((row) => row.id)).toEqual(['s-board', 's-legacy'])
    expect(stockRows(stock, catalog, { keyword: '拼豆', lowOnly: true }).map((row) => row.id)).toEqual(['s-board'])
    expect(stockRows(stock, catalog, { keyword: '珠光', lowOnly: true })).toEqual([])
  })

  it('商品资料行带上对应库存，没入过库的没有', () => {
    const rows = catalogRows(catalog, stock)
    expect(rows.find((row) => row.id === 'p-beads')?.stock?.quantity).toBe(30)
    expect(catalogRows(catalog, [], '珠光')).toHaveLength(1)
    expect(catalogRows(catalog, undefined).find((row) => row.id === 'p-legacy')).toMatchObject({
      named: false,
      stock: undefined,
    })
  })

  it('下拉选项按显示名排序', () => {
    expect(productOptions(catalog).map((option) => option.value)).toEqual(['p-board', 'p-legacy', 'p-beads'])
  })
})

describe('按条码找商品', () => {
  it('条码整串相同才算（去首尾空白，区分大小写），空的不算', () => {
    expect(matchesBarcode('6901234567892', ' 6901234567892\r\n')).toBe(true)
    expect(matchesBarcode('6901234567892', '690123456789')).toBe(false)
    expect(matchesBarcode('Ab-1', 'ab-1')).toBe(false)
    expect(matchesBarcode(undefined, '')).toBe(false)
    expect(matchesBarcode('', '  ')).toBe(false)
    expect(findByBarcode(catalog, '6901234567892')?.id).toBe('p-beads')
    expect(findByBarcode(catalog, '000')).toBeUndefined()
  })

  it('库存表、商品资料表的搜索框也认条码', () => {
    expect(stockRows(stock, catalog, { keyword: '6901234567892' }).map((row) => row.id)).toEqual(['s-beads'])
    expect(stockRows(stock, catalog).find((row) => row.id === 's-beads')?.barcode).toBe('6901234567892')
    expect(stockRows(stock, catalog).find((row) => row.id === 's-board')?.barcode).toBeUndefined()
    expect(catalogRows(catalog, stock, ' 6901234567892 ').map((row) => row.id)).toEqual(['p-beads'])
    // 条码的一部分不算：只按名称包含匹配
    expect(catalogRows(catalog, stock, '69012')).toEqual([])
  })

  it('采购下拉的搜索：正好是条码时只列那一件（扫码枪回车即选中），否则按名称包含、忽略大小写', () => {
    const filter = productFilter(catalog)
    const shown = (input: string) =>
      productOptions(catalog)
        .filter((option) => filter(input, option))
        .map((option) => option.value)
    expect(shown('6901234567892')).toEqual(['p-beads'])
    expect(shown('6901234567892\n')).toEqual(['p-beads'])
    expect(shown('5MM')).toEqual(['p-beads'])
    expect(shown('拼豆')).toEqual(['p-board'])
    expect(shown('')).toEqual(['p-board', 'p-legacy', 'p-beads'])
    expect(shown('0000000000000')).toEqual([])
  })
})
