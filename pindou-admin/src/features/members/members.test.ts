import { describe, expect, it } from 'vitest'
import type { LoyaltyEntry } from '../../api/members'
import {
  canRefundRecharge,
  entriesById,
  entryKindName,
  entryReason,
  entrySource,
  grantedPointsExpiry,
  newestFirst,
  pointsChange,
  refundedRechargeIds,
} from './entries'
import {
  defaultRechargeMethod,
  exchangeConfirmText,
  exchangeRules,
  giftConfirmText,
  pendingGifts,
  rechargeConfirmText,
  rechargeMethods,
  rechargeRules,
} from './counter'
import { actionErrorMessage, counterErrorMessage, isConflict } from './errors'
import {
  adjustChange,
  adjustFormSchema,
  adjustOutcome,
  adjustSummary,
  parsePoints,
  parseSignedYuan,
  refundFormSchema,
} from './forms'
import { birthdayLabel, discountLabel, parseMembersSearch, signedMoney, signedPoints } from './members'
import { blankRule } from '../rules/form'

const entry = (overrides: Partial<LoyaltyEntry> & Pick<LoyaltyEntry, 'id' | 'kind'>): LoyaltyEntry => ({
  accountId: 'a1',
  sourceId: '',
  reason: '',
  principalCents: 0,
  giftCents: 0,
  points: [],
  createdAt: '2026-10-01T04:00:00Z',
  ...overrides,
})

describe('会员页网址参数', () => {
  it('搜索词去掉首尾空白，手打的纯数字尾号转回文字；空词、第 1 页不写', () => {
    expect(parseMembersSearch({ q: ' 林 ', account: 'u1', page: 2, listPage: 3 })).toEqual({
      q: '林',
      account: 'u1',
      page: 2,
      listPage: 3,
    })
    expect(parseMembersSearch({ q: 1234 })).toEqual({ q: '1234' })
    expect(parseMembersSearch({ q: '  ', page: 1, listPage: 1, account: '' })).toEqual({})
  })

  it('乱写的参数当没填，页码转成数字', () => {
    expect(parseMembersSearch({ page: 'abc', listPage: -1, account: 5 })).toEqual({})
    expect(parseMembersSearch({ page: '2', listPage: '4' })).toEqual({ page: 2, listPage: 4 })
    expect(parseMembersSearch({ q: 'x'.repeat(101) })).toEqual({})
  })
})

describe('资产显示', () => {
  it('金额、积分带正负号，只用整数', () => {
    expect(signedMoney(150)).toBe('+¥1.50')
    expect(signedMoney(-100001)).toBe('-¥1,000.01')
    expect(signedMoney(0)).toBe('¥0.00')
    expect(signedPoints(1200)).toBe('+1,200')
    expect(signedPoints(-20)).toBe('-20')
    expect(signedPoints(0)).toBe('0')
  })

  it('折扣按基点换成「几折」，生日只显示月日与设置年份', () => {
    expect(discountLabel(10000)).toBe('不打折')
    expect(discountLabel(9500)).toBe('9.5 折')
    expect(discountLabel(9000)).toBe('9 折')
    expect(discountLabel(8850)).toBe('8.85 折')
    expect(birthdayLabel({ birthday: '', birthdayYear: 0 })).toBe('未设置')
    expect(birthdayLabel({ birthday: '03-05', birthdayYear: 2026 })).toBe('3 月 5 日（2026 年设置）')
  })
})

describe('资产流水', () => {
  const recharge = entry({
    id: 'e-recharge',
    kind: 'recharge',
    sourceId: 'rule-500',
    method: 'wechat',
    principalCents: 50000,
    giftCents: 5000,
    points: [{ lotId: 'e-recharge', delta: 100, expiresAt: '2027-10-01T04:00:00Z' }],
    rule: { ...blankRule('recharge'), name: '充 500 送 50' },
  })
  const refund = entry({
    id: 'e-refund',
    kind: 'recharge_refund',
    sourceId: 'e-recharge',
    method: 'wechat',
    reason: '顾客搬家',
    principalCents: -50000,
    giftCents: -5000,
    points: [{ lotId: 'e-recharge', delta: -100 }],
    createdAt: '2026-10-02T04:00:00Z',
  })
  const second = entry({ id: 'e-second', kind: 'recharge', createdAt: '2026-10-03T04:00:00Z', method: 'cash' })
  const checkout = entry({
    id: 'e-checkout',
    kind: 'checkout',
    sourceId: '12345678-order',
    principalCents: -3000,
    points: [
      { lotId: 'l1', delta: -30 },
      { lotId: 'l2', delta: -20 },
    ],
  })
  const orderRefund = entry({ id: 'e-order-refund', kind: 'refund', sourceId: 'e-checkout', reason: '做错了' })
  const birthday = entry({ id: 'e-bday', kind: 'birthday', rule: { ...blankRule('birthday'), name: '生日 9 折' } })
  const used = entry({ id: 'e-used', kind: 'birthday_used', sourceId: 'e-bday', reason: 'abcdef12-order' })
  const all = [recharge, refund, second, checkout, orderRefund, birthday, used]
  const byId = entriesById(all)

  it('积分按批次求和，发放的积分给出最早到期日', () => {
    expect(pointsChange(checkout)).toBe(-50)
    expect(pointsChange({ points: null })).toBe(0)
    expect(grantedPointsExpiry(recharge)).toBe('2027-10-01T04:00:00Z')
    expect(grantedPointsExpiry(refund)).toBeUndefined()
  })

  it('最新的在前；只有没退过的充值能退', () => {
    expect(newestFirst([recharge, refund, second]).map((e) => e.id)).toEqual(['e-second', 'e-refund', 'e-recharge'])
    const refunded = refundedRechargeIds(all)
    expect(canRefundRecharge(recharge, refunded)).toBe(false)
    expect(canRefundRecharge(second, refunded)).toBe(true)
    expect(canRefundRecharge(checkout, refunded)).toBe(false)
  })

  it('类型、来源与原因的中文说明', () => {
    expect(entryKindName('recharge_refund')).toBe('充值退款')
    expect(entryKindName('future_kind')).toBe('future_kind')
    expect(entrySource(recharge, byId)).toBe('充 500 送 50 · 微信线下收款')
    expect(entrySource(refund, byId)).toBe('退回 2026-10-01 12:00 的充值（充 500 送 50） · 微信线下收款')
    expect(entrySource(checkout, byId)).toBe('订单 12345678')
    expect(entrySource(orderRefund, byId)).toBe('订单 12345678 退款')
    expect(entrySource(used, byId)).toBe('生日 9 折 · 订单 abcdef12')
    // 生日折扣使用的 reason 存的是订单编号，不当原因显示
    expect(entryReason(used)).toBe('')
    expect(entryReason(refund)).toBe('顾客搬家')
  })
})

describe('手动加减与退款表单', () => {
  it('元可带正负号转整数分，积分是整数，留空当 0', () => {
    expect(parseSignedYuan('12.3')).toBe(1230)
    expect(parseSignedYuan('-0.05')).toBe(-5)
    expect(parseSignedYuan('+1')).toBe(100)
    expect(parseSignedYuan(' ')).toBe(0)
    expect(parseSignedYuan('-0')).toBe(0)
    expect(parseSignedYuan('1.234')).toBeNull()
    expect(parseSignedYuan('abc')).toBeNull()
    expect(parseSignedYuan('10000000.01')).toBeNull()
    expect(parseSignedYuan('10000000')).toBe(1_000_000_000)
    expect(parsePoints('-20')).toBe(-20)
    expect(parsePoints('')).toBe(0)
    expect(parsePoints('1.5')).toBeNull()
    expect(parsePoints('1000000001')).toBeNull()
  })

  it('原因必填、最多 200 字，至少调整一项', () => {
    const issues = (values: Parameters<typeof adjustFormSchema.safeParse>[0]) =>
      adjustFormSchema.safeParse(values).error?.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`) ?? []
    expect(issues({ principal: '', gift: '', points: '', boardUses: '', reason: '' })).toEqual([
      'reason:请填写调整原因',
      'principal:本金、赠送余额、积分、智能豆板次数至少调整一项',
    ])
    expect(issues({ principal: '1.001', gift: '', points: 'x', boardUses: '', reason: '  ' })).toEqual([
      'principal:金额最多两位小数，可带负号，绝对值不超过 1000 万元',
      'points:积分须为整数，可带负号，绝对值不超过 10 亿',
      'reason:请填写调整原因',
    ])
    expect(issues({ principal: '', gift: '', points: '5', boardUses: '', reason: '😀'.repeat(200) })).toEqual([])
    expect(issues({ principal: '', gift: '', points: '5', boardUses: '', reason: '字'.repeat(201) })).toEqual([
      'reason:原因最多 200 字',
    ])
    expect(adjustChange({ principal: '-5', gift: '', points: '+10', boardUses: '', reason: ' 录错了 ' })).toEqual({
      principalCents: -500,
      giftCents: 0,
      points: 10,
      boardUses: 0,
      reason: '录错了',
    })
    expect(adjustChange({ principal: '', gift: '', points: '', boardUses: '', reason: '录错了' })).toBeNull()
    expect(adjustSummary({ principalCents: -500, giftCents: 0, points: 10, boardUses: 0 })).toBe(
      '本金 -¥5.00、积分 +10',
    )
    expect(adjustSummary({ principalCents: 0, giftCents: 1999, points: 0, boardUses: 0 })).toBe('赠送余额 +¥19.99')
    const balance = { principalCents: 500, giftCents: 0, points: 30, boardUses: 0 }
    expect(adjustOutcome(balance, { principalCents: -500, giftCents: 0, points: 10, boardUses: 0 })).toEqual({
      after: { principalCents: 0, giftCents: 0, points: 40, boardUses: 0 },
      short: [],
    })
    expect(adjustOutcome(balance, { principalCents: -501, giftCents: -1, points: -31, boardUses: 0 }).short).toEqual([
      '本金',
      '赠送余额',
      '积分',
    ])
    expect(refundFormSchema.safeParse({ reason: '' }).success).toBe(false)
    expect(refundFormSchema.safeParse({ reason: '顾客要求' }).success).toBe(true)
  })

  it('失败说明：业务错误原样显示，鉴权的英文 forbidden 换成中文；409 要重读', () => {
    expect(actionErrorMessage({ status: 409, message: '余额或可用积分不足' })).toBe('余额或可用积分不足')
    expect(actionErrorMessage({ status: 403, message: 'forbidden' })).toContain('只有老板能办理')
    expect(isConflict({ status: 409 })).toBe(true)
    expect(isConflict({ status: 503 })).toBe(false)
    expect(isConflict(null)).toBe(false)
    // 「上次已生效」也是 409，但那是提醒，不要人重读后再确认
    expect(isConflict({ status: 409, code: 'previous_applied' })).toBe(false)
    // 柜台三项所有员工都能办：403 不说「只有老板」，原样显示接口客户端给的中文
    expect(counterErrorMessage({ status: 403, message: '当前账号无权执行此操作' })).toBe('当前账号无权执行此操作')
    expect(counterErrorMessage({ status: 409, message: '兑换次数已达上限' })).toBe('兑换次数已达上限')
    expect(counterErrorMessage(null)).toBe('操作失败，请稍后重试')
  })
})

describe('柜台三项', () => {
  const rule = (kind: Parameters<typeof blankRule>[0], overrides: Partial<ReturnType<typeof blankRule>>) => ({
    ...blankRule(kind),
    enabled: true,
    ...overrides,
  })

  it('只列已发布的充值方案和兑换商品；收款方式默认微信，次序同小程序', () => {
    const rules = [
      rule('recharge', { id: 'r1', name: '充 500 送 50' }),
      rule('exchange', { id: 'x1', name: '钥匙扣' }),
      rule('earn', { id: 'e1', name: '消费积分' }),
      rule('recharge', { id: 'r2', name: '充 1000 送 150' }),
    ]
    expect(rechargeRules(rules).map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(exchangeRules(rules).map((r) => r.id)).toEqual(['x1'])
    expect(rechargeMethods.map((m) => m.label)).toEqual(['微信线下收款', '现金', '支付宝线下收款'])
    expect(defaultRechargeMethod).toBe('wechat')
  })

  it('确认话与小程序一致，金额按整数分显示', () => {
    expect(
      rechargeConfirmText(
        rule('recharge', { name: '充 500 送 50', amountCents: 50000, giftCents: 5005, points: 1200 }),
      ),
    ).toBe('已收到该顾客 ¥500.00？确认后本金入账，赠送 ¥50.05 和 1,200 积分。')
    expect(exchangeConfirmText(rule('exchange', { name: '拼豆钥匙扣', points: 300 }))).toBe(
      '扣除 300 积分并出库一件 拼豆钥匙扣？',
    )
    expect(giftConfirmText).toBe('确认交付生日礼物并扣减库存？')
  })

  it('待核销的生日礼物：礼物类、还没核销的，最新领取的在前；积分类生日福利不算', () => {
    const gift = (id: string, createdAt: string) =>
      entry({ id, kind: 'birthday', rule: rule('birthday', { name: '生日小熊', scope: 'gift' }), createdAt })
    const old = gift('g-old', '2026-03-05T02:00:00Z')
    const done = gift('g-done', '2026-04-01T02:00:00Z')
    const fresh = gift('g-new', '2026-10-05T02:00:00Z')
    const points = entry({ id: 'b-points', kind: 'birthday', rule: rule('birthday', { scope: 'points' }) })
    const fulfilled = entry({ id: 'f1', kind: 'fulfill_gift', sourceId: 'g-done' })
    expect(pendingGifts([old, done, points, fulfilled, fresh]).map((e) => e.id)).toEqual(['g-new', 'g-old'])
    expect(pendingGifts([])).toEqual([])
  })
})
