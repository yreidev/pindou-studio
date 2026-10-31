import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { LoyaltyQuote } from '../../api/checkout'
import { canDiscount, discountDirty, discountFormSchema, parsePercent, toDiscountInput } from './discount'
import { quoteRows } from './member'
import {
  amountDue,
  cashTender,
  checkoutErrorMessage,
  collectAmount,
  collectedText,
  isLoyaltyConflict,
  isMemberCheckoutStep,
  isOrderConflict,
  memberCollectProblem,
  parseBalanceCap,
  parsePoints,
  paymentBlocker,
  payButtonText,
  type PaymentState,
} from './payment'

const quote = (overrides: Partial<LoyaltyQuote> = {}): LoyaltyQuote => ({
  originalCents: 10000,
  discountCents: 500,
  pointsUsed: 100,
  pointsCents: 1000,
  principalCents: 3000,
  giftCents: 1000,
  offlineCents: 4500,
  earnedPoints: 45,
  pointsValidDays: 365,
  version: 'q'.repeat(64),
  ...overrides,
})

describe('人工折扣', () => {
  it('只给店长、老板显示', () => {
    expect(canDiscount({ roles: ['manager'] })).toBe(true)
    expect(canDiscount({ roles: ['owner'] })).toBe(true)
    expect(canDiscount({ roles: ['clerk'] })).toBe(false)
  })

  it('百分比换成整数基点，不经过浮点；0、超过 100%、多于两位小数都不行', () => {
    expect(parsePercent('10')).toBe(1000)
    expect(parsePercent('12.5')).toBe(1250)
    expect(parsePercent(' 0.01 ')).toBe(1)
    expect(parsePercent('100')).toBe(10000)
    for (const bad of ['0', '100.01', '101', '1.234', '-5', '', 'abc', '.5']) expect(parsePercent(bad)).toBeNull()
  })

  it('请求体：固定金额是整数分，比例是整数基点，原因去掉首尾空格', () => {
    expect(toDiscountInput({ kind: 'fixed', value: '10.5', reason: ' 老顾客 ' })).toEqual({
      kind: 'fixed',
      amountCents: 1050,
      reason: '老顾客',
    })
    expect(toDiscountInput({ kind: 'percentage', value: '15', reason: '活动' })).toEqual({
      kind: 'percentage',
      rateBasisPoints: 1500,
      reason: '活动',
    })
  })

  it('校验：金额至少 1 分、比例在 0 到 100% 之间、原因必填且不超过 200 字', () => {
    const messages = (values: Parameters<typeof discountFormSchema.safeParse>[0]) =>
      discountFormSchema.safeParse(values).error?.issues.map((issue) => issue.message) ?? []
    expect(messages({ kind: 'fixed', value: '0', reason: '' })).toEqual([
      '请填写减免金额（元，最多两位小数）',
      '请填写折扣原因',
    ])
    expect(messages({ kind: 'percentage', value: '120', reason: '活动' })).toEqual([
      '请填写减免百分比：大于 0、不超过 100，最多两位小数',
    ])
    expect(messages({ kind: 'percentage', value: '10', reason: '字'.repeat(201) })).toEqual(['原因最多 200 字'])
    expect(messages({ kind: 'percentage', value: '10', reason: '字'.repeat(200) })).toEqual([])
    expect(discountDirty({ kind: 'percentage', value: '', reason: ' ' })).toBe(false)
    expect(discountDirty({ kind: 'percentage', value: '10', reason: '' })).toBe(true)
  })
})

describe('收款', () => {
  const draft = { status: 'draft' as const, receivableCents: 12000, lines: [{ quantity: 1, unitPriceCents: 12000 }] }
  const state = (overrides: Partial<PaymentState> = {}): PaymentState => ({
    order: draft,
    dirty: false,
    conflict: false,
    quoting: false,
    ...overrides,
  })

  it('散客单收还差的数，会员结账收报价里的线下补付；都是接口给的数', () => {
    expect(amountDue({ status: 'draft', receivableCents: 12000, outstandingCents: 12000 }, undefined)).toEqual({
      label: '应收金额',
      cents: 12000,
    })
    // 重放旧响应没有 outstandingCents：草稿按应收
    expect(amountDue({ status: 'draft', receivableCents: 12000 }, undefined)).toEqual({
      label: '应收金额',
      cents: 12000,
    })
    expect(amountDue({ status: 'draft', accountId: 'u1', receivableCents: 12000 }, quote())).toEqual({
      label: '线下补付',
      cents: 4500,
    })
    expect(amountDue({ status: 'draft', accountId: 'u1', receivableCents: 12000 }, undefined)).toBeNull()
    // 部分付款：会员结账已经是第一笔，余下的按还差的数普通收款
    expect(
      amountDue({ status: 'partially_paid', accountId: 'u1', receivableCents: 12000, outstandingCents: 2000 }, quote()),
    ).toEqual({ label: '还差', cents: 2000 })
    expect(isMemberCheckoutStep({ status: 'draft', accountId: 'u1' })).toBe(true)
    expect(isMemberCheckoutStep({ status: 'partially_paid', accountId: 'u1' })).toBe(false)
    expect(isMemberCheckoutStep({ status: 'draft' })).toBe(false)
    expect(payButtonText({ cents: 4500 })).toBe('确认收款 ¥45.00')
    expect(payButtonText(null)).toBe('确认收款')
  })

  it('分笔付款：这一笔的金额空着就是全部，可以改小，不能超过还差的数', () => {
    expect(collectAmount('', 12000)).toEqual({ cents: 12000 })
    expect(collectAmount('  ', 12000)).toEqual({ cents: 12000 })
    expect(collectAmount('40', 12000)).toEqual({ cents: 4000 })
    expect(collectAmount('119.99', 12000)).toEqual({ cents: 11999 })
    expect(collectAmount('120', 12000)).toEqual({ cents: 12000 })
    expect(collectAmount('120.01', 12000).error).toBe('这一笔不能超过还差的 ¥120.00')
    expect(collectAmount('0', 12000).error).toBe('这一笔至少收 ¥0.01')
    for (const bad of ['-5', '1.234', 'abc'])
      expect(collectAmount(bad, 12000).error).toBe('收款金额按元填写，最多两位小数')
    // 还没有上限（明细没保存、会员优惠在算）：只核对格式
    expect(collectAmount('', null)).toEqual({})
    expect(collectAmount('40', null)).toEqual({ cents: 4000 })
    // 会员结账的线下补付可以填 0（这次不收），不能超过报价
    expect(collectAmount('0', 4500, true)).toEqual({ cents: 0 })
    expect(collectAmount('46', 4500, true).error).toBe('这次收的线下款不能超过报价的线下补付 ¥45.00')
    expect(paymentBlocker(state({ amountProblem: '这一笔不能超过还差的 ¥120.00' }))).toBe(
      '这一笔不能超过还差的 ¥120.00',
    )
  })

  it('会员这一笔要收到钱：不用储值又不收线下款时提前说明', () => {
    const noBalance = quote({ principalCents: 0, giftCents: 0 })
    expect(memberCollectProblem(noBalance, 0)).toContain('会员结账这一笔要收到钱')
    expect(memberCollectProblem(noBalance, 100)).toBeNull()
    expect(memberCollectProblem(quote(), 0)).toBeNull()
    expect(memberCollectProblem(noBalance, 4500)).toBeNull()
    expect(memberCollectProblem(undefined, 0)).toBeNull()
  })

  it('部分付款的单接着收下一笔：不再看明细和会员报价；收完的提示写已收和还差', () => {
    const partial = { ...draft, status: 'partially_paid' as const, accountId: 'u1' }
    expect(paymentBlocker(state({ order: partial }))).toBe('')
    expect(paymentBlocker(state({ order: partial, conflict: true }))).toBe('订单已被修改，请先重新读取并核对')
    expect(paymentBlocker(state({ order: { ...draft, status: 'voided' } }))).toBe('这张订单已经不是待结账状态')
    expect(collectedText({ status: 'partially_paid', paidCents: 4000, outstandingCents: 8000 })).toBe(
      '已收 ¥40.00，还差 ¥80.00',
    )
    expect(collectedText({ status: 'paid', paidCents: 12000, outstandingCents: 0 })).toBe('收款成功')
  })

  it('不能收款时说清为什么', () => {
    expect(paymentBlocker(state())).toBe('')
    expect(paymentBlocker(state({ dirty: true }))).toBe('明细改过，请先保存并核对金额')
    expect(paymentBlocker(state({ conflict: true }))).toBe('订单已被修改，请先重新读取并核对')
    expect(
      paymentBlocker(state({ order: { ...draft, receivableCents: 0, lines: [{ quantity: 1, unitPriceCents: 0 }] } })),
    ).toBe('有明细还没填单价，填好并保存才能收款')
    expect(
      paymentBlocker(state({ order: { ...draft, receivableCents: 0, lines: [{ quantity: 1, unitPriceCents: 100 }] } })),
    ).toBe('应收金额为 0，请检查明细')
    expect(paymentBlocker(state({ order: { ...draft, status: 'paid' } }))).toBe('这张订单已经不是待结账状态')
    const member = { ...draft, accountId: 'u1' }
    expect(paymentBlocker(state({ order: member }))).toBe('正在计算会员优惠…')
    expect(paymentBlocker(state({ order: member, quote: quote(), quoting: true }))).toBe('正在计算会员优惠…')
    expect(paymentBlocker(state({ order: member, quote: quote(), memberProblem: '积分不足' }))).toBe('积分不足')
    expect(paymentBlocker(state({ order: member, quote: quote() }))).toBe('')
  })

  it('现金实收：选填；不少于这次要收的数，找零不超过 ¥1,000；应找零按整数分相减', () => {
    expect(cashTender('', 2990)).toEqual({})
    expect(cashTender('  ', 2990)).toEqual({})
    expect(cashTender('50', 2990)).toEqual({ receivedCents: 5000, changeCents: 2010 })
    expect(cashTender('29.9', 2990)).toEqual({ receivedCents: 2990, changeCents: 0 })
    expect(cashTender('0.3', 10)).toEqual({ receivedCents: 30, changeCents: 20 })
    expect(cashTender('1029.90', 2990)).toEqual({ receivedCents: 102990, changeCents: 100000 })
    expect(cashTender('20', 2990).error).toBe('实收现金不能少于本次收款 ¥29.90')
    expect(cashTender('1029.91', 2990).error).toBe('找零不能超过 ¥1,000.00，请核对实收现金')
    for (const bad of ['0', '-5', '1.234', 'abc']) expect(cashTender(bad, 2990).error).toContain('大于 0 的金额')
    // 会员优惠还在算、还没有要收的数：只核对格式
    expect(cashTender('50', null)).toEqual({ receivedCents: 5000 })
    expect(paymentBlocker(state({ cashProblem: '实收现金不能少于本次收款 ¥120.00' }))).toBe(
      '实收现金不能少于本次收款 ¥120.00',
    )
    // 先说明更根本的原因
    expect(paymentBlocker(state({ dirty: true, cashProblem: 'x' }))).toBe('明细改过，请先保存并核对金额')
  })

  it('这次用多少储值：空着是能用多少用多少，填了按元换成整数分，0 也算填了；超没超过由后端核对', () => {
    expect(parseBalanceCap('')).toEqual({})
    expect(parseBalanceCap('  ')).toEqual({})
    expect(parseBalanceCap('30')).toEqual({ cents: 3000 })
    expect(parseBalanceCap(' 30.5 ')).toEqual({ cents: 3050 })
    expect(parseBalanceCap('0')).toEqual({ cents: 0 })
    for (const bad of ['-1', '1.234', 'abc', '30元'])
      expect(parseBalanceCap(bad).error).toBe('储值金额按元填写，不小于 0，最多两位小数')
  })

  it('使用积分：空着算 0，须为整数', () => {
    expect(parsePoints('')).toBe(0)
    expect(parsePoints(' 200 ')).toBe(200)
    for (const bad of ['-1', '1.5', 'abc', '10000000000']) expect(parsePoints(bad)).toBeNull()
  })

  it('报价逐项照接口，本金和赠送分两行，是 0 的不列', () => {
    expect(quoteRows(quote())).toEqual([
      { label: '原应收', value: '¥100.00' },
      { label: '会员优惠', value: '-¥5.00' },
      { label: '积分抵扣（100 积分）', value: '-¥10.00' },
      { label: '储值本金支付', value: '-¥30.00' },
      { label: '赠送余额支付', value: '-¥10.00' },
      { label: '线下补付', value: '¥45.00', strong: true },
      { label: '本次获得积分', value: '45 积分' },
    ])
    expect(
      quoteRows(
        quote({
          discountCents: 0,
          pointsUsed: 0,
          pointsCents: 0,
          principalCents: 0,
          giftCents: 0,
          offlineCents: 10000,
        }),
      ).map((row) => row.label),
    ).toEqual(['原应收', '线下补付', '本次获得积分'])
  })

  it('失败说明：版本冲突、库存不足、无权、结果不确定各给能照着做的话，其余照后端原文', () => {
    const conflict = new ApiError(409, 'order_version_conflict', '订单已被修改，请重新读取并确认')
    expect(isOrderConflict(conflict)).toBe(true)
    expect(isOrderConflict(new ApiError(409, 'idempotency_conflict', 'x'))).toBe(true)
    expect(checkoutErrorMessage(conflict, '收款')).toContain('你填写的内容已保留')
    expect(checkoutErrorMessage(new ApiError(409, 'insufficient_stock', '库存不足'), '收款')).toContain('登记采购入库')
    expect(checkoutErrorMessage(new ApiError(403, 'forbidden', '当前账号无权执行此操作'), '折扣')).toBe(
      '当前账号无权打折，人工折扣需店长或老板办理。',
    )
    expect(checkoutErrorMessage(new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试'), '收款')).toBe(
      '网络连接失败，请检查网络后重试。不确定是否已收款时，可以原样再提交一次（同一笔不会重复收款），或重新读取订单核对。',
    )
    const stale = new ApiError(409, 'loyalty_conflict', '会员资产或权益已变化，请重新预览结账')
    expect(isLoyaltyConflict(stale)).toBe(true)
    expect(checkoutErrorMessage(stale, '收款')).toBe('会员资产或权益已变化，请重新预览结账')
  })
})
