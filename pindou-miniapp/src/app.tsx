// 必须是第一行：后面的模块用到 AbortController 之前要先补上（见 polyfills/runtime.ts）
import './polyfills/runtime'
import Taro from '@tarojs/taro'
import { useEffect, useSyncExternalStore, type PropsWithChildren } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { customer } from './services/platform'
import { connectAppLifecycle, forgetOtherIdentities, queryClient } from './services/query'
import { reportMiniappVersion } from './services/miniapp-version'

import './app.scss'

// 前后台切换、网络恢复接到 Taro 的应用事件上（services/query.ts）
connectAppLifecycle()
// 身份变了：上一个身份读到的内容从缓存里删掉
customer.subscribe(() => forgetOtherIdentities(queryClient, customer.getSnapshot()))

export default function App({ children }: PropsWithChildren) {
  const auth = useSyncExternalStore(customer.subscribe, customer.getSnapshot)
  const accountId = auth.account?.id
  const employee =
    auth.status === 'authenticated' &&
    auth.account?.roles.some((role) => ['clerk', 'manager', 'owner'].includes(role)) === true
  useEffect(() => {
    void customer.bootstrap()
  }, [])
  useEffect(() => {
    if (!employee) return
    const report = () => {
      void reportMiniappVersion().catch((error: unknown) => {
        console.error('上报小程序正式版运行版本失败', error)
      })
    }
    report()
    Taro.onAppShow(report)
    return () => Taro.offAppShow(report)
  }, [accountId, employee])
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
