import { queryOptions } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'

/** 账户资料。本人资料返回当前有效角色（含开发者体验身份），比登录时存下的角色新。 */
export type AccountProfile = Schemas['Account']

/**
 * 列表里给人看的账户称呼：订单的顾客、审计的操作人、员工任命、规则发布人都由服务端带上，不用为显示名字拉全部账户。
 * 只供展示，不是权限依据；账户不在了（或是系统操作）为 null。phoneMasked 是打码后的手机号，没留手机号为空串。
 */
export type AccountLabel = Schemas['AccountLabel']

export async function getAccount(id: string, signal?: AbortSignal): Promise<AccountProfile> {
  return read(client.GET('/accounts/{accountId}', { params: { path: { accountId: id } }, signal }))
}

export function accountQuery(id: string) {
  return queryOptions({ queryKey: ['accounts', id], queryFn: ({ signal }) => getAccount(id, signal) })
}

/** 员工给顾客发的认领用临时密码：8 位数字，只在这次响应里出现。 */
export type PasswordReset = Schemas['PasswordReset']

/**
 * 发认领用的一次性临时密码（24 小时有效）：顾客在小程序登录页用手机号加它认领员工代开的会员，原来的认领密码作废。
 * 账户还没有认领密码时按资料里的手机号开一条。给员工发要能管理对方的角色，后端判断。
 */
export async function issueTemporaryPassword(id: string): Promise<PasswordReset> {
  return read(client.POST('/accounts/{accountId}/password-resets', { params: { path: { accountId: id } } }))
}
