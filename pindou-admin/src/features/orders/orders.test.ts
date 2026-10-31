import { describe, expect, it } from 'vitest'
import type { Order } from '../../api/orders'
import {
  basisPointsPercent,
  compReason,
  customerLabel,
  discountText,
  hasComp,
  hasOtherPayers,
  isComped,
  isMemberCheckout,
  isOpen,
  isPartiallyRefunded,
  lineSummary,
  memberRefundableCents,
  memberRefundAvailable,
  orderNumber,
  parseOrderListSearch,
  paymentLabel,
  paymentMethodNames,
  paymentNumbers,
  paymentRows,
  refundablePayments,
  refundEntry,
  returnedText,
  statusFilters,
  statusNames,
} from './orders'

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  version: 'a'.repeat(64),
  status: 'paid',
  receivableCents: 30000,
  paidCents: 30000,
  refundedCents: 0,
  refundableCents: 30000,
  settlement: 'standard',
  createdAt: '2026-10-04T02:00:00Z',
  lines: [
    { productId: 'p-bead', name: '拼豆材料包', quantity: 3, unitPriceCents: 5000 },
    { name: '计时服务费', quantity: 1, unitPriceCents: 15000 },
  ],
  ...overrides,
})

describe('订单显示', () => {
  it('状态中文名与小程序一致；编号取前 8 位', () => {
    expect(statusNames).toEqual({
      draft: '待结账',
      partially_paid: '部分付款',
      paid: '已付款',
      refunded: '已退款',
      voided: '已撤销',
    })
    expect(orderNumber(order())).toBe('a1b2c3d4')
  })

  it('部分退款看接口给的已退金额，状态仍是已付款', () => {
    expect(isPartiallyRefunded(order({ refundedCents: 5000 }))).toBe(true)
    expect(isPartiallyRefunded(order({ refundedCents: 0 }))).toBe(false)
    expect(isPartiallyRefunded(order({ status: 'refunded', refundedCents: 30000 }))).toBe(false)
  })

  it('项目摘要最多列两项，多的写共几项', () => {
    expect(lineSummary(order())).toBe('拼豆材料包 ×3、计时服务费 ×1')
    expect(lineSummary(order({ lines: [] }))).toBe('暂无明细')
    const many = order({
      lines: [
        { name: 'A', quantity: 1, unitPriceCents: 1 },
        { name: 'B', quantity: 2, unitPriceCents: 1 },
        { productId: 'p', quantity: 1, unitPriceCents: 1 },
      ],
    })
    expect(lineSummary(many)).toBe('A ×1、B ×2 等 3 项')
  })

  it('顾客：散客、服务端带的昵称加手机尾号、没有称呼时用编号', () => {
    const li = { id: 'u1', nickname: '小李', phoneMasked: '139****0002' }
    expect(customerLabel(order({ customer: null }))).toBe('散客')
    expect(customerLabel(order({ accountId: 'u1', customer: li }))).toBe('小李 · 139****0002')
    expect(customerLabel(order({ accountId: 'u1', customer: { ...li, phoneMasked: '' } }))).toBe('小李')
    // 账户不在了为 null；重放 0.0.7 之前记下的响应时没有这个字段
    expect(customerLabel(order({ accountId: '12345678-zzzz', customer: null }))).toBe('顾客 12345678')
    expect(customerLabel(order({ accountId: '12345678-zzzz' }))).toBe('顾客 12345678')
  })

  it('比例折扣的基点用整数换成百分比', () => {
    expect(basisPointsPercent(1000)).toBe('10%')
    expect(basisPointsPercent(1250)).toBe('12.5%')
    expect(basisPointsPercent(1)).toBe('0.01%')
    expect(basisPointsPercent(10000)).toBe('100%')
    expect(discountText({ kind: 'fixed', amountCents: 500 })).toBe('固定减免 ¥5.00')
    expect(discountText({ kind: 'percentage', rateBasisPoints: 850 })).toBe('按比例减免 8.5%')
  })

  it('退款记录写清回补了哪些商品', () => {
    expect(returnedText({ returnedProducts: { 'p-bead': 2 } }, order())).toBe('拼豆材料包 ×2')
    expect(returnedText({}, order())).toBe('未回补库存')
  })
})

describe('列表网址参数', () => {
  it('网址参数：不认识的值当没填，空搜索与第 1 页不写进网址', () => {
    expect(parseOrderListSearch({ q: ' 钥匙扣 ', status: 'paid', page: 2 })).toEqual({
      q: '钥匙扣',
      status: 'paid',
      page: 2,
    })
    expect(parseOrderListSearch({ q: '', status: 'unknown', page: 'abc' })).toEqual({
      q: undefined,
      status: undefined,
      page: undefined,
    })
    expect(parseOrderListSearch({ page: 1 })).toEqual({ q: undefined, status: undefined, page: undefined })
    expect(parseOrderListSearch({ page: '3' }).page).toBe(3)
    // 路由把纯数字的搜索词解析成数字，照样当文字搜
    expect(parseOrderListSearch({ q: 1234 }).q).toBe('1234')
  })
})

describe('退款入口', () => {
  it('只有已付款、已退款的单显示退款；店员看不到；退完了不再给按钮', () => {
    const manager = { roles: ['manager'] }
    expect(refundEntry(order(), manager)).toBe('available')
    expect(refundEntry(order(), { roles: ['owner'] })).toBe('available')
    expect(refundEntry(order(), { roles: ['clerk'] })).toBe('no-permission')
    expect(refundEntry(order({ status: 'draft', refundableCents: 0 }), manager)).toBe('not-paid')
    expect(refundEntry(order({ status: 'voided', refundableCents: 0 }), manager)).toBe('not-paid')
    expect(refundEntry(order({ status: 'refunded', refundableCents: 0 }), manager)).toBe('fully-refunded')
  })

  it('会员结账单还没退完就能再退（部分退过也能；全用积分抵扣、已付为 0 也能退），退满了就没有入口', () => {
    const manager = { roles: ['manager'] }
    const memberOrder = (overrides: Partial<Order> = {}) => order({ settlement: 'member', ...overrides })
    expect(isMemberCheckout(memberOrder())).toBe(true)
    expect(isMemberCheckout(order())).toBe(false)
    expect(refundEntry(memberOrder(), manager)).toBe('available')
    expect(
      refundEntry(
        memberOrder({
          refundedCents: 10000,
          refundableCents: 20000,
          refunds: [{ id: 'r1', reason: '部分退', amountCents: 10000, createdAt: 'x' }],
        }),
        manager,
      ),
    ).toBe('available')
    expect(refundEntry(memberOrder({ paidCents: 0, refundableCents: 0 }), manager)).toBe('available')
    expect(refundEntry(memberOrder(), { roles: ['clerk'] })).toBe('no-permission')
    expect(refundEntry(memberOrder({ status: 'draft', refundableCents: 0 }), manager)).toBe('not-paid')
    expect(
      refundEntry(
        memberOrder({
          status: 'refunded',
          refundedCents: 30000,
          refundableCents: 0,
          refunds: [{ id: 'r1', reason: '整单退', amountCents: 30000, createdAt: 'x' }],
        }),
        manager,
      ),
    ).toBe('fully-refunded')
  })
})

describe('免单', () => {
  const comped = (overrides: Partial<Order> = {}) =>
    order({
      settlement: 'comp',
      paidCents: 0,
      refundableCents: 0,
      compCents: 3490,
      payments: [
        { id: 'c1', method: 'comp', amountCents: 3490, reason: '老顾客生日', createdAt: '2026-10-06T02:00:00Z' },
      ],
      ...overrides,
    })

  it('免单结清：标出免单与原因，没有收到钱、不给退款入口', () => {
    expect(isComped(comped())).toBe(true)
    expect(isComped(order())).toBe(false)
    expect(compReason(comped())).toBe('老顾客生日')
    expect(compReason(order())).toBe('')
    expect(paymentMethodNames.comp).toBe('免单')
    expect(refundEntry(comped(), { roles: ['manager'] })).toBe('comped')
    expect(refundEntry(comped(), { roles: ['clerk'] })).toBe('comped')
  })

  it('网址参数：只看免单写成 settlement=comp，认不得的当没填', () => {
    expect(parseOrderListSearch({ settlement: 'comp' }).settlement).toBe('comp')
    expect(parseOrderListSearch({ settlement: 'member' }).settlement).toBeUndefined()
  })
})

describe('分笔付款（多人合付）', () => {
  const at = '2026-10-06T02:00:00Z'
  const split = (overrides: Partial<Order> = {}) =>
    order({
      receivableCents: 10000,
      paidCents: 10000,
      refundableCents: 7000,
      refundedCents: 3000,
      payments: [
        { id: 'p1', method: 'wechat', amountCents: 4000, createdAt: at, refundedCents: 3000, refundableCents: 1000 },
        { id: 'p2', method: 'alipay', amountCents: 6000, createdAt: at, refundedCents: 0, refundableCents: 6000 },
      ],
      ...overrides,
    })

  it('状态与筛选：部分付款单独可筛，「待结账」含部分付款；旧链接 status=draft 当待结账', () => {
    expect(statusNames.partially_paid).toBe('部分付款')
    expect(statusFilters.map((filter) => filter.value)).toEqual([
      'open',
      'partially_paid',
      'paid',
      'refunded',
      'voided',
    ])
    expect(parseOrderListSearch({ status: 'open' }).status).toBe('open')
    expect(parseOrderListSearch({ status: 'partially_paid' }).status).toBe('partially_paid')
    expect(parseOrderListSearch({ status: 'draft' }).status).toBe('open')
    expect(isOpen(order({ status: 'draft' }))).toBe(true)
    expect(isOpen(order({ status: 'partially_paid' }))).toBe(true)
    expect(isOpen(order({ status: 'paid' }))).toBe(false)
  })

  it('按笔退：只列还能退的现金、微信、支付宝，数字照接口；会员那一笔与免单不列', () => {
    expect(refundablePayments(split()).map((choice) => [choice.payment.id, choice.refundableCents])).toEqual([
      ['p1', 1000],
      ['p2', 6000],
    ])
    const member = split({
      settlement: 'member',
      payments: [
        { id: 'b', method: 'balance', amountCents: 5000, createdAt: at, member: true },
        { id: 'c', method: 'cash', amountCents: 1000, createdAt: at, member: true },
        { id: 'f', method: 'alipay', amountCents: 4000, createdAt: at, refundedCents: 0, refundableCents: 4000 },
      ],
      memberCheckout: {
        principalCents: 5000,
        giftCents: 0,
        pointsUsed: 0,
        pointsEarned: 60,
        offlineCents: 1000,
        refundableCents: 6000,
      },
    })
    expect(refundablePayments(member).map((choice) => choice.payment.id)).toEqual(['f'])
    expect(memberRefundableCents(member)).toBe(6000)
    expect(memberRefundAvailable(member)).toBe(true)
    expect(hasOtherPayers(member)).toBe(true)
    const [, cash, friend] = member.payments ?? []
    expect(paymentLabel(cash, member)).toBe('现金（会员结账）')
    expect(paymentLabel(friend, member)).toBe('支付宝')
    // 会员这一笔退完了、朋友那一笔还能退：仍给退款入口
    const memberCheckout = member.memberCheckout && { ...member.memberCheckout, refundableCents: 0 }
    const memberDone = { ...member, memberCheckout }
    expect(memberRefundAvailable(memberDone)).toBe(false)
    expect(refundEntry(memberDone, { roles: ['manager'] })).toBe('available')
    // 重放旧响应、付款上没有可退：普通订单只有一笔时用订单的可退
    const payment = { id: 'x', method: 'cash' as const, amountCents: 30000, createdAt: at }
    expect(refundablePayments(order({ payments: [payment] }))).toEqual([{ payment, refundableCents: 30000 }])
  })

  it('退款入口：部分付款要先收齐；收了一部分又免剩余的，收到的几笔照常能退', () => {
    const manager = { roles: ['manager'] }
    expect(refundEntry(order({ status: 'partially_paid', refundableCents: 0 }), manager)).toBe('not-settled')
    const remainder = order({
      paidCents: 4000,
      refundableCents: 4000,
      compCents: 6000,
      settlement: 'standard',
      payments: [
        { id: 'p', method: 'cash', amountCents: 4000, createdAt: at, refundedCents: 0, refundableCents: 4000 },
        { id: 'c', method: 'comp', amountCents: 6000, reason: '朋友没带钱', createdAt: at },
      ],
    })
    expect(isComped(remainder)).toBe(false)
    expect(hasComp(remainder)).toBe(true)
    expect(refundEntry(remainder, manager)).toBe('available')
    expect(refundablePayments(remainder).map((choice) => choice.payment.id)).toEqual(['p'])
  })

  it('逐笔列出：分几笔收的写第几笔（会员结账那一笔算一笔），免单写原因', () => {
    expect(paymentRows(split())).toEqual([
      { key: '第 1 笔 · 微信', value: '¥40.00' },
      { key: '第 2 笔 · 支付宝', value: '¥60.00' },
    ])
    const memberSplit = order({
      settlement: 'member',
      payments: [
        { id: 'b', method: 'balance', amountCents: 5000, createdAt: at, member: true },
        {
          id: 'c',
          method: 'cash',
          amountCents: 1000,
          createdAt: at,
          member: true,
          cashReceivedCents: 2000,
          changeCents: 1000,
        },
        { id: 'f', method: 'wechat', amountCents: 2000, createdAt: at },
        { id: 'z', method: 'comp', amountCents: 2000, reason: '老顾客', createdAt: at },
      ],
    })
    expect(paymentRows(memberSplit)).toEqual([
      { key: '第 1 笔 · 储值余额', value: '¥50.00' },
      { key: '第 1 笔 · 现金（会员结账）', value: '¥10.00（实收 ¥20.00 · 找零 ¥10.00）' },
      { key: '第 2 笔 · 微信', value: '¥20.00' },
      { key: '免单', value: '¥20.00（老顾客）' },
    ])
    // 一笔收齐的照旧只写方式；会员结账一次收齐（旧响应没标 member）也不分笔
    expect(paymentRows(order({ payments: [{ id: 'x', method: 'cash', amountCents: 100, createdAt: at }] }))).toEqual([
      { key: '现金', value: '¥1.00' },
    ])
    const legacyMember = order({
      settlement: 'member',
      payments: [
        { id: 'b', method: 'balance', amountCents: 5000, createdAt: at },
        { id: 'c', method: 'cash', amountCents: 100, createdAt: at },
      ],
    })
    expect(paymentNumbers(legacyMember).size).toBe(0)
  })
})
