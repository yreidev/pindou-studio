import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createElement, useEffect, useRef } from 'react'
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer'

// 真渲染 hook：用 React 本身（react-test-renderer，不要 DOM）跑查询，验证的是实际的重读时机，
// 不是对着手写的 React 替身。

/** 把若干轮定时器（TanStack Query 的通知、React 的调度）和微任务跑完。 */
export async function flush(rounds = 5) {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const mounted = new Set<ReactTestRenderer>()

/** 卸掉本条用例渲染的全部组件（放在 afterEach 里），不让它们接着响应下一条用例的事件。 */
export function cleanup() {
  act(() => mounted.forEach((renderer) => renderer.unmount()))
  mounted.clear()
}

export function renderHook<P, T>(hook: (props: P) => T, client: QueryClient, initial: P) {
  const result = { current: undefined as T }
  function Probe({ props }: { props: P }) {
    result.current = hook(props)
    return null
  }
  const tree = (props: P) => createElement(QueryClientProvider, { client }, createElement(Probe, { props }))
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = TestRenderer.create(tree(initial))
  })
  mounted.add(renderer!)
  return {
    result,
    rerender(props: P) {
      act(() => renderer!.update(tree(props)))
    },
    unmount() {
      act(() => renderer!.unmount())
      mounted.delete(renderer!)
    },
  }
}

/**
 * 页面显示与隐藏：替身里的 useDidShow / useDidHide 把回调登记到这里，用例调用 show()/hide()
 * 就像微信触发页面的 onShow / onHide。
 */
export function pageEvents() {
  const shows = new Set<() => void>()
  const hides = new Set<() => void>()
  const register = (set: Set<() => void>) => (fn: () => void) => {
    const latest = useRef(fn)
    latest.current = fn
    useEffect(() => {
      const callback = () => latest.current()
      set.add(callback)
      return () => {
        set.delete(callback)
      }
    }, [])
  }
  return {
    useDidShow: register(shows),
    useDidHide: register(hides),
    show: () => act(() => shows.forEach((fn) => fn())),
    hide: () => act(() => hides.forEach((fn) => fn())),
  }
}
