import Taro from '@tarojs/taro'
import { eventStreamUrl } from './api-base'

// 事件流：员工、顾客共用一条连接方式。后端写请求提交成功后推「某资源已更新」，
// 收到就重新读取，不在本地推算状态。员工连接收全店事件；顾客连接只收本人名下数据的事件
// （订单、预约、会员资产、入座……），见 docs/api.yaml 的 /event-streams。
// 会话失效或身份有变时服务端会断开，这里按退避重连，重连时用的是当时存着的令牌。

const storageKey = 'pindou.customer.credential.v1'
const credential = () => Taro.getStorageSync(storageKey) as { accessToken?: string } | null

export function connectEvents(
  onResourceUpdate: () => void,
  onConnection?: (state: 'connecting' | 'connected' | 'reconnecting') => void,
): () => void {
  const token = credential()?.accessToken
  if (!token) return () => {}
  const url = eventStreamUrl()
  let task: Taro.SocketTask | null = null
  let stopped = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retry = 0
  const connect = () => {
    if (stopped) return
    onConnection?.(retry ? 'reconnecting' : 'connecting')
    void Taro.connectSocket({ url, header: { Authorization: `Bearer ${token}` } })
      .then((value) => {
        if (stopped) {
          value.close({ code: 1000, reason: 'page hidden' })
          return
        }
        task = value
        task.onOpen(() => {
          retry = 0
          onConnection?.('connected')
          onResourceUpdate()
        })
        task.onMessage(() => onResourceUpdate())
        task.onClose(() => {
          task = null
          if (stopped) return
          onConnection?.('reconnecting')
          const delay = Math.min(30000, 1000 * 2 ** retry++)
          retryTimer = setTimeout(connect, delay)
        })
        task.onError(() => {
          try {
            task?.close({ code: 1001, reason: 'reconnect' })
          } catch {
            /* socket already closed */
          }
        })
      })
      .catch(() => {
        if (stopped) return
        onConnection?.('reconnecting')
        const delay = Math.min(30000, 1000 * 2 ** retry++)
        retryTimer = setTimeout(connect, delay)
      })
  }
  connect()
  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    try {
      task?.close({ code: 1000, reason: 'page hidden' })
    } catch {
      /* socket already closed */
    }
    task = null
  }
}

/**
 * 把一串调用合并成一次：最后一次调用后等 waitMs 再执行；调用连着来时，从第一次起最多等 maxWaitMs 就执行一次，
 * 不会被一直推迟。实时事件常常一次来好几条（收款会同时改订单、库存、会员），每条都重读一遍是白费流量。
 */
export function coalesce(fn: () => void, waitMs = 300, maxWaitMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let first: number | null = null
  const run = () => {
    if (timer) clearTimeout(timer)
    timer = null
    first = null
    fn()
  }
  return {
    call: () => {
      const now = Date.now()
      first ??= now
      if (timer) clearTimeout(timer)
      if (now - first >= maxWaitMs) run()
      else timer = setTimeout(run, waitMs)
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      first = null
    },
  }
}
