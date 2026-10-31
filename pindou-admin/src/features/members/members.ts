import { z } from 'zod'
import type { LoyaltyProfile } from '../../api/members'
import { money } from '../../lib/format'

// 会员页的网址参数与资产的显示。只格式化接口给的数字，不推算余额、积分或等级。
// 查找会员（昵称、手机尾号、编号开头）、排序与分页都在服务端（GET /loyalty/members）。

/** 左边会员列表每页条数（放在窄栏里，少一点）。 */
export const memberPageSize = 10

const optionalText = z
  // 纯数字（手机尾号）手打进地址栏时路由会读成数字，转回文字
  .preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().trim().max(100))
  .optional()
  .catch(undefined)
const optionalPage = z.coerce.number().int().min(1).optional().catch(undefined)

export const membersSearchSchema = z.object({
  q: optionalText,
  account: z.string().optional().catch(undefined),
  page: optionalPage,
  listPage: optionalPage,
})

export interface MembersSearch {
  /** 查找会员的关键字。 */
  q?: string
  /** 选中的会员编号。 */
  account?: string
  /** 选中会员的流水页码。 */
  page?: number
  /** 左边会员列表的页码。 */
  listPage?: number
}

/** 网址参数里不认识的值一律当没填；空搜索词、第 1 页不写进网址。 */
export function parseMembersSearch(raw: Record<string, unknown>): MembersSearch {
  const parsed = membersSearchSchema.parse(raw)
  return {
    q: parsed.q || undefined,
    account: parsed.account || undefined,
    page: parsed.page && parsed.page > 1 ? parsed.page : undefined,
    listPage: parsed.listPage && parsed.listPage > 1 ? parsed.listPage : undefined,
  }
}

/** 编号显示前 8 位，和员工权限页一致。 */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** 带正负号的金额：+¥1.00、-¥1.00；0 显示 ¥0.00。 */
export function signedMoney(cents: number): string {
  return cents > 0 ? `+${money(cents)}` : money(cents)
}

/** 带正负号的积分：+100、-20、0。 */
export function signedPoints(points: number): string {
  return points > 0 ? `+${points.toLocaleString('zh-CN')}` : points.toLocaleString('zh-CN')
}

/** 会员折扣（整数基点）：10000 → 不打折，9500 → 9.5 折，8800 → 8.8 折，9000 → 9 折。只用整数运算。 */
export function discountLabel(rateBasisPoints: number): string {
  if (rateBasisPoints >= 10000) return '不打折'
  const whole = Math.floor(rateBasisPoints / 1000)
  const rest = String(rateBasisPoints % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${whole}${rest ? `.${rest}` : ''} 折`
}

/** 生日只存月日；birthdayYear 是顾客设置的那一年（每个自然年只能设一次）。 */
export function birthdayLabel(profile: LoyaltyProfile): string {
  const match = /^(\d{2})-(\d{2})$/.exec(profile.birthday)
  if (!match) return '未设置'
  const day = `${Number(match[1])} 月 ${Number(match[2])} 日`
  return profile.birthdayYear > 0 ? `${day}（${profile.birthdayYear} 年设置）` : day
}
