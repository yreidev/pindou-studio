import type { LoyaltyQuote } from '../../api/checkout'
import { money } from '../../lib/format'

// 会员结账报价的展示，照小程序结账页「会员抵扣」一段：原应收、会员优惠、积分抵扣、余额支付、线下补付、本次获得积分。
// 每一项都是报价接口给的数，原样显示；是 0 的优惠、抵扣、余额支付不列。本金和赠送分两行列，不在前端相加。

export interface QuoteRow {
  label: string
  value: string
  /** 线下补付：这一项就是要收的钱，加粗。 */
  strong?: boolean
}

export function quoteRows(quote: LoyaltyQuote): QuoteRow[] {
  const rows: QuoteRow[] = [{ label: '原应收', value: money(quote.originalCents) }]
  if (quote.discountCents > 0) rows.push({ label: '会员优惠', value: `-${money(quote.discountCents)}` })
  if (quote.pointsCents > 0)
    rows.push({
      label: `积分抵扣（${quote.pointsUsed.toLocaleString('zh-CN')} 积分）`,
      value: `-${money(quote.pointsCents)}`,
    })
  if (quote.principalCents > 0) rows.push({ label: '储值本金支付', value: `-${money(quote.principalCents)}` })
  if (quote.giftCents > 0) rows.push({ label: '赠送余额支付', value: `-${money(quote.giftCents)}` })
  rows.push({ label: '线下补付', value: money(quote.offlineCents), strong: true })
  rows.push({ label: '本次获得积分', value: `${quote.earnedPoints.toLocaleString('zh-CN')} 积分` })
  return rows
}
