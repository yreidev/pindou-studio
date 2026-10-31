import { z } from 'zod'
import { hasRole } from '../../account'
import type { DiscountInput } from '../../api/checkout'
import type { Account } from '../../session'
import { parseYuan } from '../../lib/format'

// 人工折扣，规则照搬小程序结账页：
// - 只有店长、老板能做（界面按角色显示，权限以后端为准），只对待结账订单；
// - 固定金额填元、换成整数分；比例填百分比（最多两位小数），换成整数基点，10 表示减 10%（付九折），最多 100%；
// - 必须写原因（最多 200 字）；减多少钱由后端按保存后的明细算，前端不算。

export type DiscountKind = DiscountInput['kind']

export const discountKindNames: Record<DiscountKind, string> = { percentage: '比例减免', fixed: '固定金额' }

/** 界面上显示折扣入口：店长、老板。只为好用而隐藏，后端照样校验。 */
export function canDiscount(viewer: Pick<Account, 'roles'>): boolean {
  return hasRole(viewer, 'manager', 'owner')
}

/**
 * 百分比 → 整数基点：「10」→ 1000，「12.5」→ 1250，「0.01」→ 1。只做十进制位移，不经过浮点。
 * 不合法（负数、多于两位小数、0、超过 100%）返回 null。
 */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return null
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return basisPoints >= 1 && basisPoints <= 10000 ? basisPoints : null
}

export interface DiscountFormValues {
  kind: DiscountKind
  /** 固定金额是元，比例是百分比。 */
  value: string
  reason: string
}

export const emptyDiscountForm = (): DiscountFormValues => ({ kind: 'percentage', value: '', reason: '' })

/** 原因按字符数算（和后端一致，一个表情算一个字）。 */
const reasonLength = (text: string) => [...text].length

export const discountFormSchema = z
  .object({
    kind: z.enum(['percentage', 'fixed']),
    value: z.string(),
    reason: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.kind === 'fixed') {
      const cents = parseYuan(values.value)
      if (cents === null || cents < 1)
        ctx.addIssue({ code: 'custom', path: ['value'], message: '请填写减免金额（元，最多两位小数）' })
    } else if (parsePercent(values.value) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: '请填写减免百分比：大于 0、不超过 100，最多两位小数',
      })
    }
    const reason = values.reason.trim()
    if (!reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: '请填写折扣原因' })
    else if (reasonLength(reason) > 200) ctx.addIssue({ code: 'custom', path: ['reason'], message: '原因最多 200 字' })
  })

/** 校验通过的表单 → 请求体（不含 expectedVersion，由页面带上读到的那一版）。 */
export function toDiscountInput(values: DiscountFormValues): Omit<DiscountInput, 'expectedVersion'> {
  const reason = values.reason.trim()
  if (values.kind === 'fixed') {
    const amountCents = parseYuan(values.value)
    if (amountCents === null || amountCents < 1) throw new Error('减免金额无效')
    return { kind: 'fixed', amountCents, reason }
  }
  const rateBasisPoints = parsePercent(values.value)
  if (rateBasisPoints === null) throw new Error('减免比例无效')
  return { kind: 'percentage', rateBasisPoints, reason }
}

/** 折扣会把应收减到 0 时的说明（后端同样拒绝，409 zero_receivable）。 */
export const zeroReceivableMessage =
  '这样会把应收减到 0：人工折扣至少留 0.01 元；整单不收钱请用「免单」（店长、老板，写明原因）。'

/**
 * 这次人工折扣会不会把应收减到 0：减免 100%，或固定减免不少于当前应收（receivableCents 是保存后的应收，
 * 已扣掉之前的折扣）。应收为 0 的单收不了款（收款至少 1 分），草稿会一直挂在待结账里；整单不收钱要用免单。
 * 只比整数分和基点，不算钱。
 */
export function discountZeroesOrder(
  input: Pick<DiscountInput, 'kind' | 'amountCents' | 'rateBasisPoints'>,
  receivableCents: number,
): boolean {
  if (receivableCents <= 0) return false
  return input.kind === 'percentage'
    ? (input.rateBasisPoints ?? 0) >= 10000
    : (input.amountCents ?? 0) >= receivableCents
}

/** 表单上填的这次折扣（还没提交）会不会把应收减到 0：填得不完整、不合法时不算，交给表单校验去说。 */
export function discountFormZeroesOrder(
  values: Pick<DiscountFormValues, 'kind' | 'value'>,
  receivableCents: number,
): boolean {
  if (values.kind === 'fixed') {
    const amountCents = parseYuan(values.value)
    return amountCents !== null && discountZeroesOrder({ kind: 'fixed', amountCents }, receivableCents)
  }
  const rateBasisPoints = parsePercent(values.value)
  return rateBasisPoints !== null && discountZeroesOrder({ kind: 'percentage', rateBasisPoints }, receivableCents)
}

/** 表单里有没提交的内容：离开页面前要问一句。 */
export function discountDirty(values: DiscountFormValues): boolean {
  return values.value.trim() !== '' || values.reason.trim() !== ''
}
