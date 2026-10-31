import type { MockResult } from './mock-api'

// 模拟「找人」的两个列表接口（口径见 docs/api.yaml，真实实现由 Go 测试覆盖）：
// GET /accounts（新注册的在前）与 GET /loyalty/members（按昵称拼音排）。q 去掉首尾空白、不分大小写，
// 昵称或打码手机号包含它、账户编号以它开头即算匹配；带 pageSize 只回那一页，总数与实际页码在响应头里。
// 网页后台必须带 pageSize：不带时（那是只留给旧版小程序的整表读取）这里回 400，让测试立刻失败。

interface Person {
  id: string
  nickname: string
  phoneMasked?: string
}

export function matchesKeyword(person: Person, raw: string | null): boolean {
  const q = (raw ?? '').trim().toLowerCase()
  if (!q) return true
  return (
    person.nickname.toLowerCase().includes(q) ||
    (person.phoneMasked ?? '').toLowerCase().includes(q) ||
    person.id.toLowerCase().startsWith(q)
  )
}

function pageOf<T>(rows: readonly T[], search: URLSearchParams): MockResult {
  const pageSize = Number(search.get('pageSize'))
  if (!pageSize)
    return { status: 400, body: { code: 'invalid_request', message: '网页后台不应整表读取', requestId: 'mock' } }
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = Math.min(Math.max(1, Number(search.get('page')) || 1), pages)
  return {
    status: 200,
    body: rows.slice((page - 1) * pageSize, page * pageSize),
    headers: { 'X-Total-Count': String(rows.length), 'X-Page': String(page) },
  }
}

/** GET /accounts：accounts 按注册先后传入（旧的在前），回的是新注册的在前。 */
export function accountListResult(accounts: readonly Person[], search: URLSearchParams): MockResult {
  return pageOf(accounts.filter((account) => matchesKeyword(account, search.get('q'))).reverse(), search)
}

/** GET /loyalty/members：按昵称（中文按拼音）排，同名按编号。 */
export function memberListResult(members: readonly Person[], search: URLSearchParams): MockResult {
  return pageOf(
    members
      .filter((member) => matchesKeyword(member, search.get('q')))
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'zh-CN') || a.id.localeCompare(b.id)),
    search,
  )
}
