import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventStreamUrl, RealtimeConnection, type RealtimeOptions, type RealtimeStatus } from './connection'

/** 假的浏览器 WebSocket：partysocket 用 addEventListener 听它的事件，用 readyState 判断要不要 close。 */
class FakeSocket extends EventTarget {
  readyState = 0
  binaryType = 'blob'
  closed = false
  readonly url: string
  readonly protocols: string[]
  constructor(url: string, protocols: string[]) {
    super()
    this.url = url
    this.protocols = protocols
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  send() {}
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }))
  }
  drop() {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

function setup(overrides: Partial<RealtimeOptions> = {}) {
  const sockets: FakeSocket[] = []
  class Socket extends FakeSocket {
    constructor(url: string, protocols: string[]) {
      super(url, protocols)
      sockets.push(this)
    }
  }
  const statuses: RealtimeStatus[] = []
  const onResources = vi.fn()
  const onConnected = vi.fn()
  const connection = new RealtimeConnection({
    url: 'wss://admin.example.invalid/api/v2/event-streams',
    token: () => 'web-token',
    onResources,
    onConnected,
    onStatus: (status) => statuses.push(status),
    WebSocket: Socket as unknown as typeof WebSocket,
    ...overrides,
  })
  return { connection, sockets, statuses, onResources, onConnected }
}

/** 让到期的计时器和随后的 Promise 都跑完（partysocket 建连接是异步的）。 */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('实时连接', () => {
  it('令牌放在子协议里，不放进网址', async () => {
    const { connection, sockets, statuses } = setup()
    connection.start()
    await advance(0)
    expect(sockets).toHaveLength(1)
    expect(sockets[0].url).toBe('wss://admin.example.invalid/api/v2/event-streams')
    expect(sockets[0].protocols).toEqual(['pindou.v1', 'bearer.web-token'])
    expect(statuses).toEqual(['connecting'])
    connection.stop()
  })

  it('一串事件去重后只交出一次，不认识的消息忽略', async () => {
    const { connection, sockets, onResources, onConnected, statuses } = setup()
    connection.start()
    await advance(0)
    sockets[0].open()
    expect(onConnected).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('open')
    sockets[0].receive({ type: 'resource.updated', resource: 'sales-orders' })
    sockets[0].receive({ type: 'resource.updated', resource: 'stock-items' })
    sockets[0].receive({ type: 'resource.updated', resource: 'sales-orders' })
    sockets[0].receive('不是 JSON')
    sockets[0].receive({ type: 'other', resource: 'tables' })
    expect(onResources).not.toHaveBeenCalled()
    await advance(300)
    expect(onResources).toHaveBeenCalledOnce()
    expect(onResources.mock.calls[0][0].sort()).toEqual(['sales-orders', 'stock-items'])
    connection.stop()
  })

  it('手机转来的码来一个交一个，不合并、不当成资源事件重读', async () => {
    const onScan = vi.fn()
    const { connection, sockets, onResources } = setup({ onScan })
    connection.start()
    await advance(0)
    sockets[0].open()
    sockets[0].receive({ type: 'scan.relayed', code: '6901234567892' })
    sockets[0].receive({ type: 'scan.relayed', code: ' 91234567890123456789 ' })
    sockets[0].receive({ type: 'scan.relayed', code: '6901234567892' })
    sockets[0].receive({ type: 'scan.relayed', code: '   ' })
    sockets[0].receive({ type: 'scan.relayed' })
    // 滚动发布时旧版本后端推出来的只有 type 和空 resource：忽略
    sockets[0].receive({ type: 'scan.relayed', resource: '' })
    expect(onScan.mock.calls.map(([code]) => code)).toEqual(['6901234567892', '91234567890123456789', '6901234567892'])
    await advance(2000)
    expect(onResources).not.toHaveBeenCalled()
    connection.stop()
  })

  it('事件连着来时，从第一条起最多等 2 秒就刷一次，不会被一直推迟', async () => {
    const { connection, sockets, onResources } = setup()
    connection.start()
    await advance(0)
    sockets[0].open()
    // 每 250 毫秒一条，合并等待（300 毫秒）永远等不满；第 2 秒那条到达时就刷
    for (let i = 0; i < 9; i++) {
      sockets[0].receive({ type: 'resource.updated', resource: 'sales-orders' })
      await advance(250)
    }
    expect(onResources).toHaveBeenCalledOnce()
    expect(onResources.mock.calls[0][0]).toEqual(['sales-orders'])
    // 刷过之后重新计算：之后的一条按合并等待交出
    sockets[0].receive({ type: 'resource.updated', resource: 'stock-items' })
    await advance(300)
    expect(onResources).toHaveBeenCalledTimes(2)
    expect(onResources.mock.calls[1][0]).toEqual(['stock-items'])
    connection.stop()
  })

  it('断线后按 1、2、4 秒退避重连；连上满 5 秒才重置退避，每次连上都整体重读', async () => {
    const { connection, sockets, statuses, onConnected } = setup()
    connection.start()
    await advance(0)
    sockets[0].drop()
    expect(statuses.at(-1)).toBe('closed')
    await advance(999)
    expect(sockets).toHaveLength(1)
    await advance(1)
    expect(sockets).toHaveLength(2)
    expect(statuses.at(-1)).toBe('connecting')
    sockets[1].drop()
    await advance(1999)
    expect(sockets).toHaveLength(2)
    await advance(1)
    expect(sockets).toHaveLength(3)
    // 连上就被断：不算稳定，接着按 4 秒退避
    sockets[2].open()
    expect(statuses.at(-1)).toBe('open')
    sockets[2].drop()
    await advance(3999)
    expect(sockets).toHaveLength(3)
    await advance(1)
    expect(sockets).toHaveLength(4)
    // 连上满 5 秒再断：从 1 秒重新算
    sockets[3].open()
    await advance(5000)
    sockets[3].drop()
    await advance(1000)
    expect(sockets).toHaveLength(5)
    expect(onConnected).toHaveBeenCalledTimes(2)
    connection.stop()
  })

  it('退避最长 30 秒', async () => {
    const { connection, sockets } = setup()
    connection.start()
    await advance(0)
    const waits: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = sockets.length
      sockets[before - 1].drop()
      let waited = 0
      while (sockets.length === before) {
        await advance(1000)
        waited += 1000
      }
      waits.push(waited)
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    connection.stop()
  })

  it('10 秒还没连上算失败，按退避重试', async () => {
    const { connection, sockets, statuses } = setup()
    connection.start()
    await advance(0)
    await advance(9999)
    expect(sockets).toHaveLength(1)
    await advance(1)
    expect(sockets[0].closed).toBe(true)
    expect(statuses.at(-1)).toBe('closed')
    await advance(1000)
    expect(sockets).toHaveLength(2)
    connection.stop()
  })

  it('停止后不再重连', async () => {
    const { connection, sockets, statuses } = setup()
    connection.start()
    await advance(0)
    sockets[0].open()
    connection.stop()
    expect(sockets[0].closed).toBe(true)
    expect(statuses.at(-1)).toBe('closed')
    await advance(60_000)
    expect(sockets).toHaveLength(1)
    expect(statuses.at(-1)).toBe('closed')
  })

  it('没有登录令牌就不连', async () => {
    const { connection, sockets, statuses } = setup({ token: () => null })
    connection.start()
    await advance(60_000)
    expect(sockets).toHaveLength(0)
    expect(statuses).toEqual(['closed'])
  })

  it('每次重连现取令牌；退出登录后不再连', async () => {
    let token: string | null = 'first'
    const { connection, sockets, statuses } = setup({ token: () => token })
    connection.start()
    await advance(0)
    expect(sockets[0].protocols).toEqual(['pindou.v1', 'bearer.first'])
    token = 'second'
    sockets[0].drop()
    await advance(1000)
    expect(sockets[1].protocols).toEqual(['pindou.v1', 'bearer.second'])
    token = null
    sockets[1].drop()
    await advance(60_000)
    expect(sockets).toHaveLength(2)
    expect(statuses.at(-1)).toBe('closed')
  })

  it('地址跟随页面协议', () => {
    expect(eventStreamUrl({ protocol: 'https:', host: 'admin.example.invalid' } as Location)).toBe(
      'wss://admin.example.invalid/api/v2/event-streams',
    )
    expect(eventStreamUrl({ protocol: 'http:', host: '127.0.0.1:5173' } as Location)).toBe(
      'ws://127.0.0.1:5173/api/v2/event-streams',
    )
  })
})

describe('重连前确认会话', () => {
  it('第一次连不确认；重连先确认完再连；确认期间被停掉就不再连', async () => {
    let release: () => void = () => {}
    const beforeReconnect = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const { connection, sockets } = setup({ beforeReconnect })
    connection.start()
    await advance(0)
    expect(beforeReconnect).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    sockets[0].drop()
    await advance(1000)
    expect(beforeReconnect).toHaveBeenCalledOnce()
    expect(sockets).toHaveLength(1)
    release()
    await advance(0)
    expect(sockets).toHaveLength(2)

    sockets[1].drop()
    await advance(2000)
    expect(beforeReconnect).toHaveBeenCalledTimes(2)
    connection.stop()
    connection.start()
    await advance(0)
    expect(sockets).toHaveLength(3)
    release()
    await advance(0)
    expect(sockets).toHaveLength(3)
    connection.stop()
  })

  it('确认失败（网络还没恢复）照样重连', async () => {
    const { connection, sockets } = setup({ beforeReconnect: () => Promise.reject(new Error('offline')) })
    connection.start()
    await advance(0)
    sockets[0].drop()
    await advance(1000)
    expect(sockets).toHaveLength(2)
    connection.stop()
  })
})
