import { client, read, type Schemas } from './client'
import type { ListedAccount } from './staff'

// 会员码（2026-10-06）：顾客在小程序会员中心亮出的二维码，内容是 90 秒有效的 20 位数字（首位 9）。
// 柜台 USB 扫码枪对着搜索框扫一下（等于键盘输入再回车），或手机「扫码给电脑」转过来，网页凭它查出是哪位顾客。
// 只有员工能查，查到的后端记审计；过期、伪造的码后端回中文说明（member_code_expired、member_code_not_found）。

/** 凭会员码查到的顾客：账户摘要（同 /accounts 列表）加会员资产摘要。可直接当选中的账户用。 */
export type MemberCodeAccount = Schemas['MemberCodeAccount']

export const memberCodesApi = {
  lookup: (code: string) => read(client.POST('/member-codes/lookups', { body: { code: code.trim() } })),
}

/** 当成选中的账户用（同 /accounts 列表的一项）：只留账户字段，资产摘要不跟着进表单状态。 */
export function asListedAccount(found: MemberCodeAccount): ListedAccount {
  const { id, nickname, phoneMasked, phoneVerificationStatus, roles } = found
  return { id, nickname, ...(phoneMasked ? { phoneMasked } : {}), phoneVerificationStatus, roles }
}
