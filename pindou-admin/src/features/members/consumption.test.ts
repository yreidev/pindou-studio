import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoyaltyEntry } from '../../api/members'
import { adjustChange, adjustOutcome, adjustSummary } from './forms'
import {
  calendarDay,
  consumptionConfirmText,
  consumptionFormSchema,
  consumptionOutcome,
  defaultDayType,
  emptyConsumptionForm,
  memberAccountFormSchema,
  packagesByDuration,
  serviceDateError,
} from './consumption'
import { canReverseConsumption, entryBalanceAfter, entryDate, entryTitle, reversedConsumptionIds } from './entries'
import { rechargeConfirmText } from './counter'
import { blankRule } from '../rules/form'

afterEach(() => vi.useRealTimers())

it('消费套餐按时长、名称排序，到打烊最后；不改变接口返回顺序', () => {
  const rule = blankRule('package')
  const rules = [
    { ...rule, id: 'p3', name: '3 小时', durationMinutes: 180 },
    { ...rule, id: 'close', name: '全天不限时', durationMinutes: 0, untilClose: true as const },
    { ...rule, id: 'p2b', name: '2 小时 B', durationMinutes: 120 },
    { ...rule, id: 'p1', name: '1 小时', durationMinutes: 60 },
    { ...rule, id: 'r1', kind: 'recharge' as const },
    { ...rule, id: 'p2a', name: '2 小时 A', durationMinutes: 120 },
  ]
  const before = rules.map((r) => r.id)
  expect(packagesByDuration(rules).map((r) => r.id)).toEqual(['p1', 'p2a', 'p2b', 'p3', 'close'])
  expect(rules.map((r) => r.id)).toEqual(before)
})

describe('消费日期', () => {
  it('默认用门店今天，周六日默认节假日，工作日照常', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-23T16:01:00Z'))
    expect(emptyConsumptionForm()).toMatchObject({ serviceDate: '2026-10-24', dayType: 'holiday', boardUses: '0' })
    expect(defaultDayType('2026-10-25')).toBe('holiday')
    expect(defaultDayType('2026-10-26')).toBe('workday')
    expect(calendarDay(new Date(2026, 9, 24))).toBe('2026-10-24')
  })

  it('店员可以选今天及前 7 天，更早限店长老板，任何角色都不能选将来', () => {
    expect(serviceDateError('2026-10-20', false, '2026-10-27')).toBeNull()
    expect(serviceDateError('2026-10-19', false, '2026-10-27')).toContain('店长、老板')
    expect(serviceDateError('2025-01-01', true, '2026-10-27')).toBeNull()
    expect(serviceDateError('2026-10-28', true, '2026-10-27')).toContain('将来')
    expect(serviceDateError('2026-02-30', true, '2026-10-27')).toContain('有效日期')
    expect(serviceDateError('', false, '2026-10-27')).toBe('请选择日期')
    expect(serviceDateError('2026-12-25', false, '2027-01-01')).toBeNull()
    expect(serviceDateError('2026-12-24', false, '2027-01-01')).toContain('店长、老板')
  })
})

describe('消费登记与确认', () => {
  const balance = { principalCents: 5000, giftCents: 1200, boardUses: 2 }
  it('先本金再赠送，余额用完记另付，只用豆板也能登记', () => {
    expect(consumptionOutcome(balance, 7990, 1)).toEqual({
      principalCents: 5000,
      giftCents: 1200,
      deductedCents: 6200,
      extraCents: 1790,
      balanceCents: 0,
      boardUses: 1,
    })
    expect(consumptionOutcome(balance, 4999, 0)).toMatchObject({
      principalCents: 4999,
      giftCents: 0,
      extraCents: 0,
      balanceCents: 1201,
    })
    expect(consumptionOutcome(balance, 0, 2)).toMatchObject({
      deductedCents: 0,
      extraCents: 0,
      balanceCents: 6200,
      boardUses: 0,
    })
    expect(consumptionConfirmText(balance, 7990, 1)).toEqual([
      '消费金额 ¥79.90，当前余额 ¥62.00',
      '本次从余额扣 ¥62.00（本金 ¥50.00、赠送 ¥12.00）',
      '余额不够时另付 ¥17.90（在系统外收取）',
      '扣完余额 ¥0.00',
      '智能豆板用 1 次，剩 1 次',
    ])
  })

  it('金额精确到分，金额次数不能全零，不能超过剩余次数或单笔 100 次，其他必填备注', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-27T04:00:00Z'))
    const schema = consumptionFormSchema(false, 2)
    const base = { ...emptyConsumptionForm(), amount: '79.9', reason: '补录消费' }
    expect(schema.safeParse(base).success).toBe(true)
    for (const amount of ['-1', '0.001', '10000000.01'])
      expect(schema.safeParse({ ...base, amount }).success).toBe(false)
    for (const boardUses of ['-1', '1.1', '3']) expect(schema.safeParse({ ...base, boardUses }).success).toBe(false)
    expect(schema.safeParse({ ...base, amount: '0', boardUses: '0' }).success).toBe(false)
    expect(schema.safeParse({ ...base, amount: '0', boardUses: '1' }).success).toBe(true)
    expect(schema.safeParse({ ...base, reason: ' ' }).success).toBe(false)
    expect(schema.safeParse({ ...base, packageId: 'p1', reason: '' }).success).toBe(true)
    expect(schema.safeParse({ ...base, reason: '字'.repeat(201) }).success).toBe(false)
    expect(consumptionFormSchema(true, 200).safeParse({ ...base, boardUses: '101' }).success).toBe(false)
  })
})

describe('消费流水快照与撤销', () => {
  const entry: LoyaltyEntry = {
    id: 'e1',
    accountId: 'a1',
    kind: 'consume',
    sourceId: '',
    reason: '',
    points: [],
    principalCents: -5000,
    giftCents: -1200,
    boardUses: -1,
    createdAt: '2026-10-27T04:00:00Z',
    serviceDate: '2026-10-25',
    consumption: {
      packageId: 'p1',
      packageName: '3 小时',
      headcount: 1,
      dayType: 'holiday',
      amountCents: 7990,
      extraCents: 1790,
    },
    balanceAfter: { principalCents: 0, giftCents: 0, boardUses: 1 },
  }
  it('日期优先业务日期，标题照快照，余额合并显示，撤销不改原记录', () => {
    expect(entryTitle(entry)).toBe('消费 · 单人 · 3 小时 · 节假日')
    expect(entryDate(entry)).toBe('2026-10-25')
    expect(entryDate({ ...entry, serviceDate: undefined })).toBe('2026-10-27 12:00')
    expect(entryBalanceAfter(entry)).toBe('记完余额 ¥0.00 · 豆板 1 次')
    expect(entryBalanceAfter({ ...entry, balanceAfter: undefined })).toBe('')
    expect(canReverseConsumption(entry, new Set())).toBe(true)
    const reverse = { ...entry, id: 'e2', kind: 'consume_reverse' as const, sourceId: 'e1' }
    expect(entryTitle(reverse)).toBe('撤销消费')
    expect(canReverseConsumption(entry, reversedConsumptionIds([entry, reverse]))).toBe(false)
    expect(canReverseConsumption(reverse, new Set())).toBe(false)
  })
})

describe('智能豆板调整和赠送', () => {
  it('次数可单独加减，不能扣成负数，确认话写出次数', () => {
    const change = adjustChange({ principal: '', gift: '', points: '', boardUses: '-2', reason: '补录漏记' })!
    expect(change.boardUses).toBe(-2)
    expect(adjustSummary(change)).toBe('智能豆板 -2 次')
    expect(adjustOutcome({ principalCents: 0, giftCents: 0, points: 0, boardUses: 1 }, change).short).toEqual([
      '智能豆板次数',
    ])
    expect(adjustChange({ principal: '', gift: '', points: '', boardUses: '1001', reason: '补录' })).toBeNull()
    expect(rechargeConfirmText({ ...blankRule('recharge'), boardUses: 2 })).toContain('另送智能豆板 2 次（不过期）')
  })
})

describe('代开会员', () => {
  const base = { nickname: '小林', phone: '+86 138-0013-8000', consent: true }
  it('称呼和手机号必填，允许空格横线，须确认顾客同意', () => {
    expect(memberAccountFormSchema.safeParse(base).success).toBe(true)
    for (const patch of [
      { nickname: '' },
      { nickname: '字'.repeat(51) },
      { phone: '12345' },
      { phone: '1234567890123456' },
      { phone: '号码123456' },
      { consent: false },
    ])
      expect(memberAccountFormSchema.safeParse({ ...base, ...patch }).success).toBe(false)
  })
})
