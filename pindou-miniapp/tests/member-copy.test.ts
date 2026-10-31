import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../src/services/membership'
import { memberCopy, registeredEntry } from '../src/services/member-copy'

const consume: Entry = {
  id: 'consume-1',
  accountId: 'a1',
  kind: 'consume',
  sourceId: '',
  reason: '店内备注，不发给顾客',
  principalCents: -7990,
  giftCents: 0,
  points: [],
  boardUses: -1,
  serviceDate: '2026-10-25',
  createdAt: '2026-10-27T02:00:00Z',
  consumption: {
    packageId: 'p1',
    packageName: '3 小时',
    headcount: 1,
    dayType: 'holiday',
    amountCents: 7990,
    extraCents: 0,
  },
  balanceAfter: { principalCents: 80810, giftCents: 12000, boardUses: 1 },
}
const recharge: Entry = {
  ...consume,
  id: 'recharge-1',
  kind: 'recharge',
  consumption: undefined,
  principalCents: 88800,
  giftCents: 12000,
  boardUses: 2,
  rule: { name: '888 送 120' } as Entry['rule'],
  balanceAfter: { principalCents: 88800, giftCents: 12000, boardUses: 2 },
}
const copy = (entry: Entry, entries: Entry[] = []) => memberCopy(entry, entries, '2026-10-27')

afterEach(() => vi.useRealTimers())

describe('复制给顾客', () => {
  it('消费逐字符合约定，用业务日期、登记后快照，不复制备注', () => {
    expect(copy(consume)).toBe(
      [
        'EXAMPLE 示例工坊 · 消费记录',
        '10月25日 单人 · 3 小时 · 节假日',
        '消费 ¥79.90，余额扣 ¥79.90',
        '余额 ¥928.10（其中赠送 ¥120.00）',
        '智能豆板用 1 次，剩 1 次',
      ].join('\n'),
    )
    const later = { ...recharge, balanceAfter: { principalCents: 999999, giftCents: 0, boardUses: 99 } }
    expect(copy(consume, [consume, later])).toBe(copy(consume))
    expect(copy(consume)).not.toContain(consume.reason)
  })

  it('充值逐字符合约定，到账总额有千分位，赠送次数来自这条流水', () => {
    expect(copy(recharge)).toBe(
      [
        'EXAMPLE 示例工坊 · 充值记录',
        '10月25日 充值「888 送 120」',
        '付 ¥888.00，到账 ¥1,008.00，送智能豆板 2 次',
        '余额 ¥1,008.00（其中赠送 ¥120.00）',
        '智能豆板剩 2 次',
      ].join('\n'),
    )
    expect(
      copy({
        ...recharge,
        giftCents: 0,
        boardUses: undefined,
        balanceAfter: { principalCents: 88800, giftCents: 0, boardUses: 1 },
      }),
    ).toBe(
      [
        'EXAMPLE 示例工坊 · 充值记录',
        '10月25日 充值「888 送 120」',
        '付 ¥888.00，到账 ¥888.00',
        '余额 ¥888.00',
        '智能豆板剩 1 次',
      ].join('\n'),
    )
  })

  it('双人工作日、另付、零赠送和未用豆板都有对应文案', () => {
    expect(
      copy({
        ...consume,
        boardUses: undefined,
        principalCents: -2990,
        consumption: { ...consume.consumption!, headcount: 2, dayType: 'workday', extraCents: 5000 },
        balanceAfter: { principalCents: 0, giftCents: 0, boardUses: 1 },
      }),
    ).toBe(
      [
        'EXAMPLE 示例工坊 · 消费记录',
        '10月25日 双人 · 3 小时 · 工作日',
        '消费 ¥79.90，余额扣 ¥29.90',
        '余额不够，另付 ¥50.00',
        '余额 ¥0.00',
        '智能豆板剩 1 次',
      ].join('\n'),
    )
    expect(copy({ ...consume, principalCents: 0, consumption: { ...consume.consumption!, amountCents: 0 } })).toContain(
      '消费 ¥0.00，余额扣 ¥0.00',
    )
  })

  it('跨年加年份，没有业务日期时按门店日期兜底，今年也按门店时区判断', () => {
    expect(copy({ ...consume, serviceDate: '2025-12-31' })).toContain('2025年12月31日 单人')
    expect(copy({ ...consume, serviceDate: undefined, createdAt: '2026-10-24T16:01:00Z' })).toContain('10月25日 单人')
    vi.useFakeTimers().setSystemTime(new Date('2026-12-31T16:01:00Z'))
    expect(memberCopy({ ...consume, serviceDate: '2026-12-31' })).toContain('2026年12月31日 单人')
    expect(memberCopy({ ...consume, serviceDate: '2027-01-01' })).toContain('\n1月1日 单人')
  })

  it('已撤销消费和不支持的流水不给复制，旧流水缺快照不能倒推余额', () => {
    const reverse: Entry = { ...consume, id: 'reverse-1', kind: 'consume_reverse', sourceId: consume.id }
    expect(copy(consume, [consume, reverse])).toBeNull()
    expect(copy(reverse)).toBeNull()
    expect(copy({ ...consume, kind: 'adjust' })).toBeNull()
    expect(copy({ ...consume, consumption: undefined })).toBeNull()
    expect(copy({ ...consume, balanceAfter: undefined })).toBeNull()
    expect(copy({ ...recharge, balanceAfter: undefined })).toBeNull()
    expect(copy({ ...consume, serviceDate: '无效日期' })).toBeNull()
  })

  it('登记成功只取响应里新增的同类流水，不误拿以前的记录', () => {
    const next = { ...consume, id: 'consume-2' }
    expect(registeredEntry([consume], [consume, recharge, next], 'consume')).toBe(next)
    expect(registeredEntry([consume], [consume, recharge], 'recharge')).toBe(recharge)
    expect(registeredEntry([consume], [consume, recharge], 'consume')).toBeUndefined()
  })
})
