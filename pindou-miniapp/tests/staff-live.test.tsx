import assert from 'node:assert/strict'
import { focusManager, onlineManager } from '@tanstack/react-query'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { useStaffEvents, useStaffQuery } from '../src/hooks/query'
import { connectAppLifecycle, createQueryClient, forgetOtherIdentities } from '../src/services/query'
import { app, events, page, session } from './helpers/live'
import { cleanup, flush, renderHook } from './helpers/render'

vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)

// 员工页（桌位、会话、经营、预约、会员计时）：显示期间连着实时事件，事件到达或重连时重读；
// 计时、申请过期这类随时间变的状态靠前台定时刷新兜底 —— 实时在线时 30 秒一次，断线时 5 秒；
// 页面不显示、小程序退到后台时都不读。前后台与网络接的是 Taro 的应用事件，不是 window/document。

connectAppLifecycle()
beforeEach(() => {
  session.reset()
  events.reset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 一个员工页：实时连接 + 一个跟着它定时刷新的查询。 */
function staffPage(load: () => Promise<unknown>, pollMs = 5000) {
  return renderHook(
    () => {
      const live = useStaffEvents(pollMs)
      const data = useStaffQuery(['service-tables'], load, { refetchInterval: live.refetchInterval })
      return { live, data }
    },
    createQueryClient(),
    undefined,
  )
}

test('staff pages poll every five seconds while realtime is down and every thirty seconds once connected', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let reads = 0
  const view = staffPage(async () => ++reads)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 1)
  assert.equal(events.open().length, 1, '显示中的员工页连着实时事件')
  assert.equal(view.result.current.live.polling, true)
  // 连接还没建立：按页面给的 5 秒刷新
  await vi.advanceTimersByTimeAsync(5000)
  assert.equal(reads, 2)
  events.state('connected')
  assert.equal(view.result.current.live.connection, 'connected')
  await vi.advanceTimersByTimeAsync(25000)
  assert.equal(reads, 2, '实时在线时不必 5 秒一读')
  await vi.advanceTimersByTimeAsync(5000)
  assert.equal(reads, 3, '在线时 30 秒兜底一次')
  events.state('reconnecting')
  await vi.advanceTimersByTimeAsync(5000)
  assert.equal(reads, 4, '断线后回到 5 秒')
})

test('realtime events refresh what the page shows, and the connection follows page visibility', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let reads = 0
  staffPage(async () => ++reads)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 1)
  events.push()
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 2, '事件到达（含连上、重连时的那一次）就重读')

  page.hide()
  assert.equal(events.open().length, 0, '页面不显示就断开')
  await vi.advanceTimersByTimeAsync(60000)
  assert.equal(reads, 2, '页面不显示时不定时刷新')
  page.show()
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 3, '回到页面立即重读')
  assert.equal(events.open().length, 1, '并重新连上')
})

test('accounts without a staff role open no staff connection and read nothing', async () => {
  session.reset([])
  let reads = 0
  staffPage(async () => ++reads)
  await flush()
  assert.equal(reads, 0)
  assert.equal(events.connections.length, 0)
})

test('the app going to the background pauses polling; coming back and network recovery read again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let reads = 0
  staffPage(async () => ++reads)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 1)
  // 前后台、网络接在 Taro 的应用事件上（connectAppLifecycle），不是 window 的 visibilitychange / online；
  // 有查询客户端挂着时登记（应用里 QueryClientProvider 一直挂着）
  assert.equal(app.listeners.show.size, 1)
  assert.equal(app.listeners.hide.size, 1)
  assert.equal(app.listeners.network.size, 1)
  app.hide()
  assert.equal(focusManager.isFocused(), false)
  await vi.advanceTimersByTimeAsync(20000)
  assert.equal(reads, 1, '退到后台时定时刷新暂停')
  app.show()
  assert.equal(focusManager.isFocused(), true)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 2, '回到前台立即重读')

  app.network(false)
  assert.equal(onlineManager.isOnline(), false)
  app.network(true)
  assert.equal(onlineManager.isOnline(), true)
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(reads, 3, '网络恢复立即重读')
})

test('a once-only read is not repeated by realtime events but can still be refreshed by hand', async () => {
  let reads = 0
  const view = renderHook(
    () => {
      useStaffEvents()
      return useStaffQuery(['accounts', 'a1'], async () => ++reads, { once: true })
    },
    createQueryClient(),
    undefined,
  )
  await flush()
  assert.equal(reads, 1)
  events.push()
  await flush()
  assert.equal(reads, 1, '顾客称呼这类只为显示的内容，编号不变就不重读')
  page.hide()
  page.show()
  await flush()
  assert.equal(reads, 1, '回到页面也不重读')
  view.result.current.refresh()
  await flush()
  assert.equal(reads, 2)
})

test('another identity’s cached reads are dropped when the identity changes', async () => {
  const client = createQueryClient()
  renderHook(() => useStaffQuery(['service-tables'], async () => 'owner view'), client, undefined)
  await flush()
  const before = client.getQueryCache().getAll().length
  assert.equal(before, 1)
  session.signIn(['clerk'], 'another-employee')
  forgetOtherIdentities(client, session.getSnapshot() as never)
  await flush()
  const identities = client
    .getQueryCache()
    .getAll()
    .map((query) => String(query.queryKey[1]))
  assert.ok(identities.length >= 1)
  assert.ok(
    identities.every((identity) => identity.includes('another-employee')),
    `上一个身份的内容要从缓存里删掉：${identities.join(' | ')}`,
  )
})
