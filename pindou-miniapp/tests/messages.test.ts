import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import type { Message } from '../src/services/messages'

const loyaltyMessage = (patch: any = {}): Message => ({
  id: 'entry:consume-1',
  kind: 'loyalty',
  at: '2026-10-27T10:42:00Z',
  unread: true,
  entry: {
    id: 'consume-1',
    accountId: 'a1',
    kind: 'consume',
    sourceId: '',
    reason: '',
    points: null,
    principalCents: -7990,
    giftCents: 0,
    boardUses: -1,
    serviceDate: '2026-10-25',
    createdAt: '2026-10-27T10:42:00Z',
    consumption: { packageName: '3 小时', headcount: 1, dayType: 'holiday', amountCents: 7990, extraCents: 0 },
    balanceAfter: { principalCents: 80810, giftCents: 12000, boardUses: 1 },
    ...patch,
  },
})

test('消息按发生时刻的门店日期分今天、昨天及日子，日内从新到旧，补录业务日期不影响分组', async () => {
  const { messageDays } = await load('services/messages.ts')
  const items = [
    { ...loyaltyMessage(), id: 'old', at: '2026-10-25T04:00:00Z' },
    { ...loyaltyMessage(), id: 'yesterday', at: '2026-10-26T15:59:00Z' },
    { ...loyaltyMessage(), id: 'today-1', at: '2026-10-26T16:00:00Z' },
    { ...loyaltyMessage(), id: 'today-2', at: '2026-10-27T04:00:00Z' },
  ]
  const groups = messageDays(items, Date.parse('2026-10-27T04:05:00Z'))
  assert.deepEqual(
    groups.map((g) => [g.key, g.title, g.items.map((m) => m.id)]),
    [
      ['2026-10-27', '今天', ['today-2', 'today-1']],
      ['2026-10-26', '昨天', ['yesterday']],
      ['2026-10-25', '10月25日 周日', ['old']],
    ],
  )
})

test('消息消费、充值、撤销逐句显示稿件文案，金额千分位、另付与余额快照不丢失', async () => {
  const { messageText, messagePreview } = await load('services/messages.ts')
  assert.deepEqual(messageText(loyaltyMessage({ reason: '店内备注：加购材料' })), {
    title: '消费 ¥79.90',
    lines: ['3 小时 · 单人 · 节假日 · 用豆板 1 次', '余额 ¥928.10 · 智能豆板剩 1 次'],
    icon: 'consume',
    target: '/pages/customer/consumption-detail/index?id=consume-1',
    time: '18:42',
  })
  const recharge = loyaltyMessage({
    kind: 'recharge',
    principalCents: 88800,
    giftCents: 12000,
    boardUses: 2,
    consumption: undefined,
    rule: { name: '888 送 120' },
    balanceAfter: { principalCents: 88800, giftCents: 12000, boardUses: 2 },
  })
  assert.deepEqual(messageText(recharge).lines, ['888 送 120，另送智能豆板 2 次', '余额 ¥1,008.00 · 智能豆板剩 2 次'])
  assert.equal(messageText(recharge).title, '充值到账 ¥1,008.00')
  const reverse = loyaltyMessage({
    kind: 'consume_reverse',
    sourceId: 'consume-0',
    reason: '金额填错，重新登记',
    consumption: { amountCents: 5990 },
  })
  assert.deepEqual(messageText(reverse).lines, ['当天 ¥59.90 的消费，已退回余额', '原因：金额填错，重新登记'])
  assert.equal(messageText(reverse).title, '门店撤销了一笔消费')
  assert.equal(messageText(reverse).target, '/pages/customer/consumption-detail/index?id=consume-0')
  assert.equal(messagePreview(loyaltyMessage()), '消费 ¥79.90，余额 ¥928.10')
  assert.ok(
    messageText(
      loyaltyMessage({
        consumption: { amountCents: 10000, extraCents: 2010, packageName: '其他', headcount: 2, dayType: 'workday' },
      }),
    ).lines.includes('余额不够，另付 ¥20.10'),
  )
})

test('其他会员流水沿用现有中文标题，第二行写金额、豆板与积分变动；兼容null积分', async () => {
  const { messageText } = await load('services/messages.ts')
  const names = {
    adjust: '资产调整',
    recharge_refund: '充值退款',
    exchange: '积分兑换',
    birthday: '生日福利',
    fulfill_gift: '礼物核销',
    checkout: '消费扣款',
    earned: '消费积分',
    tier: '等级权益',
    refund: '消费退款',
    birthday_used: '生日折扣使用',
  }
  for (const [kind, title] of Object.entries(names)) {
    const text = messageText(
      loyaltyMessage({
        kind,
        consumption: undefined,
        principalCents: -100100,
        giftCents: 0,
        boardUses: 2,
        points: [{ delta: -10, expiresAt: '' }],
        reason: '门店登记',
      }),
    )
    assert.equal(text.title, title)
    assert.equal(text.lines[0], '余额 −¥1,001.00 · 智能豆板 +2 次 · 积分 -10')
    assert.equal(text.lines[1], '门店登记')
    assert.equal(text.target, '/pages/customer/consumption-detail/index?id=consume-1')
  }
  assert.doesNotThrow(() => messageText(loyaltyMessage({ kind: 'adjust', points: null })))
})

test('预约成功和门店取消显示预约日期桌号，带真实宽限与取消原因', async () => {
  const { messageText } = await load('services/messages.ts')
  const item: any = {
    id: 'reservation:r1:confirmed',
    kind: 'reservation_confirmed',
    at: '2026-10-27T03:05:00Z',
    unread: true,
    reservation: {
      tableNumber: 3,
      reservation: { serviceTableId: 'table-3', startAt: '2026-10-28T07:00:00Z', packageName: '3 小时', reason: '' },
    },
  }
  const tables = [{ id: 'table-3', code: 'B3' }]
  assert.deepEqual(messageText(item, tables).lines, ['10月28日 周三 15:00 · B3 号桌', '3 小时 · 开始后 30 分钟内到店'])
  assert.equal(messageText(item, tables).title, '预约成功')
  assert.equal(messageText(item, tables, 15).lines[1], '3 小时 · 开始后 15 分钟内到店')
  item.kind = 'reservation_cancelled'
  item.reservation.reservation.reason = '临时闭店'
  assert.deepEqual(messageText(item, tables).lines, ['10月28日 周三 15:00 · B3 号桌', '原因：临时闭店'])
  assert.equal(messageText(item, tables).title, '预约被取消')
})

test('消息API：预览limit=1、完整读取与无正文无幂等键的已读POST，错误保留鉴权状态', async () => {
  const calls: any[] = []
  const customer = await load('services/customer.ts')
  const { messages } = await load('services/messages.ts', {
    './customer': customer,
    './staff': {
      request: async (...args) => {
        calls.push(args)
        return { items: [], unreadCount: 0 }
      },
    },
  })
  await messages.preview()
  await messages.me()
  await messages.markRead()
  assert.deepEqual(calls, [
    ['/messages/me?limit=1', 'GET'],
    ['/messages/me', 'GET'],
    ['/messages/me/reads', 'POST'],
  ])
  const failed = await load('services/messages.ts', {
    './customer': customer,
    './staff': {
      request: async () => {
        throw { code: 'unauthenticated', message: '请先登录', status: 401 }
      },
    },
  })
  await assert.rejects(failed.messages.me(), (e: any) => e instanceof customer.CustomerError && e.status === 401)
})
