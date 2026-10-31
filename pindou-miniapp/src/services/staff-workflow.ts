import type { Order } from './customer'
import { money, storeOffsetMinutes } from './format'

/** 某一刻在门店时区的「年-月-日T时:分」，开台时间的输入框用它（不跟手机时区走）。 */
export function storeDateTime(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const t = new Date(date.getTime() + storeOffsetMinutes * 60000)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`
}

/** storeDateTime 的反方向：门店时区的「年-月-日T时:分」是哪一刻。 */
export function fromStoreDateTime(value: string): Date {
  const [day, clock] = value.split('T')
  const [year, month, date] = day.split('-').map(Number)
  const [hour, minute] = clock.split(':').map(Number)
  return new Date(Date.UTC(year, month - 1, date, hour, minute - storeOffsetMinutes))
}

export type DraftLine = { productId: string; name: string; quantity: string; unitPriceYuan: string }
export const blankLine = (): DraftLine => ({ productId: '', name: '', quantity: '1', unitPriceYuan: '' })
export const orderLines = (order: Order): DraftLine[] =>
  (order.lines || []).map((line) => ({
    productId: line.productId || '',
    name: line.name || '',
    quantity: String(line.quantity),
    unitPriceYuan: money(line.unitPriceCents),
  }))
export const hasUnsavedLines = (order: Order, lines: DraftLine[]) =>
  JSON.stringify(orderLines(order)) !== JSON.stringify(lines)
export function decimalHundredths(value: string, allowZero = false): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error('请输入最多两位小数的正数')
  const [whole, fraction = ''] = value.trim().split('.')
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) throw new Error('金额或比例超出范围')
  return amount
}

/**
 * 这次人工折扣会不会把应收减到 0：减免 100%，或固定减免不少于当前应收。应收为 0 的单收不了款，
 * 整单不收钱要用免单，后端拒绝（409 zero_receivable）；这里提交前先说。只比整数分和基点，不算钱。
 */
export function discountZeroesOrder(kind: 'percentage' | 'fixed', value: number, receivableCents: number): boolean {
  if (receivableCents <= 0) return false
  return kind === 'percentage' ? value >= 10000 : value >= receivableCents
}
export const zeroReceivableMessage =
  '这样会把应收减到 0：人工折扣至少留 0.01 元；整单不收钱请用「免单」（店长、老板，写明原因）'

export function integerInput(value: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^-?\d+$/.test(value.trim())) throw new Error('请输入整数')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`数值必须在 ${min} 至 ${max} 之间`)
  return result
}
export function validatedLines(lines: DraftLine[]): NonNullable<Order['lines']> {
  if (!lines.length) throw new Error('请至少填写一项订单明细')
  return lines.map((line) => {
    const quantity = integerInput(line.quantity, 1),
      unitPriceCents = decimalHundredths(line.unitPriceYuan, true)
    if ((!line.name.trim() && !line.productId.trim()) || !Number.isSafeInteger(quantity * unitPriceCents))
      throw new Error('请检查名称、整数数量和单价（元）')
    return {
      productId: line.productId.trim() || undefined,
      name: line.name.trim() || undefined,
      quantity,
      unitPriceCents,
    }
  })
}

export function draftLineErrors(line: DraftLine): { name?: string; quantity?: string; price?: string } {
  const errors: { name?: string; quantity?: string; price?: string } = {}
  if (!line.name.trim() && !line.productId.trim()) errors.name = '请填写服务名称或选择商品'
  try {
    integerInput(line.quantity, 1)
  } catch {
    errors.quantity = '数量须为大于零的整数'
  }
  try {
    decimalHundredths(line.unitPriceYuan, true)
  } catch {
    errors.price = '单价须为非负金额，最多两位小数'
  }
  return errors
}

/**
 * 会员结账「这次用多少储值」（元，选填）：会员只用储值付自己那份时填（多人合付，2026-10-06 业主定）。
 * 空着就是能用多少用多少（cents 为空，请求不带 balanceCents）；填了要是不小于 0、最多两位小数的金额，换成整数分。
 * 超没超过可用储值和这一笔应付由后端核对（报价失败时原样说明）。
 */
export function balanceCapCents(text: string): { cents?: number; error?: string } {
  if (!text.trim()) return {}
  try {
    return { cents: decimalHundredths(text, true) }
  } catch {
    return { error: '储值金额按元填写，不小于 0，最多两位小数' }
  }
}

export type PaymentAmount = {
  /** 这一笔要登记的数（整数分）；填得不对时没有。 */
  cents?: number
  /** 填的是不是少于这次能收的全部（少收了，订单会是部分付款）。 */
  partial?: boolean
  error?: string
}

/**
 * 分笔付款（多人合付）这一笔收多少（元，员工可改小）：空着就是 dueCents 全部——散客单是接口给的还差的数
 * （outstandingCents），会员结账是报价里的线下补付。填了要是最多两位小数的金额，不超过 dueCents；
 * allowZero 时可以填 0（会员结账这次不收线下款，余下的分笔收），否则至少 0.01。dueCents 来自接口，这里只比大小，不算钱。
 */
export function paymentAmount(text: string, dueCents: number, allowZero = false): PaymentAmount {
  if (!text.trim()) return { cents: dueCents, partial: false }
  let cents: number
  try {
    cents = decimalHundredths(text, allowZero)
  } catch {
    return { error: allowZero ? '金额须为不小于 0 的金额，最多两位小数' : '金额须为大于 0 的金额，最多两位小数' }
  }
  if (cents > dueCents) return { error: `这一笔不能超过还差的 ¥${money(dueCents)}` }
  return { cents, partial: cents < dueCents }
}

/** 现金找零上限（¥1,000），与后端一致：找零这么多多半是多打了一个 0。这里只提前提示，后端照样校验。 */
export const maxCashChangeCents = 100_000

export type CashTender = {
  /** 填了的实收现金（整数分）；空着为 undefined，收款请求不带它。 */
  receivedCents?: number
  /** 应找零：实收 − 这次要收的数。只给店员当场点钱看，记下来的找零以接口返回的为准。 */
  changeCents?: number
  /** 填得不对时的原因，收款按钮据此点不动。 */
  error?: string
}

/**
 * 现金的「实收现金」（元，选填），规则同网页后台结账页：空着就不带；填了要是大于 0、最多两位小数的金额，
 * 不少于这次要收的数（散客单的应收、会员单的线下补付），找零不超过 ¥1,000。
 * dueCents 是接口给的这次要收的数，还没有（会员优惠在算、明细没保存）时只核对格式。
 * 应找零是页面上唯一在本地算的钱（整数分相减，只为当场找钱），后端按同样的规则算好记在付款记录上。
 */
export function cashTender(text: string, dueCents: number | null): CashTender {
  if (!text.trim()) return {}
  let received: number
  try {
    received = decimalHundredths(text)
  } catch {
    return { error: '实收现金须为大于 0 的金额，最多两位小数' }
  }
  if (dueCents === null) return { receivedCents: received }
  if (received < dueCents) return { receivedCents: received, error: `实收现金不能少于本次收款 ¥${money(dueCents)}` }
  const change = received - dueCents
  if (change > maxCashChangeCents)
    return { receivedCents: received, error: `找零不能超过 ¥${money(maxCashChangeCents)}，请核对实收现金` }
  return { receivedCents: received, changeCents: change }
}
