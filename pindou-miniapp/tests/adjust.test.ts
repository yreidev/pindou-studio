import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'

// 手动加减（2026-10-10 起所有员工都能办）：本金、赠送余额、积分可加可减，必须写原因，扣不成负数。
// 规则和网页后台 features/members/forms.ts、后端 adjust 一致。

const { adjustPlan, parsePoints, parseSignedYuan } = await load('services/adjust.ts')
const balance = { principalCents: 5000, giftCents: 1000, points: 30 }
const form = (patch: Record<string, string>) => ({
  principal: '',
  gift: '',
  points: '',
  reason: '补录线下充值',
  ...patch,
})

test('手动加减：元转整数分、积分取整，留空当 0；多于两位小数、超出上限的不收', () => {
  assert.equal(parseSignedYuan(''), 0)
  assert.equal(parseSignedYuan(' 12.5 '), 1250)
  assert.equal(parseSignedYuan('+0.01'), 1)
  assert.equal(parseSignedYuan('-10'), -1000)
  assert.ok(Object.is(parseSignedYuan('-0'), 0), '负零当 0，不出 -0')
  assert.equal(parseSignedYuan('10000000'), 1_000_000_000, '上限正好 1000 万元')
  assert.equal(parseSignedYuan('10000000.01'), null)
  assert.equal(parseSignedYuan('1.234'), null)
  assert.equal(parseSignedYuan('1e3'), null)
  assert.equal(parsePoints('-50'), -50)
  assert.equal(parsePoints('+7'), 7)
  assert.ok(Object.is(parsePoints('-0'), 0))
  assert.equal(parsePoints('1.5'), null)
  assert.equal(parsePoints('1000000001'), null)
})

test('手动加减：确认框写清本次加减和调整后的数；填错、全空、没写原因、扣成负数都不提交', () => {
  const plan = adjustPlan(form({ principal: '-10', points: '+20' }), balance)
  assert.deepEqual(plan.change, { principalCents: -1000, giftCents: 0, points: 20, reason: '补录线下充值' })
  assert.equal(
    plan.confirmation,
    '本次：本金 -¥10.00、积分 +20。调整后：本金 ¥40.00、赠送余额 ¥10.00、积分 50。原因：补录线下充值',
  )
  // 扣到正好为零可以
  assert.equal(adjustPlan(form({ gift: '-10' }), balance).error, '')

  const error = (patch: Record<string, string>) => adjustPlan(form(patch), balance).error
  assert.equal(error({ principal: '1.234' }), '金额最多两位小数，可带负号，绝对值不超过 1000 万元')
  assert.equal(error({ points: '十' }), '积分须为整数，可带负号，绝对值不超过 10 亿')
  assert.equal(error({}), '本金、赠送余额、积分、智能豆板次数至少调整一项')
  assert.equal(error({ principal: '1', reason: '  ' }), '请填写调整原因')
  // 原因按字符数算（同后端按 rune）：200 个表情可以，201 个不行
  assert.equal(error({ principal: '1', reason: '🎉'.repeat(200) }), '')
  assert.equal(error({ principal: '1', reason: '🎉'.repeat(201) }), '原因最多 200 字')
  assert.equal(error({ principal: '-60', points: '-31' }), '本金、积分不够扣：调整后不能是负数，请核对后再填')
})

test('手动加减带上选中会员的编号和资产版本', async () => {
  const { withChosenMember } = await load('services/membership.ts')
  const input = { action: 'adjust', principalCents: 100, giftCents: 0, points: 0, reason: '补录' }
  assert.deepEqual(withChosenMember(input, 'acct', 'v3'), { ...input, expectedVersion: 'v3', accountId: 'acct' })
})

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
  }
  return {
    api,
    render(fn: () => unknown) {
      cursor = 0
      return fn()
    },
  }
}

// 会员页的流水和「手动加减」弹层（2026-10-20 起手动加减从底部弹出）
const membersParts = async (h: ReturnType<typeof hooks>) =>
  load('pages/staff/membership/members.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text', Textarea: 'Textarea' },
    '../../../components/button': { Button: 'Button' },
    '../../../components/pagination': { PageControls: 'PageControls', pageSlice: (items: unknown[]) => items },
    '../../../components/staff': { Field: 'Field' },
    '../../../components/staff/table-sheet': { StaffSheet: 'StaffSheet' },
    '../../../services/membership': { entryNames: { adjust: '资产调整' } },
    '../../../services/format': { ...(await load('services/format.ts')), dateTime: () => '10-11 09:46' },
  })

test('员工看到的流水写出积分增减（几个批次合计），没动积分的不写', async () => {
  const h = hooks()
  const { EntryList } = await membersParts(h)
  const entry = (id: string, points: { lotId: string; delta: number }[]) => ({
    id,
    kind: 'adjust',
    reason: '补录',
    principalCents: 1000,
    giftCents: 0,
    points,
    createdAt: '2026-10-11T01:46:00Z',
  })
  const member = {
    balance: { tierName: '普通会员', ...balance },
    rules: [],
    entries: [
      entry('add', [{ lotId: 'l1', delta: 50 }]),
      entry('take', [
        { lotId: 'l1', delta: -20 },
        { lotId: 'l2', delta: -5 },
      ]),
      entry('money', []),
    ],
    version: 'v',
  }
  const tree = h.render(() => EntryList({ member, busy: false }))
  assert.deepEqual(nodes(tree, (n) => n.props.className === 'member-entry-title').map(label), [
    '资产调整',
    '资产调整',
    '资产调整',
  ])
  assert.deepEqual(
    nodes(tree, (n) => n.props.className === 'member-entry-meta').map(label),
    [
      '10-11 09:46',
      '余额 +¥10.00',
      '补录',
      '10-11 09:46',
      '余额 +¥10.00',
      '积分 -20',
      '积分 -5',
      '补录',
      '10-11 09:46',
      '余额 +¥10.00',
      '积分 +50',
      '补录',
    ],
    '新的在前，余额和积分增减均可见',
  )
})

test('店员手动加减：扣成负数的先提示不提交；改好后按确认框提交，成功后清空并收起，取消了保留', async () => {
  const h = hooks()
  const { AdjustSheet } = await membersParts(h)
  const acts: { input: any; confirmation?: string }[] = []
  let confirmed = true
  let closed = 0
  const member = { balance: { tierName: '普通会员', ...balance }, rules: [], entries: [], version: 'v' }
  const act = async (input: unknown, confirmation?: string) => {
    acts.push({ input, confirmation })
    return confirmed
  }
  const render = () => h.render(() => AdjustSheet({ member, busy: false, act, onClose: () => closed++ }))
  let tree = render() as any
  assert.equal(tree.props.title, '手动加减')
  assert.equal(tree.props.dirty, false, '还没填，点遮罩照常关')
  const field = (name: string) => nodes(tree, (n) => n.type === 'Field' && n.props.label === name)[0]
  const submit = async () => {
    // 按钮在弹层底部（StaffSheet 的 footer）
    assert.equal(label(tree.props.footer), '确认加减')
    tree.props.footer.props.onClick()
    await settle()
    tree = render() as any
  }

  field('本金（元）').props.onChange('-60')
  nodes(tree, (n) => n.type === 'Textarea')[0].props.onInput({ detail: { value: '退回多收的' } })
  tree = render() as any
  assert.equal(tree.props.dirty, true, '填了字点遮罩不关')
  await submit()
  assert.equal(acts.length, 0)
  assert.match(label(tree), /本金不够扣/)

  field('本金（元）').props.onChange('-10')
  field('积分').props.onChange('20')
  tree = render()
  assert.doesNotMatch(label(tree), /不够扣/, '一改就清掉提示')

  confirmed = false
  await submit()
  assert.deepEqual(acts[0].input, {
    action: 'adjust',
    principalCents: -1000,
    giftCents: 0,
    points: 20,
    reason: '退回多收的',
  })
  assert.equal(
    acts[0].confirmation,
    '本次：本金 -¥10.00、积分 +20。调整后：本金 ¥40.00、赠送余额 ¥10.00、积分 50。原因：退回多收的',
  )
  assert.equal(field('本金（元）').props.value, '-10', '确认框点了取消，填的不丢')
  assert.equal(closed, 0)

  confirmed = true
  await submit()
  assert.equal(acts.length, 2)
  assert.equal(closed, 1, '办完收起弹层')
  assert.equal(field('本金（元）').props.value, '', '办完清空，不会手滑再加一次')
  assert.equal(field('积分').props.value, '')
})
