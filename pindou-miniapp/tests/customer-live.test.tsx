import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { environmentManager } from '@tanstack/react-query'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { useCustomerQuery } from '../src/hooks/query'
import { createQueryClient } from '../src/services/query'
import { MessageBadge } from '../src/components/customer/message-badge'
import { messages } from '../src/services/messages'
import { messageRedDot } from '../src/services/message-indicator'
import { src } from './helpers/load'
import { events, page, session } from './helpers/live'
import { cleanup, flush, renderHook } from './helpers/render'

vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)
vi.mock('../src/services/messages', () => ({
  messages: { preview: vi.fn(async () => ({ items: [], unreadCount: 1 })) },
}))
vi.mock('../src/services/message-indicator', () => ({ messageRedDot: vi.fn(async () => {}) }))

// 顾客端实时：订单、订单详情、我的预约、本次手作、会员中心这几页显示时连着事件流，
// 员工一改到本人数据（收款、确认预约、开台、充值……）就重读；离开页面断开，没登录不连。

environmentManager.setIsServer(() => false)
beforeEach(() => {
  session.reset([])
  events.reset()
  vi.clearAllMocks()
})
afterEach(cleanup)

test('a live customer page re-reads when the server says its own data changed', async () => {
  let loads = 0
  const load = async () => ++loads
  renderHook(() => useCustomerQuery(['sales-orders'], load, { live: true }), createQueryClient(), undefined)
  await flush()
  assert.equal(events.open().length, 1, '显示中的实时页面要连事件流')
  const before = loads
  events.push()
  await flush()
  assert.equal(loads, before + 1, '收到事件要重读')

  // 离开页面断开；回来重新连
  page.hide()
  assert.equal(events.open().length, 0)
  assert.equal(events.connections.length, 1)
  page.show()
  await flush()
  assert.equal(events.open().length, 1)
  assert.equal(events.connections.length, 2)
})

test('pages without live, and guests, never open an event stream', async () => {
  renderHook(() => useCustomerQuery(['account'], async () => 1), createQueryClient(), undefined)
  await flush()
  assert.equal(events.connections.length, 0)

  session.signOut()
  let reads = 0
  renderHook(
    () => useCustomerQuery(['sales-orders'], async () => ++reads, { live: true }),
    createQueryClient(),
    undefined,
  )
  await flush()
  assert.equal(events.connections.length, 0)
  assert.equal(reads, 0, '没登录不读本人数据')
})

test('红点不开额外连接，页面的实时刷新和切回页面都会重读消息预览', async () => {
  let loads = 0
  renderHook(
    () => {
      useCustomerQuery(['loyalty'], async () => ++loads, { live: true })
      MessageBadge()
    },
    createQueryClient(),
    undefined,
  )
  await flush()
  assert.equal(events.open().length, 1)
  assert.equal(vi.mocked(messages.preview).mock.calls.length, 1)
  assert.equal(vi.mocked(messageRedDot).mock.lastCall?.[0], true)
  const before = loads
  vi.mocked(messages.preview).mockResolvedValueOnce({ items: [], unreadCount: 0 })
  events.push()
  await flush()
  assert.equal(loads, before + 1)
  assert.equal(vi.mocked(messages.preview).mock.calls.length, 2)
  assert.equal(vi.mocked(messageRedDot).mock.lastCall?.[0], false)
  page.hide()
  assert.equal(events.open().length, 0)
  page.show()
  await flush()
  assert.equal(events.open().length, 1)
  assert.equal(vi.mocked(messages.preview).mock.calls.length, 3)
  assert.equal(vi.mocked(messageRedDot).mock.lastCall?.[0], true)
})

test('the experience page re-reads every five seconds only while it is shown', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    let reads = 0
    renderHook(
      () => useCustomerQuery(['experience'], async () => ++reads, { live: true, refetchInterval: 5000 }),
      createQueryClient(),
      undefined,
    )
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(reads, 1)
    await vi.advanceTimersByTimeAsync(5000)
    assert.equal(reads, 2, '计时在走，每 5 秒重读')
    page.hide()
    await vi.advanceTimersByTimeAsync(20000)
    assert.equal(reads, 2, '离开页面就停')
    page.show()
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(reads, 3, '回来立即重读')
  } finally {
    vi.useRealTimers()
  }
})

test('实时连接只在顾客内容页开启，通用红点组件复用页面刷新', () => {
  // 「我的预约」的内容在 components/customer/my-reservations.tsx：独立的「我的预约」页和收费关着时的底部第二格共用，
  // 同一时刻只显示其中一页
  const live = [
    'pages/orders/index.tsx',
    'pages/customer/order-detail/index.tsx',
    'components/customer/my-reservations.tsx',
    'pages/customer/experience/index.tsx',
    'pages/customer/membership/index.tsx',
    'pages/profile/index.tsx',
    'pages/customer/messages/index.tsx',
    'pages/customer/consumption-detail/index.tsx',
  ]
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : []
    })
  const found = [...walk(path.join(src, 'pages')), ...walk(path.join(src, 'components'))]
    .filter((file) => /live:\s*true/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(src, file))
    .sort()
  // 微信同时最多 5 条 socket，首页这类聚合页不开；新增要先想清楚
  assert.deepEqual(found, live.sort())
})
