import { describe, expect, it } from 'vitest'
import type { MemberCheckout, MemberRefundQuote, Order } from '../../api/orders'
import {
  memberCheckoutRows,
  memberRefundAmountHint,
  memberRefundBlockedTitle,
  memberRefundBlocker,
  memberRefundedRows,
  memberRefundFormSchema,
  memberRefundNotes,
  memberRefundQuoteInput,
  memberRefundSummary,
  offlineMethods,
  pointSpendText,
  refundAmountCents,
  toMemberRefundInput,
  wholeOnly,
} from './member-refund'
import { returnableProducts } from './refund'

const checkout: MemberCheckout = {
  principalCents: 5000,
  giftCents: 1000,
  pointsUsed: 30,
  pointsEarned: 97,
  offlineCents: 3700,
}

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 'b1b2c3d4-0000-4000-8000-000000000001',
  version: 'a'.repeat(64),
  accountId: 'u-li',
  status: 'paid',
  receivableCents: 9700,
  paidCents: 9700,
  refundedCents: 0,
  refundableCents: 9700,
  settlement: 'member',
  memberCheckout: checkout,
  createdAt: '2026-10-04T02:00:00Z',
  lines: [
    { productId: 'p-bead', name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
    { name: '计时服务费', quantity: 1, unitPriceCents: 6000 },
  ],
  payments: [
    { id: 'pay-balance', method: 'balance', amountCents: 6000, createdAt: '2026-10-04T02:10:00Z' },
    { id: 'pay-cash', method: 'cash', amountCents: 3700, createdAt: '2026-10-04T02:10:00Z' },
  ],
  ...overrides,
})

const quote = (overrides: Partial<MemberRefundQuote> = {}): MemberRefundQuote => ({
  orderVersion: 'a'.repeat(64),
  amountCents: 1940,
  refundableCents: 9700,
  settlesOrder: false,
  offlineCents: 740,
  principalCents: 1000,
  giftCents: 200,
  pointsRestored: 6,
  pointsClawedBack: 19,
  ...overrides,
})

describe('会员退款表单', () => {
  const products = returnableProducts(order())
  const schema = memberRefundFormSchema({ refundableCents: 9700, wholeOnly: false, products })
  const errorsOf = (values: Parameters<typeof schema.safeParse>[0]) => {
    const result = schema.safeParse(values)
    return result.success
      ? {}
      : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
  }

  it('金额必填：0.01 元到本单还可退，最多两位小数', () => {
    expect(errorsOf({ amount: '', reason: '退', returned: {} })).toEqual({
      amount: '请填写这次退款的金额（元，最多两位小数）',
    })
    expect(errorsOf({ amount: '0', reason: '退', returned: {} })).toEqual({
      amount: '请填写这次退款的金额（元，最多两位小数）',
    })
    expect(errorsOf({ amount: '1.234', reason: '退', returned: {} })).toEqual({
      amount: '请填写这次退款的金额（元，最多两位小数）',
    })
    expect(errorsOf({ amount: '97.01', reason: '退', returned: {} })).toEqual({ amount: '超过本单还可退的 ¥97.00' })
    expect(errorsOf({ amount: '97', reason: '退', returned: {} })).toEqual({})
    expect(errorsOf({ amount: '19.4', reason: '退', returned: {} })).toEqual({})
  })

  it('实付为 0（全用积分抵扣）的单不填金额，只能整单退', () => {
    const zero = order({ paidCents: 0, receivableCents: 0, refundableCents: 0 })
    expect(wholeOnly(zero)).toBe(true)
    const zeroSchema = memberRefundFormSchema({ refundableCents: 0, wholeOnly: true, products })
    expect(zeroSchema.safeParse({ amount: '', reason: '退', returned: {} }).success).toBe(true)
    // 不带金额 = 退剩余全部
    expect(memberRefundQuoteInput(zero, '')).toEqual({
      accountId: 'u-li',
      targetId: zero.id,
      expectedVersion: zero.version,
    })
  })

  it('原因必填（去掉空格后），最多 200 字；件数不超过还可退回、须为整数', () => {
    expect(errorsOf({ amount: '10', reason: '  ', returned: {} })).toEqual({ reason: '请填写退款原因' })
    expect(errorsOf({ amount: '10', reason: '字'.repeat(201), returned: {} })).toEqual({
      reason: '退款原因最多 200 字',
    })
    expect(products.map((product) => product.productId)).toEqual(['p-bead'])
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '3' } })).toEqual({
      'returned.p-bead': '最多可退回 2 件',
    })
    expect(errorsOf({ amount: '10', reason: '退货', returned: { 'p-bead': '1.5' } })).toEqual({
      'returned.p-bead': '件数须为整数',
    })
  })

  it('部分退过、退回过 1 包的单：件数上限扣掉已退回的', () => {
    const partly = order({
      refundedCents: 1940,
      refundableCents: 7760,
      refunds: [{ id: 'r1', reason: '少做一件', amountCents: 1940, returnedProducts: { 'p-bead': 1 }, createdAt: 'x' }],
    })
    const left = returnableProducts(partly)
    expect(left[0]).toMatchObject({ sold: 2, returned: 1, remaining: 1 })
  })
})

describe('预览与请求体', () => {
  it('金额合法才预览：带订单、读到的版本、顾客和这次的分', () => {
    expect(refundAmountCents('19.40', 9700)).toBe(1940)
    expect(refundAmountCents('97.01', 9700)).toBeNull()
    expect(refundAmountCents('abc', 9700)).toBeNull()
    expect(memberRefundQuoteInput(order(), '19.4')).toEqual({
      accountId: 'u-li',
      targetId: order().id,
      expectedVersion: 'a'.repeat(64),
      amountCents: 1940,
    })
    expect(memberRefundQuoteInput(order(), '')).toBeNull()
    expect(memberRefundQuoteInput(order(), '200')).toBeNull()
  })

  it('还不能预览时说一句为什么', () => {
    expect(memberRefundAmountHint('', 9700)).toMatch(/填好金额后/)
    expect(memberRefundAmountHint('1.234', 9700)).toBe('金额按元填写，最多两位小数。')
    expect(memberRefundAmountHint('200', 9700)).toBe('超过本单还可退的 ¥97.00。')
  })

  it('请求体照预览：金额、预览依据的版本；原因去空格；只带大于 0 的件数', () => {
    const products = returnableProducts(order())
    const quoted = memberRefundQuoteInput(order(), '19.40')
    if (!quoted) throw new Error('应能预览')
    expect(
      toMemberRefundInput(
        quoted,
        { orderVersion: 'a'.repeat(64) },
        { amount: '19.40', reason: ' 少做一件 ', returned: { 'p-bead': '1' } },
        products,
      ),
    ).toEqual({
      accountId: 'u-li',
      targetId: order().id,
      expectedVersion: 'a'.repeat(64),
      amountCents: 1940,
      reason: '少做一件',
      returnedProducts: { 'p-bead': 1 },
    })
    expect(
      toMemberRefundInput(
        quoted,
        { orderVersion: 'a'.repeat(64) },
        { amount: '19.40', reason: '退服务', returned: { 'p-bead': '0' } },
        products,
      ),
    ).not.toHaveProperty('returnedProducts')
  })
})

describe('将退回什么：只照接口给的数字', () => {
  it('详情卡片逐项列出结账时动过的会员资产与累计已退回', () => {
    expect(memberCheckoutRows(checkout)).toEqual([
      { key: '储值本金支付', value: '¥50.00' },
      { key: '赠送余额支付', value: '¥10.00' },
      { key: '积分抵扣', value: '30 积分' },
      { key: '本单所得积分', value: '97 积分' },
      { key: '线下补付', value: '¥37.00' },
    ])
    expect(memberRefundedRows(quote())).toEqual([
      { key: '已退线下', value: '¥7.40' },
      { key: '已退本金', value: '¥10.00' },
      { key: '已退赠送', value: '¥2.00' },
      { key: '已恢复积分', value: '6 积分' },
      { key: '已扣回消费积分', value: '19 积分' },
    ])
  })

  it('一句话写清这次将退回的线下、本金、赠送、积分和扣回的消费积分', () => {
    expect(memberRefundSummary(quote())).toBe('线下 ¥7.40、本金 ¥10.00、赠送 ¥2.00、积分 6，扣回消费积分 19')
  })

  it('说明线下按原付款方式退还、积分回原批次、退满时零头结清；是 0 的项不说', () => {
    expect(offlineMethods(order())).toBe('现金')
    expect(memberRefundNotes(quote(), order())).toEqual([
      '线下的 ¥7.40 系统不退，请按原付款方式（现金）退还顾客',
      '本金、赠送按原流水各回各的余额，赠送不会退成本金',
      '恢复的 6 积分回到原批次，保留原到期时间',
    ])
    expect(
      memberRefundNotes(
        quote({ offlineCents: 0, principalCents: 0, giftCents: 0, pointsRestored: 0, settlesOrder: true }),
        order(),
      ),
    ).toEqual(['这次退完剩余全部，各项零头在这次结清，订单变为已退款'])
  })
})

describe('还能不能退', () => {
  it('已付款的会员结账单（含部分退过的）可以退；退完、没付款、不是会员结账的都停下说明原因', () => {
    expect(memberRefundBlocker(order())).toBeNull()
    expect(memberRefundBlocker(order({ refundedCents: 1000, refundableCents: 8700 }))).toBeNull()
    expect(memberRefundBlocker(order({ status: 'refunded', refundableCents: 0 }))).toBe(
      '这张订单已经全部退完，不能再退。',
    )
    expect(memberRefundBlocker(order({ status: 'voided' }))).toMatch(/只有已付款/)
    expect(memberRefundBlocker(order({ settlement: 'standard', memberCheckout: undefined }))).toMatch(/不是会员结账/)
  })

  it('送出的积分被用掉：还能少退一些就不拦（由预览按金额说明）；一分也退不了才照接口的原因停下', () => {
    const refundBlocked = { reason: '本单送出的积分已被用掉', pointsShort: 50, maxRefundableCents: 4999, spentBy: [] }
    expect(memberRefundBlocker(order({ memberCheckout: { ...checkout, refundBlocked } }))).toBeNull()
    expect(
      memberRefundBlocker(
        order({ memberCheckout: { ...checkout, refundBlocked: { ...refundBlocked, maxRefundableCents: 0 } } }),
      ),
    ).toBe('本单送出的积分已被用掉')
  })
})

describe('收不回积分时的标题', () => {
  it('还能少退时写出最多能退多少；一分也退不了时只说缺口', () => {
    expect(memberRefundBlockedTitle({ pointsShort: 48, maxRefundableCents: 4999 })).toBe(
      '退不完剩余全部：本单送出的积分已被用掉，扣回还缺 48 分，现在最多能退 ¥49.99',
    )
    expect(memberRefundBlockedTitle({ pointsShort: 1200, maxRefundableCents: 0 })).toBe(
      '暂时不能退：本单送出的积分已被用掉，扣回还缺 1,200 分',
    )
  })
})

describe('用掉本单积分的流水', () => {
  it('写成时间、用途、分数；不认识的种类原样显示', () => {
    expect(pointSpendText({ kind: 'checkout', sourceId: 'o2', points: 40, createdAt: '2026-10-04T09:00:00Z' })).toBe(
      '2026-10-04 17:00 会员结账抵扣 用掉 40 积分',
    )
    expect(pointSpendText({ kind: 'adjust', sourceId: '', points: 5, createdAt: '2026-10-04T09:00:00Z' })).toBe(
      '2026-10-04 17:00 资产调整扣减 用掉 5 积分',
    )
    expect(pointSpendText({ kind: 'expire', sourceId: '', points: 5, createdAt: '2026-10-04T09:00:00Z' })).toBe(
      '2026-10-04 17:00 expire 用掉 5 积分',
    )
  })
})
