import { money } from './format'

// 手动加减（2026-10-10 起所有员工都能办）：本金、赠送余额、积分可加可减，必须写原因，扣不成负数，加的积分不过期。
// 规则同网页后台 features/members/forms.ts 与后端 adjust：金额输入是元、转成整数分，积分是整数，单项绝对值上限 10 亿（分 / 积分）。

/** 后端对单笔金额、积分的上限（分 / 积分）。 */
export const assetLimit = 1_000_000_000

/** 原因按字符计数（和后端按 rune 数一致）。 */
export const reasonMaxLength = 200

export type AdjustForm = { principal: string; gift: string; points: string; boardUses?: string; reason: string }

export const emptyAdjustForm: AdjustForm = { principal: '', gift: '', points: '', boardUses: '', reason: '' }

export type AdjustBalance = { principalCents: number; giftCents: number; points: number; boardUses?: number }

/** 可带正负号的元 → 整数分；留空当 0。不合法或超出上限返回 null。 */
export function parseSignedYuan(text: string): number | null {
  const value = text.trim()
  if (value === '') return 0
  const match = /^([+-]?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  if (cents > assetLimit) return null
  return match[1] === '-' && cents !== 0 ? -cents : cents
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

const signedMoney = (cents: number) => `${cents < 0 ? '-' : '+'}¥${money(Math.abs(cents))}`
const signedPoints = (points: number) => `${points < 0 ? '' : '+'}${points}`

export type AdjustPlan =
  | { error: string }
  | {
      error: ''
      change: { principalCents: number; giftCents: number; points: number; boardUses?: number; reason: string }
      /** 确认框里的一段话：本次调整、调整后各是多少（以后端结果为准）。 */
      confirmation: string
    }

/**
 * 表单 → 要提交的调整。填得不对、全是 0、扣成负数（后端会拒绝）时给出原因，不提交。
 * 「调整后」只是把读到的余额和要加减的数相加给员工核对。
 */
export function adjustPlan(form: AdjustForm, balance: AdjustBalance): AdjustPlan {
  const principalCents = parseSignedYuan(form.principal)
  const giftCents = parseSignedYuan(form.gift)
  const points = parsePoints(form.points)
  const boardUses = parsePoints(form.boardUses || '')
  if (principalCents === null || giftCents === null)
    return { error: '金额最多两位小数，可带负号，绝对值不超过 1000 万元' }
  if (points === null) return { error: '积分须为整数，可带负号，绝对值不超过 10 亿' }
  if (boardUses === null || Math.abs(boardUses) > 1000)
    return { error: '智能豆板次数须为整数，可带负号，绝对值不超过 1000' }
  if (!principalCents && !giftCents && !points && !boardUses)
    return { error: '本金、赠送余额、积分、智能豆板次数至少调整一项' }
  const reason = form.reason.trim()
  if (!reason) return { error: '请填写调整原因' }
  if ([...reason].length > reasonMaxLength) return { error: `原因最多 ${reasonMaxLength} 字` }
  const after = {
    principalCents: balance.principalCents + principalCents,
    giftCents: balance.giftCents + giftCents,
    points: balance.points + points,
    boardUses: (balance.boardUses || 0) + boardUses,
  }
  const short = [
    after.principalCents < 0 ? '本金' : '',
    after.giftCents < 0 ? '赠送余额' : '',
    after.points < 0 ? '积分' : '',
    after.boardUses < 0 ? '智能豆板次数' : '',
  ].filter(Boolean)
  if (short.length) return { error: `${short.join('、')}不够扣：调整后不能是负数，请核对后再填` }
  const summary = [
    principalCents ? `本金 ${signedMoney(principalCents)}` : '',
    giftCents ? `赠送余额 ${signedMoney(giftCents)}` : '',
    points ? `积分 ${signedPoints(points)}` : '',
    boardUses ? `智能豆板 ${signedPoints(boardUses)} 次` : '',
  ]
    .filter(Boolean)
    .join('、')
  return {
    error: '',
    change: { principalCents, giftCents, points, ...(boardUses ? { boardUses } : {}), reason },
    confirmation:
      `本次：${summary}。调整后：本金 ¥${money(after.principalCents)}、赠送余额 ¥${money(after.giftCents)}、` +
      `积分 ${after.points}${boardUses ? `、智能豆板剩 ${after.boardUses} 次` : ''}。原因：${reason}`,
  }
}
