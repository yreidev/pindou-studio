import { describe, expect, it } from 'vitest'
import type { ListedAccount, RoleAssignment } from '../../api/staff'
import { accountLabel, assignableAccounts, canRevoke, currentRoles, labelOrId, rolesOf } from './roles'

const assignment = (overrides: Partial<RoleAssignment> = {}): RoleAssignment => ({
  id: 'r1',
  accountId: 'target',
  account: { id: 'target', nickname: '小林', phoneMasked: '138****0000' },
  role: 'clerk',
  assignedAt: '2026-10-04T00:00:00Z',
  ...overrides,
})

const listed = (id: string, roles: ListedAccount['roles']): ListedAccount => ({
  id,
  nickname: id,
  roles,
  phoneVerificationStatus: 'verified',
})

describe('员工权限', () => {
  it('账号显示昵称加手机尾号，没有手机号用编号前 8 位', () => {
    expect(accountLabel({ id: '12345678-aaaa', nickname: '小林', phoneMasked: '138****0000' })).toBe(
      '小林 · 138****0000',
    )
    expect(accountLabel({ id: '12345678-aaaa', nickname: '小林' })).toBe('小林 · 12345678')
    expect(accountLabel({ id: '12345678-aaaa', nickname: '小林', phoneMasked: '' })).toBe('小林 · 12345678')
    expect(currentRoles({ roles: [] })).toBe('普通用户')
    expect(currentRoles({ roles: ['manager'] })).toBe('店长')
  })

  it('列表里用服务端带的称呼，账户不在了只显示编号前 8 位', () => {
    expect(labelOrId({ id: 'u1', nickname: '小林', phoneMasked: '138****0000' }, 'u1')).toBe('小林 · 138****0000')
    expect(labelOrId(null, '12345678-aaaa')).toBe('12345678')
    expect(labelOrId(undefined, '12345678-aaaa')).toBe('12345678')
  })

  it('账号现有的角色从任命列表里取', () => {
    const rows = [
      assignment({ id: 'r1', accountId: 'a', role: 'owner' }),
      assignment({ id: 'r2', accountId: 'b', role: 'clerk' }),
    ]
    expect(rolesOf(rows, 'a')).toEqual(['owner'])
    expect(rolesOf(rows, 'c')).toEqual([])
  })

  it('店长的候选账号里没有老板，老板都能看到', () => {
    const accounts = [listed('boss', ['owner']), listed('li', []), listed('wang', ['manager'])]
    expect(assignableAccounts(accounts, false).map((a) => a.id)).toEqual(['li', 'wang'])
    expect(assignableAccounts(accounts, true).map((a) => a.id)).toEqual(['boss', 'li', 'wang'])
  })

  it('自己那条不能撤销；店长不能撤销老板；老板都能撤销', () => {
    const owner = { id: 'me', isOwner: true }
    const manager = { id: 'me', isOwner: false }
    expect(canRevoke(assignment({ accountId: 'me' }), owner, [])).toBe(false)
    expect(canRevoke(assignment({ role: 'owner' }), owner, ['owner'])).toBe(true)
    expect(canRevoke(assignment({ role: 'owner' }), manager, ['owner'])).toBe(false)
    expect(canRevoke(assignment({ role: 'clerk' }), manager, ['owner', 'clerk'])).toBe(false)
    expect(canRevoke(assignment({ role: 'clerk' }), manager, ['clerk'])).toBe(true)
  })
})
