// 接口地址：构建时写进去的完整地址（.env.production 的 TARO_APP_API_BASE）。
export const apiBase = process.env.TARO_APP_API_BASE || 'http://127.0.0.1:8080/api/v2'

/** 实时事件流的 WebSocket 地址：按接口地址的协议换（https 用 wss）。 */
export function eventStreamUrl(): string {
  return (
    apiBase
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:')
      .replace(/\/$/, '') + '/event-streams'
  )
}
