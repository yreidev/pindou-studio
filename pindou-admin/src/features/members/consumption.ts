import { z } from 'zod'
import type { LoyaltyBalance, LoyaltyRule } from '../../api/members'
import { money, parseYuan, storeToday } from '../../lib/format'
import { parseCount } from '../rules/units'
import { assetLimit, reasonMaxLength } from './forms'

export function packagesByDuration(rules: LoyaltyRule[]): LoyaltyRule[] {
  return rules
    .filter((rule) => rule.kind === 'package')
    .sort(
      (a, b) =>
        Number(!!a.untilClose) - Number(!!b.untilClose) ||
        (a.untilClose ? 0 : a.durationMinutes - b.durationMinutes) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN'),
    )
}

export function defaultDayType(day: string): 'workday' | 'holiday' {
  const weekday = new Date(`${day}T12:00:00+08:00`).getUTCDay()
  return weekday === 0 || weekday === 6 ? 'holiday' : 'workday'
}

/** 日期选择器的 Date 代表日历上的格子，取它的年月日，不转换时区。 */
export function calendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function serviceDateError(day: string, canBackdate: boolean, today = storeToday()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '请选择日期'
  const date = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return '请选择有效日期'
  if (day > today) return '不能登记将来的日期'
  const earliest = new Date(`${today}T00:00:00Z`)
  earliest.setUTCDate(earliest.getUTCDate() - 7)
  if (!canBackdate && day < earliest.toISOString().slice(0, 10)) return '超过 7 天的补录请由店长、老板办理'
  return null
}

export function emptyConsumptionForm() {
  const serviceDate = storeToday()
  return {
    serviceDate,
    packageId: '',
    headcount: '1',
    dayType: defaultDayType(serviceDate),
    amount: '',
    boardUses: '0',
    reason: '',
  }
}

export function consumptionFormSchema(canBackdate: boolean, remainingUses: number) {
  return z
    .object({
      serviceDate: z.string().superRefine((day, ctx) => {
        const message = serviceDateError(day, canBackdate)
        if (message) ctx.addIssue({ code: 'custom', message })
      }),
      packageId: z.string(),
      headcount: z.enum(['1', '2']),
      dayType: z.enum(['workday', 'holiday']),
      amount: z.string().refine((text) => {
        const n = parseYuan(text)
        return n !== null && n <= assetLimit
      }, '请填写金额（元），最多两位小数，不超过 1000 万元'),
      boardUses: z.string().refine(
        (text) => {
          const n = parseCount(text)
          return n !== null && n <= Math.min(100, remainingUses)
        },
        `智能豆板次数须为 0～${Math.min(100, remainingUses)} 的整数`,
      ),
      reason: z.string().refine((text) => [...text.trim()].length <= reasonMaxLength, '备注最多 200 字'),
    })
    .superRefine((value, ctx) => {
      if (!value.packageId && !value.reason.trim())
        ctx.addIssue({ code: 'custom', path: ['reason'], message: '选「其他」时请填写备注' })
      if (parseYuan(value.amount) === 0 && parseCount(value.boardUses) === 0)
        ctx.addIssue({ code: 'custom', path: ['amount'], message: '金额和智能豆板次数不能都为 0' })
    })
}

/** 仅供确认框核对，实际扣款与剩余资产以接口返回为准。 */
export function consumptionOutcome(
  balance: Pick<LoyaltyBalance, 'principalCents' | 'giftCents' | 'boardUses'>,
  amountCents: number,
  uses: number,
) {
  const principalCents = Math.min(balance.principalCents, amountCents)
  const giftCents = Math.min(balance.giftCents, amountCents - principalCents)
  return {
    principalCents,
    giftCents,
    deductedCents: principalCents + giftCents,
    extraCents: amountCents - principalCents - giftCents,
    balanceCents: balance.principalCents + balance.giftCents - principalCents - giftCents,
    boardUses: balance.boardUses - uses,
  }
}

export function consumptionConfirmText(
  balance: Pick<LoyaltyBalance, 'principalCents' | 'giftCents' | 'boardUses'>,
  amountCents: number,
  uses: number,
): string[] {
  const after = consumptionOutcome(balance, amountCents, uses)
  return [
    `消费金额 ${money(amountCents)}，当前余额 ${money(balance.principalCents + balance.giftCents)}`,
    `本次从余额扣 ${money(after.deductedCents)}（本金 ${money(after.principalCents)}、赠送 ${money(after.giftCents)}）`,
    `余额不够时另付 ${money(after.extraCents)}（在系统外收取）`,
    `扣完余额 ${money(after.balanceCents)}`,
    `智能豆板用 ${uses} 次，剩 ${after.boardUses} 次`,
  ]
}

export const memberAccountFormSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(1, '请填写称呼')
    .refine((text) => [...text].length <= 50, '称呼最多 50 字'),
  phone: z
    .string()
    .trim()
    .max(30, '手机号最多 30 字')
    .refine(
      (text) => /^\+?\d{6,15}$/.test(text.replace(/[\s-]/g, '')),
      '请填写 6～15 位手机号，可带开头的 +、空格和横线',
    ),
  consent: z.boolean().refine(Boolean, '请先确认顾客已同意'),
})
