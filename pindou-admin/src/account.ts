import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { accountQuery } from './api/accounts'
import type { Schemas } from './api/client'
import type { Account } from './session'

export type StaffRole = Schemas['StaffRoleAssignmentInput']['role']

/**
 * 当前登录的员工。角色以接口返回的本人资料为准（登录后可能被任命或撤销），还没读到时先用登录那一刻的。
 * 只能在登录后的页面（/_authed 下）用。界面按角色隐藏入口只是为了好用，权限一律由后端校验。
 */
export function useCurrentAccount(): Account {
  const { session } = useRouteContext({ from: '/_authed' })
  return useQuery(accountQuery(session.user.id)).data ?? session.user
}

export function hasRole(account: Pick<Account, 'roles'> | undefined, ...roles: StaffRole[]): boolean {
  return Boolean(account?.roles.some((role) => (roles as string[]).includes(role)))
}
