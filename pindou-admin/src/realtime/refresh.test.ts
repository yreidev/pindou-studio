import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshAfterRealtime } from './refresh'

/** 三个页面正在用的查询：普通的订单、后台也要读的呼叫、只算不写的计算示例。数各自读了几次。 */
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const reads = { orders: 0, calls: 0, preview: 0 }
  const observers = [
    new QueryObserver(queryClient, {
      queryKey: ['sales-orders'],
      queryFn: async () => ++reads.orders,
    }),
    new QueryObserver(queryClient, {
      queryKey: ['service-calls', 'open'],
      queryFn: async () => ++reads.calls,
      meta: { realtimeInBackground: true },
    }),
    new QueryObserver(queryClient, {
      queryKey: ['loyalty-rules', 'preview'],
      queryFn: async () => ++reads.preview,
      meta: { realtime: false },
    }),
  ]
  const unsubscribe = observers.map((observer) => observer.subscribe(() => {}))
  return { queryClient, reads, stop: () => unsubscribe.forEach((u) => u()) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let stop = () => {}
afterEach(() => stop())

describe('实时事件后的重读', () => {
  it('前台：正在用的都重读（计算示例除外）', async () => {
    const env = setup()
    stop = env.stop
    await settle()
    expect(env.reads).toEqual({ orders: 1, calls: 1, preview: 1 })
    refreshAfterRealtime(env.queryClient, { resources: ['sales-orders'], visible: true })
    await settle()
    expect(env.reads).toEqual({ orders: 2, calls: 2, preview: 1 })
  })

  it('后台：只有呼叫列表随自己的事件立刻重读，别的只标过期', async () => {
    const env = setup()
    stop = env.stop
    await settle()
    refreshAfterRealtime(env.queryClient, { resources: ['service-calls'], visible: false })
    await settle()
    expect(env.reads).toEqual({ orders: 1, calls: 2, preview: 1 })
    expect(env.queryClient.getQueryState(['sales-orders'])?.isInvalidated).toBe(true)

    // 别的资源的事件：后台连呼叫列表也不读
    refreshAfterRealtime(env.queryClient, { resources: ['sales-orders', 'inventory'], visible: false })
    await settle()
    expect(env.reads).toEqual({ orders: 1, calls: 2, preview: 1 })
  })

  it('后台重连（可能漏了事件）：呼叫列表也补读一次', async () => {
    const env = setup()
    stop = env.stop
    await settle()
    refreshAfterRealtime(env.queryClient, { resources: null, visible: false })
    await settle()
    expect(env.reads).toEqual({ orders: 1, calls: 2, preview: 1 })
  })
})
