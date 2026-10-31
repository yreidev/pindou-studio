import { z } from 'zod'
import type { LoyaltyRule, RuleKind } from '../../api/rules'
import { money, parseYuan, yuanInput } from '../../lib/format'
import { parseCount, parsePercent, percent, percentInput } from './units'

// 规则草稿表单：字段严格按后端 Rule 结构，校验照搬后端 membership.Validate，
// 让大部分错误在提交前就落到具体字段上（后端仍会再校验一遍）。
// 金额以元输入、转整数分；比例以百分比输入、转整数基点；都不经过浮点。

/** 后端单笔规则金额、积分的上限（金额为分） */
export const ruleLimit = 1_000_000_000

export type NumericKey =
  | 'boardUses'
  | 'amountCents'
  | 'giftCents'
  | 'renewalCents'
  | 'points'
  | 'minimumPoints'
  | 'rateBasisPoints'
  | 'maxBasisPoints'
  | 'validDays'
  | 'quantity'
  | 'perUserLimit'
  | 'durationMinutes'
  | 'renewalMinutes'
  | 'pauseLimitMinutes'
  | 'overtimeGraceMinutes'

/** 表单里的值一律是输入框里的文字，提交时才换成整数。 */
export type RuleFormValues = Record<NumericKey, string> & {
  name: string
  mode: string
  scope: string
  overtime: string
  stack: boolean
  productId: string
  /** 计时套餐「到打烊」：不设时长，开台时按当天打烊算；不能续时、暂停。 */
  untilClose: boolean
}

export type RuleFieldKey = keyof RuleFormValues

type Unit = 'yuan' | 'percent' | 'count'

export interface NumericField {
  key: NumericKey
  label: string
  unit: Unit
  /** 输入框后缀 */
  suffix: string
  help?: string
  /** 可以不填，不填按 0（套餐价格：不填就是未定价） */
  optional?: boolean
  /** 以存储单位计（分、基点、个） */
  min: number
  max: number
}

const yuan = (key: NumericKey, label: string, min: number, help?: string): NumericField => ({
  key,
  label,
  unit: 'yuan',
  suffix: '元',
  help,
  min,
  max: ruleLimit,
})
const pct = (key: NumericKey, label: string, min: number, max: number, help?: string): NumericField => ({
  key,
  label,
  unit: 'percent',
  suffix: '%',
  help,
  min,
  max,
})
const count = (
  key: NumericKey,
  label: string,
  suffix: string,
  min: number,
  max: number,
  help?: string,
): NumericField => ({
  key,
  label,
  unit: 'count',
  suffix,
  help,
  min,
  max,
})

/**
 * 每类规则要填的数值，按表单顺序。生日福利按福利内容只显示对应的一项；
 * 「到打烊」的套餐只填价格（时长、续时、暂停都为 0）。
 */
export function numericFields(kind: RuleKind, scope = '', untilClose = false): NumericField[] {
  switch (kind) {
    case 'tier':
      return [
        yuan('amountCents', '升级门槛', 1, '有效充值本金（不计赠送余额）达到这个金额获得该等级。'),
        pct('rateBasisPoints', '会员价', 1, 10000, '按原价的百分之几收费：90 表示九折，100 表示不打折。'),
        count('validDays', '等级有效期', '天', 0, 3650, '从获得等级当天起算，0 表示永久有效。'),
      ]
    case 'recharge':
      return [
        yuan('amountCents', '充值金额', 1),
        yuan('giftCents', '赠送余额', 0, '与本金分开记账，0 表示不赠送。'),
        count('points', '赠送积分', '积分', 0, ruleLimit, '0 表示不赠送。'),
        count('validDays', '赠送积分有效期', '天', 0, 3650, '0 表示永久有效。'),
        count('boardUses', '送智能豆板次数', '次', 0, 1000, '0 表示不送，赠送的次数不过期。'),
      ]
    case 'earn':
      return [
        yuan('amountCents', '每消费', 1, '按扣除优惠和积分抵扣后的实付额计算，不满一档的部分不累计。'),
        count('points', '得积分', '积分', 1, ruleLimit),
        count('validDays', '积分有效期', '天', 0, 3650, '0 表示永久有效。'),
      ]
    case 'redeem':
      return [
        count('points', '每使用', '积分', 1, ruleLimit, '只能按完整份数使用。'),
        yuan('amountCents', '抵扣金额', 1),
        pct('maxBasisPoints', '每单最多抵扣', 1, 10000, '占优惠后应付金额的百分之几。'),
        count('minimumPoints', '最低使用积分', '积分', 0, ruleLimit, '0 表示不设下限。'),
      ]
    case 'exchange':
      return [
        count('points', '所需积分', '积分', 1, ruleLimit),
        count('quantity', '累计可兑换数量', '件', 1, 100000, '全店合计，兑完即止。'),
        count('perUserLimit', '每人限兑次数', '次', 1, 100000),
      ]
    case 'birthday':
      return [
        ...(scope === 'points' ? [count('points', '赠送积分', '积分', 1, ruleLimit)] : []),
        ...(scope === 'discount'
          ? [
              pct(
                'rateBasisPoints',
                '生日折扣',
                1,
                9999,
                '按原价的百分之几收费，须低于 100%；与会员折扣取更优惠的一种。',
              ),
            ]
          : []),
        count('perUserLimit', '每年可领次数', '次', 1, 12, '按中国时区自然年计，最多 12 次。'),
        count('validDays', '领取后有效期', '天', 1, 3650, '积分的有效期、礼物的核销期限、折扣的使用期限。'),
      ]
    case 'package': {
      const price: NumericField = {
        ...yuan('amountCents', '套餐价格', 0, packagePriceHelp),
        optional: true,
      }
      if (untilClose) return [price]
      return [
        price,
        count('durationMinutes', '时长', '分钟', 1, 1440),
        count('renewalMinutes', '每次续时', '分钟', 0, 1440, '0 表示不提供续时，此时续时价格也填 0。'),
        yuan('renewalCents', '续时价格', 0),
        count('pauseLimitMinutes', '累计免费暂停', '分钟', 0, 1440, '0 表示不能暂停；超出部分照常计时。'),
      ]
    }
    case 'free_timing':
      return [
        yuan(
          'amountCents',
          `每 ${freeTimingBlockMinutes} 分钟`,
          1,
          `自由计时按实际使用时长（不含暂停）每 ${freeTimingBlockMinutes} 分钟一块，不足一块按一块，开台即算第一块。`,
        ),
      ]
    case 'companion':
      return [yuan('amountCents', '陪客费', 1, '陪客不计时、仍占座；陪客会话结账时自动带一行这个价。')]
  }
}

/** 套餐价格可以不填（2026-10-10 起钱在美团、大众点评收，系统只管时长）。 */
const packagePriceHelp =
  '可以不填（未定价）：系统内收费关着时只管时长。打开系统内收费后，没填价的套餐顾客看不到，也不能用来开台、预约。'

/** 「到打烊」开关的说明。 */
export const untilCloseHelp =
  '不设时长：开台时从此刻算到当天打烊（「系统设置 › 营业与预约」的每天结束时间），预约从所选开始时间约到打烊。不能续时、不能暂停。'

/** 自由计时价的一块：每 30 分钟一个价（2026-10-06 业主定），写进规则的 durationMinutes。 */
export const freeTimingBlockMinutes = 30

/** 超时宽限：只有「按续时方案自动加收」用，新填时默认 10 分钟。 */
export const defaultGraceMinutes = 10
export const graceField = count(
  'overtimeGraceMinutes',
  '超时宽限',
  '分钟',
  0,
  1440,
  '超出套餐时长不超过这么多分钟不收；超过就从套餐结束时起按续时方案整段分块加收，不足一块按一块。0 表示超时就收。',
)

/** 自由计时每块的价折合每小时多少（整数分，只做整数运算）；没填好返回 null。 */
export function hourlyCents(blockText: string): number | null {
  const cents = parseYuan(blockText)
  if (cents === null || cents < 1) return null
  return (cents * 60) / freeTimingBlockMinutes
}

/** 这类规则要不要选商品（兑换商品、生日礼物）。 */
export function needsProduct(kind: RuleKind, scope: string): boolean {
  return kind === 'exchange' || (kind === 'birthday' && scope === 'gift')
}

export const productLabel = (kind: RuleKind) => (kind === 'exchange' ? '兑换商品' : '礼物商品')

/** 表单里各个字段从上到下的顺序，提交失败时定位到第一个出错的字段。 */
export function fieldOrder(kind: RuleKind, scope: string, untilClose = false): RuleFieldKey[] {
  const product: RuleFieldKey[] = needsProduct(kind, scope) ? ['productId'] : []
  const numeric = numericFields(kind, scope, untilClose).map((field) => field.key)
  if (kind === 'package') return ['name', 'untilClose', ...numeric, 'overtime', 'overtimeGraceMinutes']
  return kind === 'exchange' ? ['name', ...product, ...numeric] : ['name', ...numeric, ...product]
}

function format(field: NumericField, value: number): string {
  if (field.unit === 'yuan') return yuanInput(value)
  if (field.unit === 'percent') return percentInput(value)
  return String(value)
}

function parse(field: NumericField, text: string): number | null {
  if (field.unit === 'yuan') return parseYuan(text)
  if (field.unit === 'percent') return parsePercent(text)
  return parseCount(text)
}

const allKeys: NumericKey[] = [
  'boardUses',
  'amountCents',
  'giftCents',
  'renewalCents',
  'points',
  'minimumPoints',
  'rateBasisPoints',
  'maxBasisPoints',
  'validDays',
  'quantity',
  'perUserLimit',
  'durationMinutes',
  'renewalMinutes',
  'pauseLimitMinutes',
]

/** 新建时的空白规则。金额、比例不预置，必须由门店填写。 */
export function blankRule(kind: RuleKind): LoyaltyRule {
  return {
    id: '',
    kind,
    name: '',
    enabled: false,
    amountCents: 0,
    giftCents: 0,
    points: 0,
    rateBasisPoints: 0,
    maxBasisPoints: 0,
    minimumPoints: 0,
    validDays: 0,
    mode: kind === 'tier' ? 'cumulative' : kind === 'birthday' ? 'month' : '',
    scope: kind === 'earn' ? 'all' : kind === 'birthday' ? 'points' : '',
    stack: false,
    productId: '',
    quantity: 0,
    perUserLimit: 0,
    // 自由计时价的块长固定 30 分钟，随规则一起发布
    durationMinutes: kind === 'free_timing' ? freeTimingBlockMinutes : 0,
    renewalMinutes: 0,
    renewalCents: 0,
    pauseLimitMinutes: 0,
    overtime: kind === 'package' ? 'manual' : '',
  }
}

/**
 * 规则 → 表单。新建时必须为正的项留空（不预置金额、比例），可以为 0 的项填 0；
 * 已有草稿照原值显示（金额显示成元、比例显示成百分比）。
 */
export function formValues(rule: LoyaltyRule): RuleFormValues {
  const isNew = rule.id === ''
  const values = {
    name: rule.name,
    mode: rule.mode,
    scope: rule.scope,
    overtime: rule.overtime,
    stack: rule.stack,
    productId: rule.productId,
    untilClose: rule.untilClose === true,
  } as RuleFormValues
  // 生日福利三种内容的字段都准备好，切换内容时不丢已填的值
  const fields = [
    ...numericFields(rule.kind, 'points'),
    ...numericFields(rule.kind, 'discount'),
    ...numericFields(rule.kind),
  ]
  for (const key of allKeys) {
    const field = fields.find((candidate) => candidate.key === key)
    const value = rule[key] ?? 0
    // 可以不填的（套餐价格）为 0 时留空，表示未定价；到打烊的套餐时长留空，改回固定时长时要重新填
    const blank =
      value === 0 &&
      (field?.optional || (isNew && (field?.min ?? 0) > 0) || (key === 'durationMinutes' && rule.untilClose))
    values[key] = field ? (blank ? '' : format(field, value)) : String(value)
  }
  // 宽限：自动加收的套餐照原值；其余（含旧套餐、新建）预填 10，改选「按续时方案自动加收」时就是它
  values.overtimeGraceMinutes =
    rule.overtime === 'renewal' ? String(rule.overtimeGraceMinutes ?? 0) : String(defaultGraceMinutes)
  return values
}

function numberError(field: NumericField, text: string): string | null {
  if (text.trim() === '') return field.optional ? null : `请填写${field.label}`
  const value = parse(field, text)
  if (value === null) {
    if (field.unit === 'yuan') return '请输入金额（元），最多两位小数'
    if (field.unit === 'percent') return '请输入百分比，最多两位小数，例如 12.5'
    return '请输入整数'
  }
  if (value < field.min || value > field.max) {
    if (field.unit === 'yuan') return value < field.min ? '须大于 0 元' : `不能超过 ${money(field.max)}`
    if (field.unit === 'percent') return `须在 ${percent(field.min)} 到 ${percent(field.max)} 之间`
    if (field.min === 0) return `不能超过 ${field.max} ${field.suffix}`
    return `须在 ${field.min} 到 ${field.max} ${field.suffix}之间`
  }
  return null
}

/**
 * 字段级错误（中文），没有错误返回空对象。规则与后端 Validate 一致：
 * 名称 1–60 字；金额、积分不超过 10,000,000 元 / 10 亿；比例 0–100%；各类别的必填项为正；
 * 生日福利按内容要求积分、礼物或折扣（低于 100%）；套餐续时分钟和价格同时为 0 或同时为正。
 */
export function ruleFieldErrors(kind: RuleKind, values: RuleFormValues): Partial<Record<RuleFieldKey, string>> {
  const errors: Partial<Record<RuleFieldKey, string>> = {}
  const name = values.name.trim()
  if (!name) errors.name = '请填写名称'
  else if ([...name].length > 60) errors.name = '名称不超过 60 个字'

  const untilClose = kind === 'package' && values.untilClose
  for (const field of numericFields(kind, values.scope, untilClose)) {
    const error = numberError(field, values[field.key])
    if (error) errors[field.key] = error
  }
  if (needsProduct(kind, values.scope) && !values.productId) errors.productId = `请选择${productLabel(kind)}`
  if (kind === 'tier' && values.mode !== 'single' && values.mode !== 'cumulative') errors.mode = '请选择升级方式'
  if (kind === 'earn' && !['all', 'goods', 'service'].includes(values.scope)) errors.scope = '请选择适用消费'
  if (kind === 'birthday') {
    if (values.mode !== 'day' && values.mode !== 'month') errors.mode = '请选择领取时间'
    if (!['points', 'gift', 'discount'].includes(values.scope)) errors.scope = '请选择福利内容'
  }
  if (kind === 'package') {
    if (!['manual', 'free', 'renewal'].includes(values.overtime)) errors.overtime = '请选择超时处理'
    if (untilClose && values.overtime === 'renewal') errors.overtime = '到打烊的套餐不能续时，请改选其他超时处理'
    else if (values.overtime === 'renewal') {
      if (!errors.renewalMinutes && parseCount(values.renewalMinutes) === 0)
        errors.overtime = '按续时方案自动加收要先填每次续时和续时价格，或改选其他超时处理'
      const graceError = numberError(graceField, values.overtimeGraceMinutes)
      if (graceError) errors.overtimeGraceMinutes = graceError
    }
    if (!untilClose && !errors.renewalMinutes && !errors.renewalCents) {
      const minutes = parseCount(values.renewalMinutes)
      const cents = parseYuan(values.renewalCents)
      if ((minutes === 0) !== (cents === 0)) errors.renewalCents = '续时分钟和续时价格须同时为 0 或同时大于 0'
    }
  }
  return errors
}

const formShape = z.object({
  name: z.string(),
  mode: z.string(),
  scope: z.string(),
  overtime: z.string(),
  stack: z.boolean(),
  productId: z.string(),
  untilClose: z.boolean(),
  ...(Object.fromEntries([...allKeys, 'overtimeGraceMinutes'].map((key) => [key, z.string()])) as Record<
    NumericKey,
    z.ZodString
  >),
})

/** 表单的 Zod 规则：字段错误挂在对应字段上（TanStack Form 按 path 分发）。 */
export function ruleFormSchema(kind: RuleKind) {
  return formShape.superRefine((values, ctx) => {
    for (const [path, message] of Object.entries(ruleFieldErrors(kind, values))) {
      ctx.addIssue({ code: 'custom', path: [path], message })
    }
  })
}

/**
 * 校验通过的表单 → 要保存的规则。从原草稿出发，只改这类规则用到的字段；
 * 生日福利没选中的那两种内容清零，免得残留的商品、积分被一起发布。
 */
export function toRule(base: LoyaltyRule, values: RuleFormValues): LoyaltyRule {
  const kind = base.kind
  const rule: LoyaltyRule = { ...base, name: values.name.trim() }
  const untilClose = kind === 'package' && values.untilClose
  for (const field of numericFields(kind, values.scope, untilClose)) {
    rule[field.key] = parse(field, values[field.key]) ?? 0
  }
  if (kind === 'tier' || kind === 'birthday') rule.mode = values.mode as LoyaltyRule['mode']
  if (kind === 'earn' || kind === 'birthday') rule.scope = values.scope as LoyaltyRule['scope']
  if (kind === 'package') {
    rule.overtime = values.overtime as LoyaltyRule['overtime']
    // 宽限只给「按续时方案自动加收」用，其余为 0（后端也这样要求）
    rule.overtimeGraceMinutes = values.overtime === 'renewal' ? (parseCount(values.overtimeGraceMinutes) ?? 0) : 0
    // 到打烊：时长、续时、暂停都为 0（后端要求）；不是到打烊时不带这个字段
    if (untilClose) {
      rule.untilClose = true
      rule.durationMinutes = 0
      rule.renewalMinutes = 0
      rule.renewalCents = 0
      rule.pauseLimitMinutes = 0
    } else delete rule.untilClose
  }
  if (kind === 'free_timing') rule.durationMinutes = freeTimingBlockMinutes
  if (!rule.boardUses || kind !== 'recharge') delete rule.boardUses
  if (kind === 'redeem') rule.stack = values.stack
  if (needsProduct(kind, values.scope)) rule.productId = values.productId
  if (kind === 'birthday') {
    if (values.scope !== 'points') rule.points = 0
    if (values.scope !== 'discount') rule.rateBasisPoints = 0
    if (values.scope !== 'gift') rule.productId = ''
  }
  return rule
}

export const impactLimit = 200

/** 发布、停用时的影响说明：后端要求必填、不超过 200 字。没问题返回 null。 */
export function impactError(text: string): string | null {
  const value = text.trim()
  if (!value) return '请填写影响说明'
  if ([...value].length > impactLimit) return `影响说明不超过 ${impactLimit} 个字`
  return null
}
