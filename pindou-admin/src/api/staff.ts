import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { StaffRole } from '../account'
import { client, read, readPage, type Page, type Schemas } from './client'

/** 员工任命列表的一项，带被任命账户的称呼（账户不在了为 null）。 */
export type RoleAssignment = Schemas['StaffRoleAssignment']

/** 账号列表里的 roles 是持久任命（不含开发者的体验身份）；不带头像，phoneMasked 没留手机号时没有。 */
export type ListedAccount = Schemas['Account']

/** 找账号：关键字与分页都交给服务端（昵称、打码手机号、编号开头、完整手机号），新注册的在前。 */
export interface AccountSearchParams {
  q?: string
  /** 从 1 起；超出时服务端落到最后一页。 */
  page: number
  /** 最大 100。 */
  pageSize: number
}

export const staffApi = {
  searchAccounts: (params: AccountSearchParams, signal?: AbortSignal): Promise<Page<ListedAccount>> =>
    readPage(
      client.GET('/accounts', {
        params: { query: { page: params.page, pageSize: params.pageSize, q: params.q || undefined } },
        signal,
      }),
      params.page,
    ),
  listRoleAssignments: (signal?: AbortSignal) => read(client.GET('/staff-role-assignments', { signal })),
  /** 任命（替换此人原有的任命）。后端不收幂等键：同样的任命再提交一次结果相同。 */
  assignRole: (accountId: string, role: StaffRole) =>
    read(client.POST('/staff-role-assignments', { body: { accountId, role } })),
  revokeRole: async (assignmentId: string) => {
    await client.DELETE('/staff-role-assignments/{assignmentId}', { params: { path: { assignmentId } } })
  },
}

export function accountSearchQuery(params: AccountSearchParams) {
  return queryOptions({
    queryKey: ['accounts', 'list', params],
    queryFn: ({ signal }) => staffApi.searchAccounts(params, signal),
    // 换关键字时先留着上一批，下拉框不闪成空
    placeholderData: keepPreviousData,
  })
}
