import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadSession } from '../session'
import { eventStreamUrl, RealtimeConnection, type RealtimeStatus } from './connection'
import { refreshAfterRealtime } from './refresh'
import { receiveScan } from './scans'

interface RealtimeState {
  status: RealtimeStatus
  /** 最近一次连上的时间，顶栏显示「实时 · 已连接」用。 */
  connectedAt: Date | null
}

const RealtimeContext = createContext<RealtimeState>({ status: 'closed', connectedAt: null })

export function useRealtime(): RealtimeState {
  return useContext(RealtimeContext)
}

/**
 * 登录后挂在后台布局上。收到任何「资源已更新」都让全部查询过期：只有当前页面正在用的会立刻重读，
 * 其余等用到时再读。网页同一时间只开一页、数据量小，这样不用维护「收款也会改库存、会员余额」这类
 * 资源之间的牵连表，不会漏刷。一串事件由 RealtimeConnection 合并成一次。
 * 连上或切回标签页时同样整体重读，补上断线期间漏掉的事件（第一次连上也重读：页面先读数据、后建连接，
 * 中间那一小段别人改的东西只有这样才补得上）。
 * 标签页在后台时只标记过期、不重读，切回来再读；只有 meta.realtimeInBackground 的查询（呼叫店员）在后台也随
 * 自己的资源事件立刻重读。meta.realtime 为 false 的查询（只算不写的计算示例）不随事件重读。规则见 refresh.ts。
 * queryKey 第一段仍按后端资源名起（例如 ['sales-orders', ...]），便于调试面板里辨认，后台重读也按它认资源。
 */
export function RealtimeProvider({
  children,
  beforeReconnect,
}: {
  children: ReactNode
  /** 重连前确认会话仍有效（见 RealtimeOptions.beforeReconnect）。 */
  beforeReconnect?: () => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<RealtimeState>({ status: 'connecting', connectedAt: null })
  // 放进 ref：回调换了不用重建连接
  const verify = useRef(beforeReconnect)
  useEffect(() => {
    verify.current = beforeReconnect
  }, [beforeReconnect])

  useEffect(() => {
    const refresh = (resources: readonly string[] | null) =>
      refreshAfterRealtime(queryClient, { resources, visible: document.visibilityState === 'visible' })
    const connection = new RealtimeConnection({
      url: eventStreamUrl(window.location),
      token: () => loadSession()?.accessToken ?? null,
      onResources: refresh,
      // 本人手机转来的码交给当前页面（收货入库、结账、会员资产、选顾客），没人认领就在右下角提示
      onScan: receiveScan,
      onConnected: () => {
        setState({ status: 'open', connectedAt: new Date() })
        refresh(null)
      },
      onStatus: (status) => setState((previous) => ({ ...previous, status })),
      beforeReconnect: () => verify.current?.() ?? Promise.resolve(),
    })
    connection.start()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(null)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      connection.stop()
    }
  }, [queryClient])

  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>
}
