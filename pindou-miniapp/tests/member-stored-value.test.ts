import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { load } from './helpers/load'
import { expandNamed, label, nodes, settle } from './helpers/tree'

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
    useEffect() {},
  }
  return {
    api,
    render(fn: () => any) {
      cursor = 0
      return fn()
    },
  }
}

const member = () => ({
  balance: {
    principalCents: 5000,
    giftCents: 1000,
    points: 10,
    boardUses: 2,
    tierName: '普通会员',
    expiringPoints: 0,
    rateBasisPoints: 10000,
  },
  rules: [{ id: 'package-1', kind: 'package', name: '3 小时', enabled: true }],
  profile: { birthday: '' },
  entries: [],
  version: 'member-v1',
})
const consumption = {
  packageId: 'package-1',
  packageName: '3 小时',
  headcount: 1,
  dayType: 'holiday',
  amountCents: 7990,
  extraCents: 1990,
}
const entry = (patch: any = {}) => ({
  id: 'consume-1',
  accountId: 'a1',
  kind: 'consume',
  sourceId: '',
  reason: '补录到店消费',
  principalCents: -5000,
  giftCents: -1000,
  points: [],
  boardUses: -1,
  serviceDate: '2026-10-25',
  createdAt: '2026-10-27T02:00:00Z',
  consumption,
  balanceAfter: { principalCents: 0, giftCents: 0, boardUses: 1 },
  ...patch,
})

async function parts(h: ReturnType<typeof hooks>, platform?: Record<string, unknown>) {
  return load('pages/staff/membership/members.tsx', {
    react: h.api,
    ...(platform ? { '@tarojs/taro': { default: platform } } : {}),
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': { Field: 'Field', DateField: 'DateField', Stepper: 'Stepper' },
    '../../../components/staff/table-sheet': { StaffSheet: 'StaffSheet' },
    '../../../components/pagination': { PageControls: 'PageControls', pageSlice: (items: unknown[]) => items },
  })
}
const button = (tree: unknown, text: string) => nodes(tree, (n) => n.type === 'Button' && label(n) === text)[0]

test('顾客会员中心：合并余额、豆板次数、补录日期、另付、快照和已撤销均可见，顾客只能看', async () => {
  const h = hooks()
  const data = {
    ...member(),
    entries: [
      entry(),
      entry({
        id: 'reverse-1',
        kind: 'consume_reverse',
        sourceId: 'consume-1',
        principalCents: 5000,
        giftCents: 1000,
        boardUses: 1,
        reason: '登记错了',
        balanceAfter: { principalCents: 5000, giftCents: 1000, boardUses: 2 },
      }),
    ],
  }
  const { default: Page } = await load('pages/customer/membership/index.tsx', {
    react: h.api,
    '../../../components/button': { Button: 'Button' },
    '../../../components/customer': { Screen: 'Screen', AuthBoundary: 'AuthBoundary', SectionEmpty: 'SectionEmpty' },
    '../../../components/customer/member-code-sheet': { MemberCodeSheet: 'MemberCodeSheet' },
    '../../../hooks/customer': { useCustomer: () => ({ account: { nickname: '小林' } }) },
    '../../../hooks/query': { useCustomerQuery: () => ({ data, loading: false }) },
  })
  let tree = expandNamed(h.render(Page), ['MemberHistory'])
  assert.match(label(tree), /余额¥60.00/)
  assert.match(label(tree), /其中赠送 ¥10.00/)
  assert.match(label(tree), /智能豆板剩 2 次/)
  assert.ok(button(tree, '会员码'))
  assert.match(label(tree), /3 小时 · 单人 · 节假日/)
  assert.match(label(tree), /10月25日 周日/)
  assert.doesNotMatch(label(tree), /2026-10-27 10:00/)
  assert.match(label(tree), /−¥60.00/)
  assert.match(label(tree), /已撤销/)
  assert.match(label(tree), /门店撤销：登记错了/)
  assert.doesNotMatch(label(tree), /补录到店消费/)
  assert.doesNotMatch(label(tree), /撤销消费/)
  assert.equal(nodes(tree, (n) => n.type === 'Button' && /^撤销/.test(label(n))).length, 0)
  for (const section of ['会员权益', '生日福利', '明细']) {
    button(tree, section).props.onClick()
    tree = h.render(Page)
    assert.match(label(tree), /余额¥60.00/)
    assert.ok(button(tree, '会员码'))
    assert.match(label(tree), /充值、积分兑换、余额增减请到店找店员办/)
  }
})

test('员工会员稿：资产文案、套餐顺序与默认不选、共用日期框及成功复制', async () => {
  const h = hooks()
  const copied: string[] = []
  const toasts: string[] = []
  const platform = {
    setClipboardData: async ({ data }: { data: string }) => {
      copied.push(data)
    },
    showToast: async ({ title }: { title: string }) => {
      toasts.push(title)
    },
  }
  const { ConsumptionSheet, ServiceDateField, WalletRow } = await parts(h, platform)
  const data = member()
  data.rules = [
    { id: 'p3', kind: 'package', name: '3 小时', enabled: true, durationMinutes: 180 },
    { id: 'close', kind: 'package', name: '全天不限时', enabled: true, durationMinutes: 0, untilClose: true },
    { id: 'p1', kind: 'package', name: '1 小时', enabled: true, durationMinutes: 60 },
    { id: 'disabled', kind: 'package', name: '停用套餐', enabled: false, durationMinutes: 30 },
  ] as any
  let tree = h.render(() => ConsumptionSheet({ member: data, busy: false, act: async () => false, onClose() {} }))
  assert.equal(tree.props.dirty, false, '还没填金额和备注，点遮罩照常关')
  const choices = nodes(tree, (n) => n.type === 'Button' && n.props.ariaLabel)
  assert.deepEqual(choices.map(label), ['1 小时', '3 小时', '全天不限时', '其他'])
  assert.ok(choices.every((n) => !n.props.ariaLabel.includes('已选中')))
  const stepper = nodes(tree, (n) => n.type === 'Stepper')[0]
  assert.equal(stepper.props.min, 0)
  assert.equal(stepper.props.max, 2)
  assert.match(label(tree), /日子按日期自动/)
  assert.match(label(tree), /备注选「其他」时必填，不发给顾客/)
  assert.match(label(tree.props.footer), /扣完：余额 ¥60.00 · 智能豆板剩 2 次确认登记 · 扣 ¥0.00/)
  const date = ServiceDateField({
    label: '消费日期',
    value: '2026-10-27',
    onChange() {},
    unlimited: false,
    busy: false,
  })
  assert.equal(date.type, 'DateField')
  assert.equal(date.props.clearable, false)
  assert.equal(date.props.text.startsWith('10-27 周二'), true)
  assert.equal(date.props.help, '最早 7 天前，更早的请店长补')
  assert.equal(date.props.presets[0].text, '今天')
  assert.equal(date.props.presets[1].text, '昨天')
  const wallet = WalletRow({ member: data })
  assert.match(label(wallet), /余额¥60.00含赠送 ¥10.00智能豆板2 次积分10/)
  // 成功弹层有独立状态，不能与上面的消费表单共用钩子槽。
  const doneHooks = hooks()
  const { MemberDoneSheet } = await parts(doneHooks, platform)
  const done = () => doneHooks.render(() => MemberDoneSheet({ entry: entry(), entries: [entry()], onClose() {} }))
  tree = done()
  assert.equal(tree.props.heading, false)
  assert.doesNotMatch(label(tree), /已用微信通知|补录到店消费/)
  assert.match(label(tree), /会员流水里每一笔也能再复制/)
  button(tree, '复制给顾客').props.onClick()
  await settle()
  assert.match(copied[0], /^EXAMPLE 示例工坊 · 消费记录\n/)
  assert.match(copied[0], /余额 ¥0.00\n智能豆板用 1 次，剩 1 次$/)
  assert.equal(toasts[0], '已复制，去微信粘贴给顾客')
  tree = done()
  assert.ok(button(tree, '已复制，去微信粘贴给顾客'))
})

test('员工流水仍显示撤销两条，只给未撤销消费和充值复制；剪贴板失败有提示', async () => {
  const h = hooks()
  const copies: string[] = []
  const toasts: string[] = []
  const { EntryList } = await parts(h, {
    setClipboardData: async ({ data }: { data: string }) => {
      copies.push(data)
      if (copies.length === 2) throw new Error('不允许复制')
    },
    showToast: async ({ title }: { title: string }) => {
      toasts.push(title)
    },
  })
  const data = {
    ...member(),
    entries: [
      entry(),
      entry({ id: 'reverse', kind: 'consume_reverse', sourceId: 'consume-1' }),
      entry({
        id: 'recharge',
        kind: 'recharge',
        consumption: undefined,
        principalCents: 88800,
        giftCents: 12000,
        boardUses: 2,
        rule: { name: '888 送 120' },
      }),
      entry({ id: 'consume-2' }),
    ],
  }
  const tree = h.render(() => EntryList({ member: data, busy: false }))
  assert.equal(nodes(tree, (n) => n.props.className === 'member-entry').length, 4)
  const buttons = nodes(tree, (n) => n.type === 'Button' && label(n) === '复制')
  assert.equal(buttons.length, 2)
  buttons[0].props.onClick()
  await settle()
  assert.match(copies[0], /^EXAMPLE 示例工坊 · 消费记录/)
  buttons[1].props.onClick()
  await settle()
  assert.match(copies[1], /^EXAMPLE 示例工坊 · 充值记录/)
  assert.equal(toasts.at(-1), '复制失败，请重试')
})

test('流水：旧记录保留记账时间，新充值显示赠送次数；员工与顾客共用展示口径', async () => {
  const h = hooks()
  const { EntryList } = await parts(h)
  const data = {
    ...member(),
    entries: [
      entry({
        id: 'old',
        kind: 'adjust',
        consumption: undefined,
        balanceAfter: undefined,
        serviceDate: undefined,
        boardUses: undefined,
      }),
      entry({
        id: 'recharge',
        kind: 'recharge',
        consumption: undefined,
        rule: { name: '充 888 送 120', boardUses: 2 },
        boardUses: 2,
        principalCents: 88800,
        giftCents: 12000,
      }),
    ],
  }
  const tree = h.render(() => EntryList({ member: data, busy: false }))
  assert.match(label(tree), /充值入账 · 充 888 送 120/)
  assert.match(label(tree), /智能豆板 \+2 次/)
  assert.match(label(tree), /2026-10-27 10:00/)
  assert.equal(nodes(tree, (n) => n.type === 'Button' && /撤销/.test(label(n))).length, 0)
})

test('消费登记：其他必填备注、次数不能超剩余，金额精确到分；确认取消保留，成功才关闭', async () => {
  const h = hooks()
  const { ConsumptionSheet } = await parts(h)
  const sent: any[] = []
  let done = false,
    closed = 0
  const render = () =>
    h.render(() =>
      ConsumptionSheet({
        member: member(),
        busy: false,
        act: async (input, confirmation) => {
          sent.push({ input, confirmation })
          return done
        },
        onClose: () => closed++,
      }),
    )
  let tree = render()
  const field = (name: string, value: string) =>
    nodes(tree, (n) => ['Field', 'Stepper'].includes(n.type) && n.props.label === name)[0].props.onChange(value)
  const submit = async () => {
    nodes(tree.props.footer, (n) => n.type === 'Button')[0].props.onClick()
    await settle()
    tree = render()
  }
  field('金额（元）', '79.9')
  field('智能豆板', '1')
  tree = render()
  await submit()
  assert.match(label(tree), /请选择套餐/)
  button(tree, '其他').props.onClick()
  tree = render()
  await submit()
  assert.match(label(tree), /其他.*填写备注/)
  assert.equal(sent.length, 0)
  button(tree, '3 小时').props.onClick()
  field('智能豆板', '3')
  tree = render()
  await submit()
  assert.match(label(tree), /剩余次数不够/)
  field('智能豆板', '1')
  tree = render()
  await submit()
  assert.equal(sent[0].input.consumption.amountCents, 7990)
  assert.equal(sent[0].input.consumption.boardUses, 1)
  assert.match(sent[0].confirmation, /从余额扣 ¥60.00（本金 ¥50.00、赠送 ¥10.00），另付 ¥19.90/)
  assert.match(sent[0].confirmation, /扣完余额 ¥0.00。智能豆板用 1 次，剩 1 次/)
  assert.equal(closed, 0)
  assert.equal(nodes(tree, (n) => n.type === 'Field' && n.props.label === '金额（元）')[0].props.value, '79.9')
  done = true
  await submit()
  assert.equal(closed, 1)
})

test('消费、充值日期：门店时区的今天与往前第 7 天可用，第 8 天仅店长老板；周末默认节假日', async () => {
  const { earliestServiceDate, serviceDateProblem, dayTypeForDate, serviceToday, consumptionPlan } = await load(
    'services/member-consumption.ts',
  )
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-10-26T16:01:00Z'))
    assert.equal(serviceToday(), '2026-10-27')
    assert.equal(earliestServiceDate(false), '2026-10-20')
    assert.equal(earliestServiceDate(true), undefined)
    assert.equal(serviceDateProblem('2026-10-20', false), '')
    assert.match(serviceDateProblem('2026-10-19', false), /7 天/)
    assert.equal(serviceDateProblem('2020-01-01', true), '')
    assert.match(serviceDateProblem('2026-10-28', true), /将来/)
    assert.match(serviceDateProblem('2026-02-30', true), /有效日期/)
    assert.equal(dayTypeForDate('2026-10-25'), 'holiday')
    assert.equal(dayTypeForDate('2026-10-26'), 'workday')
    const form = {
      serviceDate: '2026-10-27',
      packageId: '',
      headcount: 2,
      dayType: 'holiday',
      amount: '0',
      boardUses: '1',
      reason: '只用豆板',
    }
    assert.equal(consumptionPlan(form, member(), false).error, '')
    assert.match(consumptionPlan({ ...form, boardUses: '0' }, member(), false).error, /不能都为 0/)
    assert.match(consumptionPlan({ ...form, amount: '1.001' }, member(), false).error, /两位小数/)
    assert.match(consumptionPlan({ ...form, amount: '-1' }, member(), false).error, /0 到/)
    assert.match(consumptionPlan({ ...form, boardUses: '1.5' }, member(), false).error, /整数/)
  } finally {
    vi.useRealTimers()
  }
})

test('充值选日期并展示方案送豆板，手动加减支持正负次数且不扣成负数', async () => {
  const h = hooks()
  const { RechargeSheet } = await parts(h)
  const sent: any[] = []
  const data = {
    ...member(),
    rules: [
      { id: 'r1', kind: 'recharge', name: '充 888', amountCents: 88800, giftCents: 12000, points: 0, boardUses: 2 },
    ],
  }
  let tree = h.render(() =>
    RechargeSheet({
      member: data,
      busy: false,
      unlimitedDates: true,
      act: async (...args) => {
        sent.push(args)
        return true
      },
      onClose() {},
    }),
  )
  assert.match(label(tree), /送智能豆板 2 次/)
  nodes(tree, (n) => typeof n.type === 'function' && n.type.name === 'ServiceDateField')[0].props.onChange('2020-01-01')
  tree = h.render(() =>
    RechargeSheet({
      member: data,
      busy: false,
      unlimitedDates: true,
      act: async (...args) => {
        sent.push(args)
        return true
      },
      onClose() {},
    }),
  )
  nodes(
    tree,
    (n) => n.type === 'Button' && n.props.className?.split(' ').includes('member-recharge-option'),
  )[0].props.onClick()
  await settle()
  assert.equal(sent[0][0].serviceDate, '2020-01-01')
  assert.match(sent[0][1], /智能豆板 2 次/)
  const { adjustPlan } = await load('services/adjust.ts')
  const form = { principal: '', gift: '', points: '', boardUses: '-1', reason: '纠正次数' }
  const plan = adjustPlan(form, member().balance)
  assert.equal(plan.change.boardUses, -1)
  assert.match(plan.confirmation, /智能豆板 -1 次/)
  assert.match(plan.confirmation, /智能豆板剩 1 次/)
  assert.match(adjustPlan({ ...form, boardUses: '-3' }, member().balance).error, /不够扣/)
  assert.match(adjustPlan({ ...form, boardUses: '1001' }, member().balance).error, /1000/)
})

test('消费登记带会员资产版本，网络结果不明重试复用幂等键', async () => {
  const calls: any[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (input) => {
      calls.push(input)
      if (calls.length === 1) throw new Error('超时')
      return { statusCode: 200, data: member() }
    },
  }
  const staff = await load('services/staff.ts', { '@tarojs/taro': { default: taro } })
  const { loyalty, withChosenMember } = await load('services/membership.ts', { './staff': staff })
  const input = withChosenMember(
    {
      action: 'consume',
      serviceDate: '2026-10-25',
      consumption: { headcount: 1, dayType: 'holiday', amountCents: 7990, boardUses: 1 },
    },
    'account-1',
    'member-v1',
  )
  await assert.rejects(loyalty.action(input))
  await loyalty.action(input)
  assert.equal(calls[0].data.accountId, 'account-1')
  assert.equal(calls[0].data.expectedVersion, 'member-v1')
  assert.ok(calls[0].header['Idempotency-Key'])
  assert.equal(calls[0].header['Idempotency-Key'], calls[1].header['Idempotency-Key'])
})

test('代开会员必须有称呼、有效手机号和顾客同意，成功才收起', async () => {
  const h = hooks()
  const { OpenMemberSheet } = await parts(h)
  const sent: any[] = []
  let closed = 0
  const render = () =>
    h.render(() =>
      OpenMemberSheet({
        busy: false,
        open: async (input) => {
          sent.push(input)
          return true
        },
        onClose: () => closed++,
      }),
    )
  let tree = render()
  const submit = async () => {
    tree.props.footer.props.onClick()
    await settle()
    tree = render()
  }
  assert.equal(tree.props.dirty, false, '还没填，点遮罩照常关')
  await submit()
  assert.match(label(tree), /填写称呼/)
  nodes(tree, (n) => n.type === 'Field' && n.props.label === '称呼')[0].props.onChange(' 小林 ')
  nodes(tree, (n) => n.type === 'Field' && n.props.label === '手机号')[0].props.onChange('138-0000-5678')
  tree = render()
  assert.equal(tree.props.dirty, true, '填了字点遮罩不关')
  await submit()
  assert.match(label(tree), /请先确认顾客已同意/)
  assert.equal(sent.length, 0)
  nodes(tree, (n) => n.type === 'CheckboxGroup')[0].props.onChange({ detail: { value: ['consent'] } })
  tree = render()
  await submit()
  assert.deepEqual(sent, [{ nickname: '小林', phone: '13800005678', consent: true }])
  assert.equal(closed, 1)
})
