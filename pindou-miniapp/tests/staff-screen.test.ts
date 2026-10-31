import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes } from './helpers/tree'

// 员工页的骨架：刷新失败时有上次的内容就留着并标出来，没有就整块换成失败提示。
// （读取本身见 refresh-state.test.tsx：哪些失败留着上次的内容、哪些必须清掉。）
test('staff screen marks stale content and retains children only when available', async () => {
  const auth = { status: 'authenticated', account: { id: 'employee', roles: ['clerk'] } }
  const { StaffScreen } = await load('components/staff.tsx', {
    '@tarojs/taro': { default: {}, useRouter: () => ({ path: '/pages/staff/tables/index' }) },
    '@tarojs/components': { View: 'View', Text: 'Text' },
    './button': { Button: 'Button' },
    './customer': { Screen: 'Screen', Status: 'Status', Skeleton: 'Skeleton' },
    '../hooks/customer': { useCustomer: () => auth },
    '../services/staff': { staffMessage: (error: Error) => error.message },
  })
  const tree = StaffScreen({
    title: '经营大屏',
    error: new Error('offline'),
    stale: true,
    children: 'last table state',
  })
  const content = tree.props.children.props.children[1].props.children[1]
  assert.equal(content.props.children[1], 'last table state')
  assert.match(content.props.children[0].props.children[0].props.children, /上次读取/)
  const failed = StaffScreen({ title: '经营大屏', error: new Error('offline'), children: 'must not display' })
  assert.equal(failed.props.children.props.children[1].props.children[1].type, 'Status')
})

// 按日期筛的选择框：空串是不限日期；选了日期时标题旁有「清除日期」回到不限，下面是快捷日期。
// 没选日期时选择器停在调用方给的门店今天（不给的话微信按手机的日期）。
test('date field shows 不限日期 until a day is picked, and clearing or a preset sets it', async () => {
  const { DateField } = await load('components/staff.tsx', {
    '@tarojs/taro': { default: {}, useRouter: () => ({ path: '/pages/staff/reservations/index' }) },
    '@tarojs/components': { View: 'View', Text: 'Text', Picker: 'Picker' },
    './button': { Button: 'Button' },
    './customer': { Screen: 'Screen', Status: 'Status', Skeleton: 'Skeleton' },
    '../hooks/customer': { useCustomer: () => ({ status: 'authenticated' }) },
    '../services/staff': { staffMessage: (error: Error) => error.message },
  })
  const picked: string[] = []
  const field = (value: string) =>
    DateField({
      label: '到店日期',
      value,
      text: value ? '10-05 周一 · 昨天' : '',
      openAt: '2026-10-06',
      presets: [
        { text: '今天', value: '2026-10-06' },
        { text: '昨天', value: '2026-10-05' },
      ],
      onChange: (next: string) => picked.push(next),
    })
  const buttons = (tree: unknown) => nodes(tree, (node) => node.type === 'Button')
  const picker = (tree: unknown) => nodes(tree, (node) => node.type === 'Picker')[0]

  const empty = field('')
  assert.equal(label(picker(empty)), '不限日期')
  assert.equal(picker(empty).props.value, '2026-10-06', '没选日期时停在门店的今天')
  assert.equal(picker(empty).props.mode, 'date')
  assert.equal(
    buttons(empty).some((node) => label(node) === '清除日期'),
    false,
    '不限日期时没有可清除的',
  )
  assert.deepEqual(
    buttons(empty).map((node) => [label(node), node.props.className.includes('staff-tab-selected')]),
    [
      ['今天', false],
      ['昨天', false],
    ],
  )
  picker(empty).props.onChange({ detail: { value: '2026-09-30' } })
  buttons(empty)[1].props.onClick()

  const chosen = field('2026-10-05')
  assert.equal(label(picker(chosen)), '10-05 周一 · 昨天')
  assert.equal(picker(chosen).props.value, '2026-10-05')
  assert.ok(
    buttons(chosen)
      .find((node) => label(node) === '昨天')
      ?.props.className.includes('staff-tab-selected'),
  )
  buttons(chosen)
    .find((node) => label(node) === '清除日期')
    ?.props.onClick()
  assert.deepEqual(picked, ['2026-09-30', '2026-10-05', ''])

  const limited = DateField({
    label: '消费日期',
    value: '2026-10-06',
    onChange: (next: string) => picked.push(next),
    start: '2026-09-29',
    end: '2026-10-06',
    clearable: false,
    inlinePresets: true,
    presets: [{ text: '今天', value: '2026-10-06' }],
  })
  assert.equal(picker(limited).props.start, '2026-09-29')
  assert.equal(picker(limited).props.end, '2026-10-06')
  assert.deepEqual(buttons(limited).map(label), ['今天'])
  assert.equal(nodes(limited, (n) => n.props.className === 'staff-date-row').length, 1)
})

test('智能豆板加减从 0 起，最多到剩余次数；原有步进框仍从 1 起', async () => {
  const { Stepper } = await load('components/staff.tsx', { './button': { Button: 'Button' } })
  const picked: string[] = []
  const field = (value: string, max = 2) =>
    Stepper({
      label: '智能豆板',
      value,
      min: 0,
      max,
      displayOnly: true,
      unit: '次',
      onChange: (v: string) => picked.push(v),
    })
  const buttons = (tree: unknown) => nodes(tree, (n) => n.type === 'Button')
  const zero = field('0')
  assert.equal(buttons(zero)[0].props.disabled, true)
  assert.equal(buttons(zero)[1].props.disabled, false)
  buttons(zero)[1].props.onClick()
  assert.deepEqual(picked, ['1'])
  const max = field('2')
  assert.equal(buttons(max)[1].props.disabled, true)
  buttons(max)[0].props.onClick()
  assert.deepEqual(picked, ['1', '1'])
  assert.ok(buttons(field('0', 0)).every((n) => n.props.disabled))
  const original = Stepper({ label: '人数', value: '1', onChange() {} })
  assert.equal(buttons(original)[0].props.disabled, true)
  assert.equal(nodes(original, (n) => n.type === 'Input').length, 1)
})
