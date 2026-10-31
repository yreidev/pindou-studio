import { describe, expect, it } from 'vitest'
import type { Order } from '../../api/orders'
import { balanceAfterItems, balanceRows, canPrintReceipt, parseReceiptSearch, receiptOf } from './receipt'

const base: Order = {
  id: '5e5e5e5e-0000-4000-8000-000000000001',
  version: 'a'.repeat(64),
  status: 'paid',
  receivableCents: 13500,
  paidCents: 13500,
  refundedCents: 0,
  refundableCents: 13500,
  settlement: 'standard',
  createdAt: '2026-10-05T02:00:00Z',
  accountId: undefined,
  customer: null,
  lines: [
    { productId: 'p1', name: '拼豆材料包', quantity: 2, unitPriceCents: 2000 },
    { name: '计时 60 分钟', quantity: 1, unitPriceCents: 10000 },
  ],
  discounts: [
    { id: 'd1', kind: 'percentage', rateBasisPoints: 1000, reason: '老顾客', createdAt: '2026-10-05T02:10:00Z' },
  ],
  payments: [{ id: 'p', method: 'cash', amountCents: 13500, createdAt: '2026-10-05T02:15:00Z' }],
  refunds: [],
}

describe('小票内容', () => {
  it('散客单：门店、订单短码、门店时区的收款时间、明细、折扣、应收、付款与实收，全照接口', () => {
    expect(receiptOf(base, '示例工坊')).toEqual({
      store: '示例工坊',
      number: '5e5e5e5e',
      status: '已付款',
      time: { label: '收款时间', value: '2026-10-05 10:15' },
      customer: undefined,
      lines: [
        { name: '拼豆材料包', detail: '¥20.00 ×2' },
        { name: '计时 60 分钟', detail: '¥100.00 ×1' },
      ],
      discounts: [{ label: '老顾客', value: '减 10%' }],
      receivable: '¥135.00',
      payments: [{ label: '现金', value: '¥135.00' }],
      paid: '¥135.00',
      refunds: [],
      member: [],
      balanceAfter: [],
    })
  })

  it('现金填了实收的：付款下面印实收现金与找零，照付款记录（后端算好的），没填的不印', () => {
    const receipt = receiptOf({
      ...base,
      payments: [
        {
          id: 'p',
          method: 'cash',
          amountCents: 13500,
          cashReceivedCents: 20000,
          changeCents: 6500,
          createdAt: '2026-10-05T02:15:00Z',
        },
      ],
    })
    expect(receipt.payments).toEqual([
      { label: '现金', value: '¥135.00' },
      { label: '实收现金', value: '¥200.00' },
      { label: '找零', value: '¥65.00' },
    ])
    // 刚好给够也照印找零 ¥0.00
    expect(
      receiptOf({
        ...base,
        payments: [
          {
            id: 'p',
            method: 'cash',
            amountCents: 13500,
            cashReceivedCents: 13500,
            changeCents: 0,
            createdAt: '2026-10-05T02:15:00Z',
          },
        ],
      }).payments.at(-1),
    ).toEqual({ label: '找零', value: '¥0.00' })
  })

  it('会员结账单：顾客只印称呼不印手机号；储值、积分变动照 memberCheckout，是 0 的不印', () => {
    const receipt = receiptOf({
      ...base,
      accountId: 'u-li',
      customer: { id: 'u-li', nickname: '小李', phoneMasked: '139****0002' },
      settlement: 'member',
      receivableCents: 9700,
      paidCents: 9700,
      memberCheckout: {
        principalCents: 5000,
        giftCents: 0,
        pointsUsed: 30,
        pointsEarned: 97,
        offlineCents: 4700,
        balanceAfter: { principalCents: 12000, giftCents: 500, points: 1234 },
      },
      discounts: [
        { id: 'd2', kind: 'fixed', amountCents: 300, reason: '积分抵扣 30 积分', createdAt: '2026-10-05T02:15:00Z' },
      ],
      payments: [
        { id: 'b', method: 'balance', amountCents: 5000, createdAt: '2026-10-05T02:15:00Z' },
        { id: 'c', method: 'wechat', amountCents: 4700, createdAt: '2026-10-05T02:15:00Z' },
      ],
    })
    expect(receipt.customer).toBe('小李')
    expect(JSON.stringify(receipt)).not.toContain('139')
    expect(receipt.discounts).toEqual([{ label: '积分抵扣 30 积分', value: '-¥3.00' }])
    expect(receipt.payments).toEqual([
      { label: '储值余额', value: '¥50.00' },
      { label: '微信', value: '¥47.00' },
    ])
    expect(receipt.member).toEqual([
      { label: '储值本金支付', value: '-¥50.00' },
      { label: '积分抵扣', value: '-30 积分' },
      { label: '本单获得积分', value: '+97 积分' },
    ])
    // 本单结账后的余额（接口由会员流水推出，不是打印时的余额）
    expect(receipt.balanceAfter).toEqual([
      { label: '储值本金', value: '¥120.00' },
      { label: '赠送余额', value: '¥5.00' },
      { label: '可用积分', value: '1,234 积分' },
    ])
  })

  it('免单：状态印「免单」，结清记录印免掉的金额和原因，实收照接口是 0', () => {
    const receipt = receiptOf(
      {
        ...base,
        settlement: 'comp',
        paidCents: 0,
        refundableCents: 0,
        compCents: 13500,
        payments: [
          { id: 'c', method: 'comp', amountCents: 13500, reason: '老顾客生日', createdAt: '2026-10-05T02:15:00Z' },
        ],
      },
      '示例工坊',
    )
    expect(receipt.status).toBe('免单')
    expect(receipt.payments).toEqual([
      { label: '免单', value: '¥135.00' },
      { label: '免单原因', value: '老顾客生日' },
    ])
    expect(receipt.paid).toBe('¥0.00')
  })

  it('接口没给结账后余额（列表里的订单）时不印余额', () => {
    const receipt = receiptOf({
      ...base,
      accountId: 'u-li',
      settlement: 'member',
      memberCheckout: { principalCents: 0, giftCents: 0, pointsUsed: 0, pointsEarned: 10, offlineCents: 13500 },
    })
    expect(receipt.balanceAfter).toEqual([])
    expect(receipt.member).toEqual([{ label: '本单获得积分', value: '+10 积分' }])
  })

  it('结账页、订单详情列「结账后…」几行，接口没给时不列', () => {
    expect(balanceAfterItems({ balanceAfter: { principalCents: 12000, giftCents: 0, points: 1234 } })).toEqual([
      { key: '结账后储值本金', value: '¥120.00' },
      { key: '结账后赠送余额', value: '¥0.00' },
      { key: '结账后可用积分', value: '1,234 积分' },
    ])
    expect(balanceAfterItems({})).toEqual([])
    expect(balanceAfterItems(undefined)).toEqual([])
  })

  it('全部用积分抵扣、没有付款记录时印下单时间；退过款的印退款与状态', () => {
    expect(receiptOf({ ...base, payments: [] }).time).toEqual({ label: '下单时间', value: '2026-10-05 10:00' })
    const refunded = receiptOf({
      ...base,
      refundedCents: 2000,
      refundableCents: 11500,
      refunds: [{ id: 'r', reason: '退货', amountCents: 2000, createdAt: '2026-10-05T03:00:00Z' }],
    })
    expect(refunded.status).toBe('部分退款')
    expect(refunded.refunds).toEqual([{ label: '退款 2026-10-05 11:00', value: '-¥20.00' }])
    expect(receiptOf({ ...base, status: 'refunded' }).status).toBe('已退款')
  })

  it('只有收过款的订单能打印；余额逐项照接口', () => {
    expect(canPrintReceipt({ status: 'paid' })).toBe(true)
    expect(canPrintReceipt({ status: 'refunded' })).toBe(true)
    expect(canPrintReceipt({ status: 'draft' })).toBe(false)
    expect(canPrintReceipt({ status: 'voided' })).toBe(false)
    expect(balanceRows({ principalCents: 12000, giftCents: 500, points: 1234 })).toEqual([
      { label: '储值本金', value: '¥120.00' },
      { label: '赠送余额', value: '¥5.00' },
      { label: '可用积分', value: '1,234 积分' },
    ])
  })

  it('分笔付款逐笔印「第 n 笔」，会员结账那一笔写明；收了一部分又免剩余的印免单与原因', () => {
    const at = '2026-10-06T02:00:00Z'
    const receipt = receiptOf(
      {
        id: 'a1b2c3d4-0000-4000-8000-000000000009',
        version: 'v'.repeat(64),
        status: 'paid',
        receivableCents: 10000,
        paidCents: 8000,
        refundedCents: 0,
        refundableCents: 8000,
        compCents: 2000,
        settlement: 'member',
        createdAt: at,
        accountId: 'u1',
        customer: { id: 'u1', nickname: '小林', phoneMasked: '139****0002' },
        payments: [
          { id: 'b', method: 'balance', amountCents: 5000, createdAt: at, member: true },
          { id: 'c', method: 'cash', amountCents: 1000, createdAt: at, member: true },
          { id: 'f', method: 'alipay', amountCents: 2000, createdAt: '2026-10-06T02:05:00Z' },
          { id: 'z', method: 'comp', amountCents: 2000, reason: '朋友没带钱', createdAt: '2026-10-06T02:06:00Z' },
        ],
      },
      '示例工坊',
    )
    expect(receipt.status).toBe('已付款（剩余免单）')
    expect(receipt.payments).toEqual([
      { label: '第 1 笔 储值余额', value: '¥50.00' },
      { label: '第 1 笔 现金（会员结账）', value: '¥10.00' },
      { label: '第 2 笔 支付宝', value: '¥20.00' },
      { label: '免单', value: '¥20.00' },
      { label: '免单原因', value: '朋友没带钱' },
    ])
    expect(receipt.paid).toBe('¥80.00')
    expect(receipt.time).toEqual({ label: '收款时间', value: '2026-10-06 10:06' })
  })

  it('网址里的纸宽：认识的才用', () => {
    expect(parseReceiptSearch({ paper: '58' })).toEqual({ paper: '58' })
    expect(parseReceiptSearch({ paper: 80 })).toEqual({ paper: '80' })
    expect(parseReceiptSearch({ paper: 'a4' })).toEqual({ paper: 'a4' })
    expect(parseReceiptSearch({ paper: 'A3' })).toEqual({})
    expect(parseReceiptSearch({})).toEqual({})
  })
})
