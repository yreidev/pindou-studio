import { describe, expect, it } from 'vitest'
import type { CatalogItem } from '../../api/inventory'
import {
  catalogDefaults,
  catalogSchema,
  toCatalogInput,
  toCatalogPatch,
  validBarcode,
  type CatalogFormValues,
} from './catalog'

const catalog: CatalogItem[] = [
  { id: 'p1', name: '珠光豆 5mm', unitPriceCents: 1200, barcode: '6901234567892' },
  { id: 'p2', name: '拼豆板', unitPriceCents: 800 },
  { id: 'p3', name: '拼豆板', unitPriceCents: 900 },
  // 历史上只入过库、没建资料的商品名称为空，不能让空名称被当成「重名」
  { id: 'p4', name: '', unitPriceCents: 0 },
]

const messages = (input: Omit<CatalogFormValues, 'barcode'> & { barcode?: string }, editing?: CatalogItem) => {
  const result = catalogSchema(catalog, editing).safeParse({ barcode: '', ...input })
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
}

describe('商品资料表单', () => {
  it('新增：名称、售价必填，售价按元最多两位小数', () => {
    expect(messages(catalogDefaults())).toEqual({ name: '请填写商品名称', price: '请填写参考售价' })
    expect(messages({ name: '豆'.repeat(101), price: '12.345' })).toEqual({
      name: '商品名称最多 100 个字',
      price: '售价按元填写，最多两位小数',
    })
    expect(messages({ name: '透明豆', price: '-1' })).toEqual({ price: '售价按元填写，最多两位小数' })
  })

  it('不能和别的商品重名（忽略大小写和首尾空格）', () => {
    expect(messages({ name: ' 珠光豆 5MM ', price: '1' })).toEqual({ name: '已有同名商品' })
    expect(messages({ name: '珠光豆 5mm', price: '13' }, catalog[0])).toEqual({})
    expect(messages({ name: '拼豆板', price: '1' }, catalog[0])).toEqual({ name: '已有同名商品' })
  })

  it('历史上已重名的商品，名称不动时仍能改价', () => {
    expect(messages({ name: '拼豆板', price: '9.5' }, catalog[1])).toEqual({})
  })

  it('给未命名商品补名称：空名称只提示必填，不提示重名', () => {
    expect(messages({ name: '', price: '1' })).toEqual({ name: '请填写商品名称' })
    expect(messages({ name: ' ', price: '0' }, catalog[3])).toEqual({ name: '请填写商品名称' })
    expect(messages({ name: '透明豆', price: '0' }, catalog[3])).toEqual({})
  })

  it('修改时预填现有资料，提交转成整数分', () => {
    expect(catalogDefaults(catalog[0])).toEqual({ name: '珠光豆 5mm', price: '12.00', barcode: '6901234567892' })
    expect(catalogDefaults(catalog[1])).toEqual({ name: '拼豆板', price: '8.00', barcode: '' })
    expect(toCatalogInput({ name: ' 透明豆 3mm ', price: '12.3', barcode: '' })).toEqual({
      name: '透明豆 3mm',
      unitPriceCents: 1230,
    })
    expect(toCatalogInput({ name: '赠品', price: '0', barcode: '  ' })).toEqual({ name: '赠品', unitPriceCents: 0 })
  })

  it('条码：去首尾空白后 1–64 位可打印 ASCII，空着表示没有；区分大小写', () => {
    for (const ok of ['', '  ', '6901234567892', ' 036000291452\n', 'Ab-12/x.~!', '7'.repeat(64)])
      expect(validBarcode(ok), ok).toBe(true)
    for (const bad of ['690 123', '690\t123', '条码123', '６９０１', '7'.repeat(65)])
      expect(validBarcode(bad), bad).toBe(false)
    expect(messages({ name: '透明豆', price: '1', barcode: '690 123' })).toEqual({
      barcode: '条码只能是 1–64 位英文字母、数字或符号，不能有空格或中文',
    })
  })

  it('新增时填了条码才带；扫码枪带的回车、空白去掉', () => {
    expect(toCatalogInput({ name: '透明豆', price: '1', barcode: ' 6901234567809\r\n' })).toEqual({
      name: '透明豆',
      unitPriceCents: 100,
      barcode: '6901234567809',
    })
  })

  it('修改时条码改了才带，清空发空串（后端清除），没动和以前的请求一样', () => {
    const beads = catalog[0]
    expect(toCatalogPatch({ name: '珠光豆 5mm', price: '13', barcode: '6901234567892' }, beads)).toEqual({
      name: '珠光豆 5mm',
      unitPriceCents: 1300,
    })
    expect(toCatalogPatch({ name: '珠光豆 5mm', price: '12', barcode: '' }, beads)).toEqual({
      name: '珠光豆 5mm',
      unitPriceCents: 1200,
      barcode: '',
    })
    expect(toCatalogPatch({ name: '拼豆板', price: '8', barcode: ' 6901234567809 ' }, catalog[1])).toEqual({
      name: '拼豆板',
      unitPriceCents: 800,
      barcode: '6901234567809',
    })
  })
})
