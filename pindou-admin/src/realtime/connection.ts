import { Batcher } from '@tanstack/react-pacer'
import ReconnectingWebSocket from 'partysocket/ws'

// 员工实时事件流：小程序、网页、后端三端同步。
//
// 后端任何一端的写请求提交成功后推 {"type":"resource.updated","resource":"<资源名>"}，
// 网页收到后只让对应资源的缓存过期、重新读取，不在前端推演业务状态。
// 另有本人手机「扫码给电脑」转来的码 {"type":"scan.relayed","code":"…"}，交给 onScan（见 scans.tsx）。
//
// 断线重连交给 partysocket 的 ReconnectingWebSocket（退避、连接超时、连上满一段时间才重置退避），
// 这里只管：每次（重）连现取令牌、重连前确认会话、连接状态、合并事件。
//
// ★ 浏览器的 WebSocket 设不了 Authorization 头，令牌放在子协议里：['pindou.v1', 'bearer.' + 令牌]，
//   服务端回显 pindou.v1。不放网址参数——网址会进代理的访问日志。
// ★ 后端每 30 秒发一个 Ping 当心跳，浏览器自动回 Pong、页面收不到，所以不能拿它判断连接死活；
//   断线靠浏览器的 close 事件，加上切回标签页时的整体重读兜底。

export type RealtimeStatus = 'connecting' | 'open' | 'closed'

export interface RealtimeOptions {
  url: string
  /** 每次（重）连前现取：期间可能换了人或退出了登录。没有令牌就停下，不再连。 */
  token: () => string | null
  /** 一段时间内收到的资源名去重后一起交出来，一串事件只触发一次重读。 */
  onResources: (resources: string[]) => void
  /**
   * 本人手机「扫码给电脑」转来的码（{"type":"scan.relayed","code":"…"}，后端只发给本人的网页会话）：
   * 不合并、不重读，来一个交一个。
   */
  onScan?: (code: string) => void
  /** 连上（含重连）后调用：断线期间可能漏了事件，整体重读一次。 */
  onConnected: () => void
  onStatus: (status: RealtimeStatus) => void
  /**
   * 每次重连前调用，用普通接口确认会话还有效。握手被拒（会话撤销、员工身份被撤）时浏览器只给一个
   * close 事件、看不到状态码，不先确认就会拿着失效的令牌一直重连。失败不影响重连（例如网络还没恢复）。
   */
  beforeReconnect?: () => Promise<unknown>
  /** 测试换上假的 WebSocket。 */
  WebSocket?: typeof WebSocket
  batchWaitMs?: number
  /** 事件连着来时，从第一条起最多等这么久就刷一次（合并等待每来一条都会重新计时）。 */
  batchMaxWaitMs?: number
}

export const realtimeProtocol = 'pindou.v1'

/**
 * 重连的节奏：第 n 次重连前等 1、2、4、8…秒，最长 30 秒；连上满 5 秒才算稳定、退避从头算
 * （连上就被断的不重置，免得服务端一接受就断时每秒重连一次）；10 秒还没连上算失败，按退避重试。
 */
export const reconnectTiming = {
  minReconnectionDelay: 1000,
  reconnectionDelayGrowFactor: 2,
  maxReconnectionDelay: 30_000,
  minUptime: 5000,
  connectionTimeout: 10_000,
} as const

export function eventStreamUrl(location: Location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/api/v2/event-streams`
}

export class RealtimeConnection {
  private socket: ReconnectingWebSocket | null = null
  private readonly batcher: Batcher<string>
  /** 这一批第一条事件到达的时间；刷过就清空。 */
  private firstQueuedAt: number | null = null
  private readonly options: RealtimeOptions & Required<Pick<RealtimeOptions, 'batchWaitMs' | 'batchMaxWaitMs'>>

  constructor(options: RealtimeOptions) {
    this.options = { batchWaitMs: 300, batchMaxWaitMs: 2000, ...options }
    this.batcher = new Batcher<string>(
      (items) => {
        this.firstQueuedAt = null
        this.options.onResources([...new Set(items)])
      },
      {
        wait: this.options.batchWaitMs,
        getShouldExecute: () =>
          this.firstQueuedAt !== null && Date.now() - this.firstQueuedAt >= this.options.batchMaxWaitMs,
      },
    )
  }

  start(): void {
    if (this.socket) return
    if (!this.options.token()) {
      this.options.onStatus('closed')
      return
    }
    let reconnecting = false
    const socket: ReconnectingWebSocket = new ReconnectingWebSocket(
      this.options.url,
      // 子协议在每次（重）连前现算：重连前先确认会话，再取当时的令牌
      async () => {
        if (reconnecting) await this.options.beforeReconnect?.().catch(() => undefined)
        reconnecting = true
        const token = this.socket === socket ? this.options.token() : null
        if (!token) {
          // 已停止，或确认会话时发现退出了登录：不再连（close 之后 partysocket 不会再建连接）
          if (this.socket === socket) this.stop()
          return [realtimeProtocol]
        }
        this.options.onStatus('connecting')
        return [realtimeProtocol, `bearer.${token}`]
      },
      { ...reconnectTiming, maxEnqueuedMessages: 0, WebSocket: this.options.WebSocket },
    )
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.options.onStatus('open')
      this.options.onConnected()
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; resource?: string; code?: unknown }
        if (message.type === 'resource.updated' && message.resource) {
          this.firstQueuedAt ??= Date.now()
          this.batcher.addItem(message.resource)
        } else if (message.type === 'scan.relayed' && typeof message.code === 'string' && message.code.trim()) {
          this.options.onScan?.(message.code.trim())
        }
      } catch {
        // 不认识的消息直接忽略
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.options.onStatus('closed')
    })
    this.socket = socket
  }

  stop(): void {
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.options.onStatus('closed')
  }
}
