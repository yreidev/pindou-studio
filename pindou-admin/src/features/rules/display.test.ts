import { describe, expect, it } from 'vitest'
import type { LoyaltyRule, PublicationRecord } from '../../api/rules'
import { actorName, parseRulesSearch, publicationAction, ruleRows, ruleSummary, sameContent } from './display'
import { blankRule } from './form'

const rule = (patch: Partial<LoyaltyRule>): LoyaltyRule => ({ ...blankRule(patch.kind ?? 'recharge'), ...patch })
const owner = { id: 'u-owner', nickname: '阿贝', phoneMasked: '138****0001' }
const publication = (r: LoyaltyRule, createdAt: string, impact = '说明'): PublicationRecord => ({
  id: `p-${createdAt}`,
  rule: r,
  actorId: owner.id,
  actor: owner,
  createdAt,
  impact,
})

describe('规则要点', () => {
  it('充值方案要点写出送豆板次数，旧方案不多写', () => {
    expect(ruleSummary(rule({ boardUses: 2 }))).toContain('送智能豆板 2 次（不过期）')
    expect(ruleSummary(rule({}))).not.toContain('豆板')
  })
  it('金额按元、比例按百分比显示', () => {
    expect(
      ruleSummary(
        rule({ kind: 'tier', amountCents: 50000, rateBasisPoints: 9000, mode: 'cumulative', validDays: 365 }),
      ),
    ).toBe('累计充值满 ¥500.00 · 会员价为原价的 90% · 等级 365 天内有效')
    expect(ruleSummary(rule({ kind: 'recharge', amountCents: 10000, giftCents: 1000, points: 0 }))).toBe(
      '充值 ¥100.00 · 赠送余额 ¥10.00 · 不赠积分',
    )
    expect(
      ruleSummary(rule({ kind: 'redeem', points: 100, amountCents: 1000, maxBasisPoints: 1250, minimumPoints: 200 })),
    ).toBe('每 100 积分抵 ¥10.00 · 每单最多抵应付的 12.5% · 最低使用 200 积分 · 不与会员折扣叠加')
    expect(
      ruleSummary(
        rule({
          kind: 'package',
          amountCents: 6880,
          durationMinutes: 180,
          renewalMinutes: 30,
          renewalCents: 1500,
          overtime: 'free',
        }),
      ),
    ).toBe('180 分钟 ¥68.80 · 续时每次 30 分钟 ¥15.00 · 不能暂停 · 超时免费')
    expect(
      ruleSummary(
        rule({
          kind: 'package',
          amountCents: 2990,
          durationMinutes: 60,
          renewalMinutes: 30,
          renewalCents: 1500,
          pauseLimitMinutes: 10,
          overtime: 'renewal',
          overtimeGraceMinutes: 10,
        }),
      ),
    ).toBe('60 分钟 ¥29.90 · 续时每次 30 分钟 ¥15.00 · 累计免费暂停 10 分钟 · 超时宽限 10 分钟，之后按续时方案自动加收')
    // 到打烊、未定价（系统内收费关着时套餐可以不填价）
    expect(ruleSummary(rule({ kind: 'package', amountCents: 0, untilClose: true, overtime: 'manual' }))).toBe(
      '到打烊 未定价 · 不能续时、暂停 · 超时提示员工处理',
    )
    expect(ruleSummary(rule({ kind: 'package', amountCents: 0, durationMinutes: 120, overtime: 'free' }))).toBe(
      '120 分钟 未定价 · 不提供续时 · 不能暂停 · 超时免费',
    )
    expect(ruleSummary(rule({ kind: 'free_timing', amountCents: 1000, durationMinutes: 30 }))).toBe(
      '每 30 分钟 ¥10.00 · 折合每小时 ¥20.00 · 不足一块按一块',
    )
    expect(ruleSummary(rule({ kind: 'companion', amountCents: 2000 }))).toBe('陪客会话结账带一行 ¥20.00 · 不计时')
  })

  it('兑换、生日礼物显示商品名，读不到商品时显示编号', () => {
    const products = [{ id: 'p-key', name: '拼豆钥匙扣', unitPriceCents: 1500 }]
    expect(
      ruleSummary(rule({ kind: 'exchange', points: 300, productId: 'p-key', quantity: 50, perUserLimit: 2 }), products),
    ).toBe('300 积分兑换「拼豆钥匙扣」 · 累计可兑 50 件 · 每人限 2 次')
    expect(
      ruleSummary(
        rule({
          kind: 'birthday',
          mode: 'day',
          scope: 'gift',
          productId: 'abcdef123456',
          perUserLimit: 1,
          validDays: 7,
        }),
      ),
    ).toBe('生日当天 · 送礼物「商品 abcdef12」 · 每年限领 1 次 · 领取后 7 天内有效')
  })
})

describe('规则状态', () => {
  const live = rule({ id: 'a', name: '充 100', amountCents: 10000, enabled: true })
  const edited = { ...live, giftCents: 500, enabled: false }
  const stopped = rule({ id: 'b', name: '充 50', amountCents: 5000 })
  const fresh = rule({ id: 'c', name: '充 200', amountCents: 20000 })
  const data = {
    drafts: { a: edited, b: stopped, c: fresh, t: rule({ id: 't', kind: 'tier', name: '黄金' }) },
    rules: [live],
    publications: [
      publication({ ...stopped, enabled: false }, '2026-10-03T00:00:00Z', '停售'),
      publication(live, '2026-10-02T00:00:00Z'),
      publication({ ...stopped, enabled: true }, '2026-10-01T00:00:00Z'),
    ],
  }

  it('生效中在前，其次未发布、已停用；只列本类别', () => {
    const rows = ruleRows(data, 'recharge')
    expect(rows.map((row) => [row.draft.id, row.status])).toEqual([
      ['a', 'active'],
      ['c', 'unpublished'],
      ['b', 'disabled'],
    ])
    expect(rows[0].changed).toBe(true)
    expect(rows[0].active).toBe(live)
    expect(rows[2].latest?.impact).toBe('停售')
    expect(ruleRows(data, 'package')).toEqual([])
  })

  it('比较内容不看 enabled', () => {
    expect(sameContent(live, { ...live, enabled: false })).toBe(true)
    expect(sameContent(live, edited)).toBe(false)
  })

  it('发布记录：发布或停用，操作人显示服务端带的昵称，账户不在了显示编号', () => {
    expect(publicationAction(data.publications[0])).toBe('停用')
    expect(publicationAction(data.publications[1])).toBe('发布')
    expect(actorName(data.publications[0])).toBe('阿贝')
    expect(actorName({ actorId: '12345678-xxxx', actor: null })).toBe('账号 12345678')
  })
})

describe('网址参数', () => {
  it('标签页只认类别和发布历史', () => {
    expect(parseRulesSearch({ tab: 'package' })).toEqual({ tab: 'package' })
    expect(parseRulesSearch({ tab: 'history' })).toEqual({ tab: 'history' })
    expect(parseRulesSearch({ tab: 'nope' })).toEqual({})
    expect(parseRulesSearch({})).toEqual({})
  })
})
