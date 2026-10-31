import { describe, expect, it } from 'vitest'
import type { LoyaltyRule } from '../../api/rules'
import {
  blankRule,
  fieldOrder,
  formValues,
  hourlyCents,
  impactError,
  ruleFieldErrors,
  ruleFormSchema,
  toRule,
  type RuleFormValues,
} from './form'

const fill = (rule: LoyaltyRule, patch: Partial<RuleFormValues>): RuleFormValues => ({ ...formValues(rule), ...patch })

describe('新建草稿', () => {
  it('充值可赠豆板次数，0 时不提交，旧方案默认不送，其余规则不带次数', () => {
    const base = blankRule('recharge')
    const values = fill(base, { name: '充 888 送 120', amountCents: '888', giftCents: '120', boardUses: '2' })
    expect(formValues(base).boardUses).toBe('0')
    expect(ruleFieldErrors('recharge', values)).toEqual({})
    expect(toRule(base, values).boardUses).toBe(2)
    expect(formValues({ ...base, id: 'r1', boardUses: 2 }).boardUses).toBe('2')
    expect(toRule(base, { ...values, boardUses: '0' })).not.toHaveProperty('boardUses')
    expect(toRule(blankRule('earn'), values)).not.toHaveProperty('boardUses')
    for (const boardUses of ['-1', '1.5', '1001'])
      expect(ruleFieldErrors('recharge', { ...values, boardUses }).boardUses).toBeTruthy()
  })
  it('金额、比例不预置，可为 0 的项填 0', () => {
    const values = formValues(blankRule('package'))
    expect(values.amountCents).toBe('')
    expect(values.durationMinutes).toBe('')
    expect(values.renewalMinutes).toBe('0')
    expect(values.renewalCents).toBe('0.00')
    expect(values.overtime).toBe('manual')
    expect(formValues(blankRule('tier')).rateBasisPoints).toBe('')
    expect(formValues(blankRule('tier')).mode).toBe('cumulative')
  })

  it('空表单逐项报出必填项', () => {
    expect(ruleFieldErrors('tier', formValues(blankRule('tier')))).toEqual({
      name: '请填写名称',
      amountCents: '请填写升级门槛',
      rateBasisPoints: '请填写会员价',
    })
  })
})

describe('字段校验与后端 Validate 一致', () => {
  it('金额按元、最多两位小数；比例按百分比', () => {
    const errors = ruleFieldErrors(
      'tier',
      fill(blankRule('tier'), { name: '黄金', amountCents: '500.001', rateBasisPoints: '98.755', validDays: '-1' }),
    )
    expect(errors).toEqual({
      amountCents: '请输入金额（元），最多两位小数',
      rateBasisPoints: '请输入百分比，最多两位小数，例如 12.5',
      validDays: '请输入整数',
    })
    expect(
      ruleFieldErrors('tier', fill(blankRule('tier'), { name: '黄金', amountCents: '0', rateBasisPoints: '101' })),
    ).toEqual({ amountCents: '须大于 0 元', rateBasisPoints: '须在 0.01% 到 100% 之间' })
    expect(
      ruleFieldErrors(
        'tier',
        fill(blankRule('tier'), { name: '黄金', amountCents: '10000000.01', rateBasisPoints: '90' }),
      ),
    ).toEqual({ amountCents: '不能超过 ¥10,000,000.00' })
  })

  it('名称 1–60 字，按字符计', () => {
    const base = fill(blankRule('recharge'), { amountCents: '100' })
    expect(ruleFieldErrors('recharge', { ...base, name: '   ' }).name).toBe('请填写名称')
    expect(ruleFieldErrors('recharge', { ...base, name: '充'.repeat(61) }).name).toBe('名称不超过 60 个字')
    expect(ruleFieldErrors('recharge', { ...base, name: '充'.repeat(60) })).toEqual({})
  })

  it('生日福利按内容要求积分、礼物或低于 100% 的折扣；领取次数 1–12', () => {
    const base = fill(blankRule('birthday'), { name: '生日', perUserLimit: '1', validDays: '30' })
    expect(ruleFieldErrors('birthday', { ...base, scope: 'points' })).toEqual({ points: '请填写赠送积分' })
    expect(ruleFieldErrors('birthday', { ...base, scope: 'gift' })).toEqual({ productId: '请选择礼物商品' })
    expect(ruleFieldErrors('birthday', { ...base, scope: 'discount', rateBasisPoints: '100' })).toEqual({
      rateBasisPoints: '须在 0.01% 到 99.99% 之间',
    })
    expect(ruleFieldErrors('birthday', { ...base, scope: 'points', points: '10', perUserLimit: '13' })).toEqual({
      perUserLimit: '须在 1 到 12 次之间',
    })
    expect(ruleFieldErrors('birthday', { ...base, scope: 'points', points: '10', validDays: '0' })).toEqual({
      validDays: '须在 1 到 3650 天之间',
    })
  })

  it('套餐续时分钟与价格同时为 0 或同时为正，时长 1–1440 分钟', () => {
    const base = fill(blankRule('package'), { name: '三小时', amountCents: '68.8', durationMinutes: '180' })
    expect(ruleFieldErrors('package', base)).toEqual({})
    expect(ruleFieldErrors('package', { ...base, renewalMinutes: '30' })).toEqual({
      renewalCents: '续时分钟和续时价格须同时为 0 或同时大于 0',
    })
    expect(ruleFieldErrors('package', { ...base, renewalMinutes: '30', renewalCents: '15' })).toEqual({})
    expect(ruleFieldErrors('package', { ...base, durationMinutes: '1441' })).toEqual({
      durationMinutes: '须在 1 到 1440 分钟之间',
    })
  })

  it('套餐价格可以不填（未定价），不填按 0；已有的 0 元套餐显示为空', () => {
    const base = fill(blankRule('package'), { name: '两小时', durationMinutes: '120' })
    expect(base.amountCents).toBe('')
    expect(ruleFieldErrors('package', base)).toEqual({})
    expect(toRule(blankRule('package'), base).amountCents).toBe(0)
    expect(ruleFieldErrors('package', { ...base, amountCents: '0' })).toEqual({})
    expect(ruleFieldErrors('package', { ...base, amountCents: '-1' })).toEqual({
      amountCents: '请输入金额（元），最多两位小数',
    })
    const saved: LoyaltyRule = { ...toRule(blankRule('package'), base), id: 'p1' }
    expect(formValues(saved).amountCents).toBe('')
  })

  it('到打烊：只填价格，时长、续时、暂停都为 0，不能按续时方案加收', () => {
    const base = fill(blankRule('package'), {
      name: '全天',
      untilClose: true,
      durationMinutes: '',
      renewalMinutes: '30',
      renewalCents: '15',
      pauseLimitMinutes: '10',
    })
    expect(ruleFieldErrors('package', base)).toEqual({})
    expect(ruleFieldErrors('package', { ...base, overtime: 'renewal' })).toEqual({
      overtime: '到打烊的套餐不能续时，请改选其他超时处理',
    })
    expect(fieldOrder('package', '', true)).toEqual([
      'name',
      'untilClose',
      'amountCents',
      'overtime',
      'overtimeGraceMinutes',
    ])
    const rule = toRule(blankRule('package'), base)
    expect(rule).toMatchObject({
      untilClose: true,
      amountCents: 0,
      durationMinutes: 0,
      renewalMinutes: 0,
      renewalCents: 0,
      pauseLimitMinutes: 0,
    })
    // 读回来：开关是开的，时长留空（改回固定时长要重新填）
    const values = formValues({ ...rule, id: 'p1' })
    expect(values.untilClose).toBe(true)
    expect(values.durationMinutes).toBe('')
    // 改回固定时长：不再带 untilClose，时长要填
    const fixed = { ...values, untilClose: false }
    expect(ruleFieldErrors('package', fixed)).toEqual({ durationMinutes: '请填写时长' })
    expect('untilClose' in toRule({ ...rule, id: 'p1' }, { ...fixed, durationMinutes: '60' })).toBe(false)
  })

  it('按续时方案自动加收：要有续时方案，宽限默认 10 分钟、0–1440', () => {
    const base = fill(blankRule('package'), { name: '1小时', amountCents: '29.9', durationMinutes: '60' })
    expect(base.overtimeGraceMinutes).toBe('10')
    expect(ruleFieldErrors('package', { ...base, overtime: 'renewal' })).toEqual({
      overtime: '按续时方案自动加收要先填每次续时和续时价格，或改选其他超时处理',
    })
    const renewal = { ...base, overtime: 'renewal', renewalMinutes: '30', renewalCents: '15' }
    expect(ruleFieldErrors('package', renewal)).toEqual({})
    expect(ruleFieldErrors('package', { ...renewal, overtimeGraceMinutes: '' })).toEqual({
      overtimeGraceMinutes: '请填写超时宽限',
    })
    expect(ruleFieldErrors('package', { ...renewal, overtimeGraceMinutes: '1441' })).toEqual({
      overtimeGraceMinutes: '不能超过 1440 分钟',
    })
    expect(fieldOrder('package', '').slice(-2)).toEqual(['overtime', 'overtimeGraceMinutes'])
    expect(toRule(blankRule('package'), renewal)).toMatchObject({
      overtime: 'renewal',
      overtimeGraceMinutes: 10,
      renewalMinutes: 30,
      renewalCents: 1500,
    })
    // 改回别的超时处理：宽限清零（后端只许 renewal 带宽限）
    expect(toRule(blankRule('package'), { ...renewal, overtime: 'free' }).overtimeGraceMinutes).toBe(0)
    // 已发布的自动加收套餐照原值显示宽限
    const saved: LoyaltyRule = { ...toRule(blankRule('package'), renewal), id: 'p1', overtimeGraceMinutes: 5 }
    expect(formValues(saved).overtimeGraceMinutes).toBe('5')
  })

  it('自由计时价：每 30 分钟的价必填，块长固定 30 分钟随规则发布；折合每小时只做整数运算', () => {
    const blank = formValues(blankRule('free_timing'))
    expect(ruleFieldErrors('free_timing', { ...blank, name: '自由计时' })).toEqual({ amountCents: '请填写每 30 分钟' })
    const rule = toRule(blankRule('free_timing'), { ...blank, name: '自由计时', amountCents: '10' })
    expect(rule).toMatchObject({ kind: 'free_timing', amountCents: 1000, durationMinutes: 30 })
    expect(hourlyCents('10')).toBe(2000)
    expect(hourlyCents('12.35')).toBe(2470)
    expect(hourlyCents('')).toBeNull()
    expect(hourlyCents('0')).toBeNull()
  })

  it('陪客费：金额必填且大于 0', () => {
    const blank = formValues(blankRule('companion'))
    expect(ruleFieldErrors('companion', { ...blank, name: '陪客', amountCents: '0' })).toEqual({
      amountCents: '须大于 0 元',
    })
    expect(toRule(blankRule('companion'), { ...blank, name: '陪客', amountCents: '20' })).toMatchObject({
      kind: 'companion',
      amountCents: 2000,
    })
  })

  it('兑换要选商品，积分、数量、每人次数为正', () => {
    expect(ruleFieldErrors('exchange', fill(blankRule('exchange'), { name: '钥匙扣' }))).toEqual({
      productId: '请选择兑换商品',
      points: '请填写所需积分',
      quantity: '请填写累计可兑换数量',
      perUserLimit: '请填写每人限兑次数',
    })
    expect(fieldOrder('exchange', '')).toEqual(['name', 'productId', 'points', 'quantity', 'perUserLimit'])
  })

  it('Zod 规则把错误挂在对应字段上', () => {
    const result = ruleFormSchema('earn').safeParse(fill(blankRule('earn'), { name: '积分', amountCents: 'abc' }))
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['amountCents', '请输入金额（元），最多两位小数'],
      ['points', '请填写得积分'],
    ])
    expect(
      ruleFormSchema('earn').safeParse(fill(blankRule('earn'), { name: '积分', amountCents: '1', points: '1' }))
        .success,
    ).toBe(true)
  })
})

describe('表单与规则互转', () => {
  it('元转整数分、百分比转整数基点', () => {
    const rule = toRule(
      blankRule('tier'),
      fill(blankRule('tier'), { name: ' 黄金 ', amountCents: '500.01', rateBasisPoints: '98.75', mode: 'single' }),
    )
    expect(rule).toMatchObject({
      id: '',
      kind: 'tier',
      name: '黄金',
      amountCents: 50001,
      rateBasisPoints: 9875,
      validDays: 0,
      mode: 'single',
      enabled: false,
    })
  })

  it('已有草稿照原值显示：金额为元、比例为百分比，往返不变', () => {
    const draft: LoyaltyRule = {
      ...blankRule('redeem'),
      id: 'r1',
      name: '百分抵一',
      points: 100,
      amountCents: 1000,
      maxBasisPoints: 1250,
      minimumPoints: 0,
      stack: true,
    }
    const values = formValues(draft)
    expect(values).toMatchObject({ points: '100', amountCents: '10.00', maxBasisPoints: '12.5', minimumPoints: '0' })
    expect(toRule(draft, values)).toEqual(draft)
  })

  it('生日福利只保留选中的那种内容', () => {
    const draft: LoyaltyRule = {
      ...blankRule('birthday'),
      id: 'b1',
      name: '生日礼',
      scope: 'gift',
      productId: 'p1',
      perUserLimit: 1,
      validDays: 30,
    }
    const switched = toRule(draft, { ...formValues(draft), scope: 'points', points: '88' })
    expect(switched).toMatchObject({ scope: 'points', points: 88, productId: '', rateBasisPoints: 0 })
  })
})

describe('影响说明', () => {
  it('必填，不超过 200 字', () => {
    expect(impactError('  ')).toBe('请填写影响说明')
    expect(impactError('说'.repeat(201))).toBe('影响说明不超过 200 个字')
    expect(impactError(' 只影响新充值 ')).toBeNull()
  })
})
