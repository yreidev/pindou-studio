import assert from 'node:assert/strict'
import { environmentManager } from '@tanstack/react-query'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { searchDelay, useServerSearch } from '../src/hooks/server-search'
import { createQueryClient, refreshAll } from '../src/services/query'
import { events, page, session } from './helpers/live'
import { cleanup, renderHook } from './helpers/render'

vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)

// 搜索框边打字边查会把每个字都发一次请求：关键字变了等停顿 300ms，翻页与刷新立即查，
// 迟到的旧结果不能盖掉新的。

environmentManager.setIsServer(() => false)
beforeEach(() => {
  session.reset()
  events.reset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Call = { keyword: string; page: number; resolve: (value: unknown) => void; reject: (error: unknown) => void }

function search(options: { refetchInterval?: number } = {}) {
  const calls: Call[] = []
  const load = (keyword: string, page: number) =>
    new Promise<any>((resolve, reject) => calls.push({ keyword, page, resolve, reject }))
  const client = createQueryClient()
  const view = renderHook(
    (props: { keyword: string; page: number }) =>
      useServerSearch(['accounts', 20], load, props.keyword, { page: props.page, ...options }),
    client,
    { keyword: '', page: 1 },
  )
  return { calls, client, view, state: () => view.result.current }
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

test('server search waits for typing to pause, refreshes at once and drops late answers', async () => {
  assert.equal(searchDelay, 300)
  const { calls, client, view, state } = search()

  // 打开就查（服务端默认顺序的第一页），不等
  assert.equal(state().loading, true)
  await tick()
  assert.deepEqual(
    calls.map((call) => [call.keyword, call.page]),
    [['', 1]],
  )
  calls[0].resolve({ items: [{ id: 'new' }], total: 30, page: 1 })
  await tick()
  assert.deepEqual([state().loading, state().ready, state().total, state().items.length], [false, true, 30, 1])

  // 连着打两个字：只在停顿后查最后那个
  view.rerender({ keyword: '小', page: 1 })
  await tick(200)
  view.rerender({ keyword: '小林 ', page: 1 })
  assert.equal(state().loading, true, '关键字变了要标出正在查')
  assert.equal(state().items.length, 1, '新结果回来前保留上一次的，不闪空')
  await tick(299)
  assert.equal(calls.length, 1, '停顿不够 300ms 不发请求')
  await tick(1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].keyword, '小林', '去掉首尾空白再查')

  // 那次还没回来又改了关键字：先发的那次后回来，不能盖掉后发的
  view.rerender({ keyword: '小林子', page: 1 })
  await tick(300)
  assert.equal(calls.length, 3)
  assert.equal(state().loading, true, '上一个关键字的结果还没回来，仍在查')
  calls[2].resolve({ items: [{ id: 'lin' }], total: 1, page: 1 })
  await tick()
  calls[1].resolve({ items: [{ id: 'stale' }], total: 9, page: 1 })
  await tick()
  assert.deepEqual(
    state().items.map((item: any) => item.id),
    ['lin'],
  )

  // 刷新（实时事件 / 定时）立即查且静默
  void refreshAll(client)
  await tick()
  assert.equal(calls.length, 4)
  assert.equal(state().loading, false, '同一关键字的刷新不打断显示')
  calls[3].reject(new Error('网络连接失败'))
  await tick()
  assert.equal(state().error, '网络连接失败')
  assert.deepEqual(
    state().items.map((item: any) => item.id),
    ['lin'],
    '刷新失败保留上次的结果',
  )

  // 翻页立即查；重试也立即查
  view.rerender({ keyword: '小林子', page: 2 })
  await tick()
  assert.deepEqual([calls[4].keyword, calls[4].page], ['小林子', 2])
  calls[4].resolve({ items: [], total: 1, page: 1 })
  await tick()
  assert.equal(state().page, 1, '页码以服务端返回的为准')
  state().retry()
  await tick()
  assert.equal(calls.length, 6)
})

test('the page’s timed refresh re-reads the search silently and stops with the page', async () => {
  const { calls, state } = search({ refetchInterval: 5000 })
  await tick()
  calls[0].resolve({ items: [{ id: 'a' }], total: 1, page: 1 })
  await tick()
  await tick(5000)
  assert.equal(calls.length, 2, '跟着页面的定时刷新重读')
  assert.equal(state().loading, false, '定时刷新是静默的')
  assert.deepEqual([calls[1].keyword, calls[1].page], ['', 1])
  calls[1].resolve({ items: [{ id: 'a' }], total: 1, page: 1 })
  page.hide()
  await tick(20000)
  assert.equal(calls.length, 2, '页面不显示时不再定时重读')
})
