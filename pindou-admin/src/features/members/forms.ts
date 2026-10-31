import { z } from 'zod'
import { parseYuan } from '../../lib/format'
import { signedMoney, signedPoints } from './members'

// 充值退款与手动加减的表单规则。金额输入是元，转成整数分提交；积分是整数。

/** 后端对单笔金额、积分的上限（分 / 积分），见 docs/product.md「当前计算与兼容规则」。 */
export const assetLimit = 1_000_000_000

/** 原因按字符计数（和后端按 rune 数一致，表情不算两个）。 */
export const reasonMaxLength = 200

/** 可带正负号的元 → 整数分；留空当 0。不合法或超出上限返回 null。 */
export function parseSignedYuan(text: string): number | null {
  const value = text.trim()
  if (value === '') return 0
  const negative = value.startsWith('-')
  const cents = parseYuan(value.replace(/^[+-]/, ''))
  if (cents === null || cents > assetLimit) return null
  return negative && cents !== 0 ? -cents : cents
}

/** 可带正负号的整数积分；留空当 0。不合法或超出上限返回 null。 */
export function parsePoints(text: string): number | null {
  const value = text.trim()
  if (value === '') return 0
  if (!/^[+-]?\d{1,10}$/.test(value)) return null
  const points = Number(value.replace(/^\+/, ''))
  if (Math.abs(points) > assetLimit) return null
  return points === 0 ? 0 : points
}

const reason = (empty: string) =>
  z
    .string()
    .refine((value) => value.trim() !== '', empty)
    .refine((value) => [...value.trim()].length <= reasonMaxLength, `原因最多 ${reasonMaxLength} 字`)

const yuanField = z
  .string()
  .refine((value) => parseSignedYuan(value) !== null, '金额最多两位小数，可带负号，绝对值不超过 1000 万元')

export interface AdjustFormValues {
  principal: string
  gift: string
  points: string
  boardUses: string
  reason: string
}

export const emptyAdjustForm: AdjustFormValues = { principal: '', gift: '', points: '', boardUses: '', reason: '' }

export const adjustFormSchema = z
  .object({
    principal: yuanField,
    gift: yuanField,
    points: z.string().refine((value) => parsePoints(value) !== null, '积分须为整数，可带负号，绝对值不超过 10 亿'),
    boardUses: z.string().refine((value) => {
      const n = parsePoints(value)
      return n !== null && Math.abs(n) <= 1000
    }, '豆板次数须为整数，可带负号，绝对值不超过 1000'),
    reason: reason('请填写调整原因'),
  })
  .superRefine((value, ctx) => {
    const amounts = [
      parseSignedYuan(value.principal),
      parseSignedYuan(value.gift),
      parsePoints(value.points),
      parsePoints(value.boardUses),
    ]
    if (amounts.every((amount) => amount === 0))
      ctx.addIssue({ code: 'custom', path: ['principal'], message: '本金、赠送余额、积分、智能豆板次数至少调整一项' })
  })

export interface AdjustChange {
  principalCents: number
  giftCents: number
  points: number
  boardUses: number
  reason: string
}

/** 校验通过后的表单 → 提交内容；不合法返回 null。 */
export function adjustChange(values: AdjustFormValues): AdjustChange | null {
  if (!adjustFormSchema.safeParse(values).success) return null
  return {
    principalCents: parseSignedYuan(values.principal) as number,
    giftCents: parseSignedYuan(values.gift) as number,
    points: parsePoints(values.points) as number,
    boardUses: parsePoints(values.boardUses) as number,
    reason: values.reason.trim(),
  }
}

/** 确认框里的「本次调整」：只列有变化的项，例如「本金 -¥5.00、积分 +10」。 */
export function adjustSummary(
  change: Pick<AdjustChange, 'principalCents' | 'giftCents' | 'points' | 'boardUses'>,
): string {
  return [
    change.principalCents ? `本金 ${signedMoney(change.principalCents)}` : '',
    change.giftCents ? `赠送余额 ${signedMoney(change.giftCents)}` : '',
    change.points ? `积分 ${signedPoints(change.points)}` : '',
    change.boardUses ? `智能豆板 ${signedPoints(change.boardUses)} 次` : '',
  ]
    .filter(Boolean)
    .join('、')
}

/** 调整前的资产（会员视图里的余额）。 */
export interface AdjustBalance {
  principalCents: number
  giftCents: number
  points: number
  boardUses: number
}

/**
 * 确认框里的「调整后」：只是把读到的余额和要加减的数相加给员工核对，以后端结果为准。
 * short 列出会扣成负数的项（后端会拒绝，不提交）。
 */
export function adjustOutcome(
  balance: AdjustBalance,
  change: Pick<AdjustChange, 'principalCents' | 'giftCents' | 'points' | 'boardUses'>,
): { after: AdjustBalance; short: string[] } {
  const after = {
    principalCents: balance.principalCents + change.principalCents,
    giftCents: balance.giftCents + change.giftCents,
    points: balance.points + change.points,
    boardUses: balance.boardUses + change.boardUses,
  }
  const short = [
    after.principalCents < 0 ? '本金' : '',
    after.giftCents < 0 ? '赠送余额' : '',
    after.points < 0 ? '积分' : '',
    after.boardUses < 0 ? '智能豆板次数' : '',
  ].filter(Boolean)
  return { after, short }
}

export const refundFormSchema = z.object({ reason: reason('请填写退款原因') })
