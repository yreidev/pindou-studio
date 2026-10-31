import assert from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { test } from 'vitest'
import { AbortController as MiniAbortController, installRuntimePolyfills } from '../src/polyfills/runtime'

// 真机的逻辑层没有 AbortController，而 TanStack Query 每次读取都 new 一个。启动时补上之后，
// 一次真实的读取要能走通、中止要能通知到监听者。（开发者工具里本来就有，测不出来，所以在这里模拟没有的情形。）
test('没有 AbortController 的运行环境：启动时补上，TanStack Query 的读取照常完成', async () => {
  const scope: Record<string, unknown> = {}
  installRuntimePolyfills(scope)
  assert.equal(scope.AbortController, MiniAbortController)

  const native = globalThis.AbortController
  try {
    // 让 TanStack 只能用补上的那个
    ;(globalThis as Record<string, unknown>).AbortController = undefined
    installRuntimePolyfills()
    assert.equal(globalThis.AbortController, MiniAbortController)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let signal: AbortSignal | undefined
    const data = await client.fetchQuery({
      queryKey: ['polyfill'],
      queryFn: (context) => {
        signal = context.signal
        return Promise.resolve('读到了')
      },
    })
    assert.equal(data, '读到了')
    assert.equal(signal?.aborted, false)
    client.clear()
  } finally {
    ;(globalThis as Record<string, unknown>).AbortController = native
  }

  const controller = new MiniAbortController()
  let heard = 0
  controller.signal.addEventListener('abort', () => heard++)
  controller.abort()
  controller.abort()
  assert.equal(controller.signal.aborted, true)
  assert.equal(heard, 1, '重复中止只通知一次')
})

test('已经有 AbortController 时不替换（开发者工具、新版本引擎用原生的）', () => {
  const native = class {}
  const scope: Record<string, unknown> = { AbortController: native }
  installRuntimePolyfills(scope)
  assert.equal(scope.AbortController, native)
})
