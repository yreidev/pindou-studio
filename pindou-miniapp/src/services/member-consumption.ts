import { parsePoints, parseSignedYuan, reasonMaxLength } from './adjust'
import { dateOnly, money } from './format'
import type { LoyaltyAction, Member } from './membership'

export const serviceToday = () => dateOnly(Date.now())
export const earliestServiceDate = (unlimited: boolean, today = serviceToday()) =>
  unlimited ? undefined : dateOnly(Date.parse(`${today}T00:00:00+08:00`) - 7 * 86400000)

export function serviceDateProblem(value: string, unlimited: boolean, today = serviceToday()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || dateOnly(`${value}T00:00:00+08:00`) !== value) return '请选择有效日期'
  if (value > today) return '不能登记将来的日期'
  if (!unlimited && value < earliestServiceDate(false, today)!) return '店员只能登记今天往前 7 天以内的记录'
  return ''
}

export const dayTypeForDate = (value: string): 'workday' | 'holiday' =>
  [0, 6].includes(new Date(`${value}T00:00:00Z`).getUTCDay()) ? 'holiday' : 'workday'

export type ConsumptionForm = {
  serviceDate: string
  packageId: string
  headcount: 1 | 2
  dayType: 'workday' | 'holiday'
  amount: string
  boardUses: string
  reason: string
}

export function consumptionPlan(
  form: ConsumptionForm,
  member: Member,
  unlimited: boolean,
): { error: string } | { error: ''; input: LoyaltyAction; confirmation: string } {
  const dateError = serviceDateProblem(form.serviceDate, unlimited)
  if (dateError) return { error: dateError }
  const rule = member.rules.find((r) => r.id === form.packageId && r.kind === 'package' && r.enabled)
  if (form.packageId && !rule) return { error: '这个套餐已不可用，请重新选择' }
  const amountCents = parseSignedYuan(form.amount)
  if (!form.amount.trim() || amountCents === null || amountCents < 0)
    return { error: '请填写金额，最多两位小数，须为 0 到 1000 万元' }
  const boardUses = parsePoints(form.boardUses)
  if (boardUses === null || boardUses < 0 || boardUses > 100) return { error: '智能豆板次数须为 0 到 100 的整数' }
  if (boardUses > member.balance.boardUses) return { error: '智能豆板剩余次数不够，请核对' }
  if (!amountCents && !boardUses) return { error: '消费金额和智能豆板次数不能都为 0' }
  const reason = form.reason.trim()
  if (!form.packageId && !reason) return { error: '选「其他」时请填写备注' }
  if ([...reason].length > reasonMaxLength) return { error: `备注最多 ${reasonMaxLength} 字` }
  const principal = Math.min(amountCents, member.balance.principalCents)
  const gift = Math.min(amountCents - principal, member.balance.giftCents)
  const deducted = principal + gift
  return {
    error: '',
    input: {
      action: 'consume',
      serviceDate: form.serviceDate,
      consumption: {
        ...(form.packageId ? { packageId: form.packageId } : {}),
        headcount: form.headcount,
        dayType: form.dayType,
        amountCents,
        boardUses,
      },
      ...(reason ? { reason } : {}),
    },
    confirmation:
      `${form.serviceDate} · ${form.headcount === 2 ? '双人' : '单人'} · ${rule?.name || '其他'} · ${form.dayType === 'holiday' ? '节假日' : '工作日'}。` +
      `消费 ¥${money(amountCents)}，从余额扣 ¥${money(deducted)}（本金 ¥${money(principal)}、赠送 ¥${money(gift)}），另付 ¥${money(amountCents - deducted)}。` +
      `扣完余额 ¥${money(member.balance.principalCents + member.balance.giftCents - deducted)}。智能豆板用 ${boardUses} 次，剩 ${member.balance.boardUses - boardUses} 次。` +
      `${reason ? `备注：${reason}。` : ''}以上仅供核对，以实际登记结果为准。`,
  }
}
