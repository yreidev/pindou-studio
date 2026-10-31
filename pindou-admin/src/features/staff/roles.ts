import type { StaffRole } from '../../account'
import type { AccountLabel } from '../../api/accounts'
import type { ListedAccount, RoleAssignment } from '../../api/staff'
import { roleNames } from '../../session'

/** 账号的显示名：昵称 · 手机尾号（没有就用编号前 8 位）。 */
export function accountLabel(
  account: Pick<NonNullable<AccountLabel>, 'id' | 'nickname'> & { phoneMasked?: string },
): string {
  return `${account.nickname} · ${account.phoneMasked || account.id.slice(0, 8)}`
}

/** 列表里服务端带的称呼；账户不在了（称呼为 null）时只显示编号前 8 位。 */
export function labelOrId(label: AccountLabel | null | undefined, accountId: string): string {
  return label ? accountLabel(label) : accountId.slice(0, 8)
}

export function currentRoles(account: Pick<ListedAccount, 'roles'> | undefined): string {
  return account?.roles.map((role) => roleNames[role] ?? role).join('、') || '普通用户'
}

/** 某个账号现有的员工角色：任命列表含全部有效任命，从里面取，不用另查账号。 */
export function rolesOf(assignments: readonly RoleAssignment[], accountId: string): StaffRole[] {
  return assignments.filter((assignment) => assignment.accountId === accountId).map((assignment) => assignment.role)
}

/** 分配角色的候选账号：店长看不到、也分配不了老板（后端同样会拒绝）。 */
export function assignableAccounts(accounts: readonly ListedAccount[], isOwner: boolean): ListedAccount[] {
  return accounts.filter((account) => isOwner || !account.roles.includes('owner'))
}

/**
 * 能不能撤销这条任命：自己那条不给（后端有「最后一位老板」保护，按钮摆着就是在邀请人点），
 * 店长不能动老板（后端同样会拒绝）。targetRoles 是被任命账号现有的全部角色（见 rolesOf）。
 */
export function canRevoke(
  assignment: RoleAssignment,
  viewer: { id: string; isOwner: boolean },
  targetRoles: readonly string[],
): boolean {
  if (assignment.accountId === viewer.id) return false
  if (viewer.isOwner) return true
  return assignment.role !== 'owner' && !targetRoles.includes('owner')
}
