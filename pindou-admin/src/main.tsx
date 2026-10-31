// Semi 在 React 19 下必须先装适配器，再用任何组件（弹层、Toast 靠它挂载）。
import '@douyinfe/semi-ui/react19-adapter'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError, setUnauthorizedHandler } from './api/client'
import { routeTree } from './routeTree.gen'
import { onSessionChange } from './session'
import './app.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 数据新鲜度靠实时事件和切回标签页时的整体重读，不靠定时轮询或窗口聚焦。
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // 网络抖动重试两次；4xx 是业务结果（无权限、不存在、冲突），重试没有意义。
      retry: (failureCount, error) =>
        failureCount < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
    },
    mutations: { retry: false },
  },
})

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// 会话失效（过期、被小程序「连电脑」里的「全部退出」）：清掉缓存，带着当前地址回登录页。
setUnauthorizedHandler(() => {
  const { pathname, search } = window.location
  // 先离开后台页面再清缓存，否则还挂着的查询会立刻重读一次
  void router
    .navigate({ to: '/login', search: { redirect: pathname + search }, replace: true })
    .then(() => queryClient.clear())
})

// 别的标签页登录或退出：缓存可能属于上一个人，清空后让路由按新会话重新判断。
onSessionChange(() => {
  queryClient.clear()
  void router.invalidate()
})

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
