import { ApiError } from '../../api/client'

const hasChinese = /[一-鿿]/

/**
 * 失败时给人看的话。后端有中文说明就原样显示（例如恢复被拒绝的具体原因）；
 * 无权、找不到这类只回了英文代号（forbidden、not_found）的，换成中文。
 */
export function readableError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError) {
    if (hasChinese.test(error.message)) return error.message
    if (error.status === 401) return '登录已失效，请重新扫码登录'
    if (error.status === 403) return '当前账号无权执行此操作'
    if (error.status === 404) return '要操作的记录不存在，请刷新后重试'
    return `${fallback}（${error.code}）`
  }
  if (error instanceof Error && hasChinese.test(error.message)) return error.message
  return fallback
}
