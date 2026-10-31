import { ApiError } from '../../api/client'

// 失败提示：后端的中文 message 原样显示；有几类错误后端回的是英文（forbidden、not_found、
// 契约类的字段缺失），按错误码换成店员看得懂的话。

const copy: Record<string, string> = {
  forbidden: '当前账号无权执行此操作，请找店长或老板',
  not_found: '记录不存在，可能已被别人修改，请刷新后重试',
  idempotency_conflict: '这次提交和上次的内容不一致，请刷新后重新确认',
  insufficient_stock: '库存不足，调整后不能为负数',
  invalid_purchase: '采购信息不完整：请填写供应商并至少登记一种商品',
  invalid_adjustment: '盘点信息不完整：请选择商品、填写非零的变化量和原因',
  stock_quantity_conflict: '库存已变化，请重新核对后再盘点',
  invalid_stock_alert: '预警线填 0 或正整数',
  invalid_catalog_item: '商品资料无效：名称必填，售价不能为负',
  invalid_request: '提交内容格式有误，请刷新页面后重试',
}

const hasChinese = /\p{Script=Han}/u

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (hasChinese.test(error.message)) return error.message
    return copy[error.code] ?? error.message
  }
  if (error instanceof Error && error.message) return error.message
  return '操作失败，请重试'
}
