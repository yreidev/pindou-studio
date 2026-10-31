import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes } from './helpers/tree'
import type { Entry } from '../src/services/membership'

const entry = (patch: Partial<Entry> = {}): Entry => ({
  id: 'consume-1',
  accountId: 'account-1',
  kind: 'consume',
  sourceId: '',
  reason: '',
  principalCents: -5990,
  giftCents: 0,
  points: [],
  boardUses: -1,
  serviceDate: '2026-10-25',
  createdAt: '2026-10-27T02:00:00Z',
  consumption: {
    packageId: '',
    packageName: '3 小时',
    headcount: 1,
    dayType: 'holiday',
    amountCents: 7990,
    extraCents: 2000,
  },
  balanceAfter: { principalCents: 80810, giftCents: 12000, boardUses: 1 },
  ...patch,
})

test('顾客撤销合回原消费一行，员工流水仍两行；按业务月统计未撤销消费全额和充值本金', async () => {
  const { customerEntries, entryMonths, memberEntry } = await load('services/member-entry.ts')
  const old = entry({ id: 'old', serviceDate: '2026-09-30' })
  const reverse = entry({
    id: 'reverse',
    kind: 'consume_reverse',
    sourceId: 'old',
    serviceDate: '2026-10-27',
    reason: '金额填错，重新登记',
    principalCents: 5990,
    boardUses: 1,
  })
  const recharge = entry({
    id: 'recharge',
    kind: 'recharge',
    serviceDate: '2026-10-24',
    principalCents: 88800,
    giftCents: 12000,
    boardUses: 2,
    consumption: undefined,
  })
  const data = [old, recharge, entry(), reverse]
  const rows = customerEntries(data)
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((r) => r.entry.kind === 'consume_reverse').length, 0)
  assert.equal(rows.find((r) => r.entry.id === 'old').reversal.id, 'reverse')
  assert.deepEqual(rows.find((r) => r.entry.id === 'old').notes, [
    '用智能豆板 1 次',
    '余额不够，另付 ¥20.00',
    '门店撤销：金额填错，重新登记',
  ])
  assert.equal(rows.find((r) => r.entry.id === 'old').amount, '−¥59.90')
  assert.match(memberEntry(old, data).title, /消费/)
  assert.match(memberEntry(reverse, data).title, /撤销消费/)
  assert.deepEqual(
    entryMonths(data).map(({ key, consumption, recharge }) => ({ key, consumption, recharge })),
    [
      { key: '2026-10', consumption: 7990, recharge: 88800 },
      { key: '2026-09', consumption: 0, recharge: 0 },
    ],
  )
  assert.equal(rows.find((r) => r.entry.id === 'recharge').amount, '+¥1,008.00')
})

test('月合计基于完整明细，分页20条；旧流水取记账时刻的门店日期', async () => {
  const { entryMonths, entryDate } = await load('services/member-entry.ts')
  assert.equal(entryDate(entry({ serviceDate: undefined, createdAt: '2026-09-30T16:05:00Z' })), '2026-10-01')
  const entries = Array.from({ length: 21 }, (_, i) =>
    entry({
      id: String(i),
      principalCents: -100,
      boardUses: 0,
      consumption: {
        packageId: '',
        packageName: '其他',
        headcount: 1,
        dayType: 'workday',
        amountCents: 100,
        extraCents: 0,
      },
    }),
  )
  assert.equal(entryMonths(entries)[0].consumption, 2100)
  const { MemberHistory } = await load('components/customer/member-history.tsx', {
    '../button': { Button: 'Button' },
    '../pagination': {
      PageControls: 'PageControls',
      pageSlice: (items, page) => items.slice(page * 20, page * 20 + 20),
    },
  })
  for (const [page, count] of [
    [0, 20],
    [1, 1],
  ]) {
    const tree = MemberHistory({ entries, page, onPage() {}, busy: false })
    assert.equal(nodes(tree, (n) => n.type === 'Button').length, count)
    assert.match(label(tree), /消费 ¥21.00 · 充值 ¥0.00/)
  }
})

test('顾客明细不显示消费备注，保留撤销与手动调整原因；员工仍可看消费备注', async () => {
  const { customerEntries, memberEntry } = await load('services/member-entry.ts')
  const original = entry({ reason: '店内备注：加购材料' })
  assert.deepEqual(customerEntries([original])[0].notes, ['用智能豆板 1 次', '余额不够，另付 ¥20.00'])
  assert.ok(memberEntry(original, [original]).lines.includes('店内备注：加购材料'))
  const reversal = entry({ kind: 'consume_reverse', sourceId: original.id, reason: '金额填错' })
  const reversed = customerEntries([original, reversal])[0]
  assert.ok(reversed.notes.includes('门店撤销：金额填错'))
  assert.ok(!reversed.notes.includes(original.reason))
  const adjustment = entry({ kind: 'adjust', consumption: undefined, reason: '补赠余额' })
  assert.ok(customerEntries([adjustment])[0].notes.includes('补赠余额'))
})

test('消费小票显示全额、余额扣、另付和原快照；充值共用布局、撤销显式标记', async () => {
  const { ConsumptionReceipt } = await load('pages/customer/consumption-detail/index.tsx')
  const original = entry({ reason: '加购材料' })
  const receipt = ConsumptionReceipt({ entry: original })
  const text = label(receipt)
  for (const content of [
    'EXAMPLE 示例工坊 · 消费记录',
    '−¥79.90',
    '余额不够，另付 ¥20.00',
    '消费日期10月25日 周日',
    '3 小时 · 单人 · 节假日',
    '余额扣¥59.90',
    '用 1 次',
    '扣完余额¥928.10',
    '其中赠送 ¥120.00',
    '店里 10月27日 10:00 登记',
  ])
    assert.ok(text.includes(content), content)
  assert.doesNotMatch(text, /备注|加购材料/)
  const reversed = label(ConsumptionReceipt({ entry: original, reversal: entry({ reason: '金额填错' }) }))
  assert.match(reversed, /已撤销 · 已退回/)
  assert.match(reversed, /门店撤销：金额填错/)
  assert.doesNotMatch(reversed, /备注|加购材料/)
  const recharge = ConsumptionReceipt({
    entry: entry({ kind: 'recharge', principalCents: 88800, giftCents: 12000, consumption: undefined, boardUses: 2 }),
  })
  for (const content of ['充值记录', '+¥1,008.00', '实付¥888.00', '赠送余额¥120.00', '送 2 次'])
    assert.ok(label(recharge).includes(content), content)
})

test('消费、充值以外的流水也能点开：同一张小票写日期、内容、余额豆板积分变动和原因，旧流水不补算记完余额', async () => {
  const { EntryReceipt } = await load('pages/customer/consumption-detail/index.tsx')
  const adjust = label(
    EntryReceipt({
      entry: entry({
        kind: 'adjust',
        consumption: undefined,
        principalCents: 10000,
        giftCents: 0,
        boardUses: 2,
        reason: '补录老账',
        balanceAfter: { principalCents: 10000, giftCents: 0, boardUses: 2 },
      }),
    }),
  )
  for (const content of [
    'EXAMPLE 示例工坊 · 资产调整',
    '+¥100.00',
    '已加到余额',
    '日期10月25日 周日',
    '余额+¥100.00',
    '智能豆板+2 次',
    '原因补录老账',
    '记完余额¥100.00',
    '店里 10月27日 10:00 登记',
  ])
    assert.ok(adjust.includes(content), content)
  const earned = label(
    EntryReceipt({
      entry: entry({
        kind: 'earned',
        consumption: undefined,
        principalCents: 0,
        giftCents: 0,
        boardUses: 0,
        serviceDate: '',
        points: [{ lotId: 'lot-1', delta: 12, expiresAt: '' }],
        balanceAfter: undefined,
      }),
    }),
  )
  assert.ok(earned.includes('积分 +12'), earned)
  assert.ok(earned.includes('消费积分'), earned)
  assert.doesNotMatch(earned, /记完余额|已从余额扣除|已加到余额/)
})

test('顾客明细每一行都能点开详情：资产调整、消费积分这类旧流水也不灰', async () => {
  const navigated: string[] = []
  const { MemberHistory } = await load('components/customer/member-history.tsx', {
    '../button': { Button: 'Button' },
    '../pagination': { PageControls: 'PageControls', pageSlice: (items) => items },
    '../../services/navigation': { navigateApp: (url: string) => navigated.push(url) },
  })
  const entries = [
    entry({ id: 'adjust-1', kind: 'adjust', consumption: undefined, reason: '补赠', boardUses: 0 }),
    entry({ id: 'earned-1', kind: 'earned', consumption: undefined, principalCents: 0, boardUses: 0 }),
  ]
  const buttons = nodes(MemberHistory({ entries, page: 0, onPage() {}, busy: false }), (n) => n.type === 'Button')
  assert.equal(buttons.length, 2)
  for (const button of buttons) {
    assert.equal(button.props.disabled, false)
    button.props.onClick()
  }
  assert.deepEqual(navigated.sort(), [
    '/pages/customer/consumption-detail/index?id=adjust-1',
    '/pages/customer/consumption-detail/index?id=earned-1',
  ])
})
