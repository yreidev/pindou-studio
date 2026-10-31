import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet, useNavigate } from '@tanstack/react-router'
import { Empty, Button } from '@douyinfe/semi-ui'
import { lazy, Suspense } from 'react'

export interface RouterContext {
  queryClient: QueryClient
}

// 调试面板只在开发时加载，不进生产包。
const Devtools = import.meta.env.DEV
  ? lazy(async () => {
      const [{ TanStackRouterDevtools }, { ReactQueryDevtools }] = await Promise.all([
        import('@tanstack/react-router-devtools'),
        import('@tanstack/react-query-devtools'),
      ])
      return {
        default: () => (
          <>
            <TanStackRouterDevtools position="bottom-right" />
            <ReactQueryDevtools buttonPosition="bottom-left" />
          </>
        ),
      }
    })
  : () => null

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <>
      <Outlet />
      <Suspense>
        <Devtools />
      </Suspense>
    </>
  ),
  notFoundComponent: NotFound,
})

function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="page-center">
      <Empty title="没有这个页面" description="地址可能写错了，或者这个功能还没搬到网页后台。">
        <Button onClick={() => void navigate({ to: '/' })}>回到首页</Button>
      </Empty>
    </div>
  )
}
