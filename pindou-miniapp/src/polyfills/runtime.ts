// 小程序逻辑层缺的 AbortController，在小程序启动的第一行补到全局上（src/app.tsx 最先 import 这个文件）。
//
// ★ TanStack Query 每次读取都 new 一个 AbortController。开发者工具跑在 Chromium 上本来就有，所以在工具里
//   看不出问题；真机的逻辑层是裸 JS 引擎（iOS JavaScriptCore、安卓 V8），没有这类浏览器接口，第一次读取就会抛
//   ReferenceError。它只在发请求时才用到，模块初始化时不用，所以启动时补上就够了。
// ★★ 2026-10-05 先试过在构建时把依赖里的 AbortController、globalThis 全换成从这里导入（mini.injectOptions）：
//   注入进了公共依赖块，这个文件却在另一个块里，两块互相引用，模块初始化顺序被打乱，小程序启动就报
//   「QueryCache is not a constructor」。不要再走那条路。globalThis 是引擎自带的，当前要求的微信版本都有。

type Listener = () => void

class MiniAbortSignal {
  aborted = false
  reason: unknown = undefined
  onabort: Listener | null = null
  listeners: Listener[] = []
  addEventListener(type: string, listener: Listener) {
    if (type === 'abort') this.listeners.push(listener)
  }
  removeEventListener(type: string, listener: Listener) {
    if (type === 'abort') this.listeners = this.listeners.filter((item) => item !== listener)
  }
  throwIfAborted() {
    if (this.aborted) throw this.reason
  }
}

/**
 * 只做依赖实际用到的部分：能 new、能 abort、signal 能看到已中止并通知监听者。
 * 我们的请求走 Taro.request，不接收 signal，中止只是让 TanStack Query 丢弃那次结果。
 */
export class AbortController {
  readonly signal = new MiniAbortSignal()
  abort(reason?: unknown) {
    const signal = this.signal
    if (signal.aborted) return
    signal.aborted = true
    signal.reason = reason === undefined ? new Error('This operation was aborted') : reason
    signal.onabort?.()
    signal.listeners.forEach((listener) => listener())
  }
}

/** 缺 AbortController 时补上（已有就不动，开发者工具和新版本引擎走原生的）。 */
export function installRuntimePolyfills(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
) {
  if (typeof scope.AbortController === 'undefined') scope.AbortController = AbortController
}

installRuntimePolyfills()
