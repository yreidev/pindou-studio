import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { errorText } from './errors'

describe('失败提示', () => {
  it('后端给的中文原样显示', () => {
    expect(errorText(new ApiError(409, 'insufficient_stock', '调整后库存会变成负数'))).toBe('调整后库存会变成负数')
    expect(errorText(new ApiError(400, 'invalid_catalog_item', '商品名称必填，价格必须是不小于 0 的整数'))).toBe(
      '商品名称必填，价格必须是不小于 0 的整数',
    )
  })

  it('后端回英文的按错误码换成中文', () => {
    expect(errorText(new ApiError(403, 'forbidden', 'forbidden'))).toBe('当前账号无权执行此操作，请找店长或老板')
    expect(errorText(new ApiError(400, 'invalid_purchase', 'supplierName and items are required'))).toMatch(/供应商/)
    expect(errorText(new ApiError(409, 'idempotency_conflict', 'key already used for a different request'))).toMatch(
      /刷新/,
    )
  })

  it('认不出的保留原文，非接口错误也有兜底', () => {
    expect(errorText(new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试'))).toBe(
      '网络连接失败，请检查网络后重试',
    )
    expect(errorText(new ApiError(418, 'teapot', 'teapot'))).toBe('teapot')
    expect(errorText('x')).toBe('操作失败，请重试')
  })
})
