import type { Schemas } from '../api/client'

// 团购记录（2026-10-10 起）：顾客在哪个平台买的团购和券码，预约和扫码入座都能填、都选填。门店接不了美团的验券接口，
// 店员在美团开店宝扫顾客手机上的券码核销，系统只记下来给店员看。规则同后端 reservations/domain 的 NormalizeCoupon。

export type Coupon = Schemas['Coupon']
export type CouponPlatform = Exclude<Coupon['platform'], ''>

export const couponPlatforms: { value: CouponPlatform; label: string }[] = [
  { value: 'meituan', label: '美团' },
  { value: 'dianping', label: '大众点评' },
  { value: 'in_store', label: '到店再买' },
]

export const maxCouponCode = 32

const platformLabel = (platform: Coupon['platform']) =>
  couponPlatforms.find((item) => item.value === platform)?.label ?? ''

/** 一行写法：「美团 · 券码 1234 5678 9012」「到店再买」；没填为空串。券码四位一段，方便对着开店宝核。 */
export function couponText(coupon: Coupon | null | undefined): string {
  if (!coupon?.platform) return ''
  const label = platformLabel(coupon.platform)
  if (!coupon.code) return label
  return `${label} · 券码 ${coupon.code.replace(/(.{4})(?=.)/g, '$1 ')}`
}

/** 表单里填的团购：平台没选为空串。 */
export interface CouponDraft {
  platform: CouponPlatform | ''
  code: string
}

export const emptyCouponDraft: CouponDraft = { platform: '', code: '' }

export const couponDraftOf = (coupon: Coupon | null | undefined): CouponDraft => ({
  platform: coupon?.platform || '',
  code: coupon?.code ?? '',
})

/** 去掉空白的券码（顾客照着手机上分段的样子抄）。 */
const compact = (code: string) => code.replace(/\s+/g, '')

/** 哪里填得不对（同后端的拒绝条件）；没问题为 null。 */
export function couponProblem(draft: CouponDraft): string | null {
  const code = compact(draft.code)
  if (!draft.platform) return code ? '填了券码要选是哪个平台的' : null
  if (draft.platform === 'in_store') return code ? '到店再买不用填券码' : null
  if (!/^[0-9A-Za-z]*$/.test(code)) return '券码只能是字母和数字'
  if (code.length > maxCouponCode) return `券码最多 ${maxCouponCode} 位`
  return null
}

/** 请求里带的团购：没填为 undefined（不带）。先用 couponProblem 校验。 */
export function couponInput(draft: CouponDraft): Coupon | undefined {
  if (!draft.platform) return undefined
  const code = compact(draft.code)
  return { platform: draft.platform, ...(code && draft.platform !== 'in_store' ? { code } : {}) }
}

/** 两份团购记录是不是同一个（确认入座时没改就不带，保留申请里的）。 */
export function sameCoupon(a: Coupon | null | undefined, b: Coupon | null | undefined): boolean {
  return (a?.platform || '') === (b?.platform || '') && (a?.code ?? '') === (b?.code ?? '')
}
