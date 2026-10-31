import type { MockResult } from './mock-api'

// 模拟 GET /sales-orders 的服务端筛选与分页（口径见 docs/api.yaml，真实实现由 Go 测试覆盖）：
// 按状态、关键字（编号、明细名称、顾客昵称与打码手机号）筛选，新的在前；带 pageSize 时只回那一页，
// 总数与实际页码放在 X-Total-Count、X-Page 响应头里，页码超出落到最后一页。

interface ListedOrder {
  id: string
  status: string
  createdAt: string
  accountId?: string
  /** 服务端带的顾客称呼（AccountLabel），散客为 null。 */
  customer?: { nickname: string; phoneMasked: string } | null
  lines?: { name?: string }[]
}

export function orderListResult(orders: readonly ListedOrder[], search: URLSearchParams): MockResult {
  const status = search.get('status')
  const needle = (search.get('q') ?? '').trim().toLowerCase()
  const matched = orders
    // open 是「待结账」：草稿和部分付款（分笔付款还没收齐）一起列
    .filter((order) =>
      !status
        ? true
        : status === 'open'
          ? order.status === 'draft' || order.status === 'partially_paid'
          : order.status === status,
    )
    .filter(
      (order) =>
        !needle ||
        [
          order.id,
          ...(order.lines ?? []).map((line) => line.name ?? ''),
          order.customer ? `${order.customer.nickname} · ${order.customer.phoneMasked}` : '',
        ]
          .join('\n')
          .toLowerCase()
          .includes(needle),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
  const pageSize = Number(search.get('pageSize'))
  if (!pageSize) return { status: 200, body: matched }
  const pages = Math.max(1, Math.ceil(matched.length / pageSize))
  const page = Math.min(Math.max(1, Number(search.get('page')) || 1), pages)
  return {
    status: 200,
    body: matched.slice((page - 1) * pageSize, page * pageSize),
    headers: { 'X-Total-Count': String(matched.length), 'X-Page': String(page) },
  }
}
