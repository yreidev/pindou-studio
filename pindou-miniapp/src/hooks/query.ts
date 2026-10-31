import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCustomer } from './customer'
import { isCancelled } from '../services/customer'
import { coalesce, connectEvents } from '../services/events'
import { identityOf, refreshAll, refreshQueries } from '../services/query'

export { keepPreviousData }

/**
 * 页面是否在显示：跳到别的页、切 Tab、退到后台时为 false。
 * 不显示的页面查询停用（不重读、不定时刷新、不连实时事件），再显示时过期的查询立即重读。
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(true)
  useDidShow(() => setVisible(true))
  useDidHide(() => setVisible(false))
  return visible
}

export type QueryOptions = {
  /** 另外的前提，比如选中了某位会员才读；为 false 时既不读也不算「加载中」。 */
  enabled?: boolean
  /** 前台定时重读的间隔；页面不显示时自动停止。 */
  refetchInterval?: number | false
  /** 换键（翻页、换关键字）时先显示上一个键的内容，新结果回来再换。 */
  placeholderData?: typeof keepPreviousData
  /** 读一次就够：键不变就不再重读（实时事件、切回页面都不读）。只给纯展示、几乎不变的内容。 */
  once?: boolean
}

export type Resource<T> = {
  /** 当前身份能看的数据；没读到、无权（401/403/404）或身份不对时为 null。 */
  data: T | null
  /** 还没有可显示的内容、正在读（或等页面显示后读）。已有内容时刷新是静默的，不置这个。 */
  loading: boolean
  /** 最近一次读取失败的原因；有 data 时表示「刷新失败，显示的是上次的内容」。 */
  error: unknown
  /** 最近一次成功读取的时间。 */
  updatedAt?: number
  /** 显示的是上一个键的内容（placeholderData），新结果还没回来。 */
  placeholder: boolean
}

type Kind = 'staff' | 'customer' | 'public'

function useScopedQuery<T>(kind: Kind, key: readonly unknown[], load: () => Promise<T>, options: QueryOptions) {
  const auth = useCustomer()
  const visible = usePageVisible()
  const client = useQueryClient()
  // 员工资源要有员工角色，顾客资源要登录，公开资源谁都能读。权限仍以后端为准，这里只是不发注定被拒的请求。
  const allowed =
    kind === 'public' || (auth.status === 'authenticated' && (kind === 'customer' || !!auth.account?.roles?.length))
  const wanted = options.enabled !== false
  const queryKey = kind === 'public' ? ['public', ...key] : [kind, identityOf(auth, kind), ...key]
  const query = useQuery({
    queryKey,
    queryFn: () => load(),
    enabled: allowed && visible && wanted,
    refetchInterval: options.refetchInterval ?? false,
    placeholderData: options.placeholderData,
    ...(options.once ? { staleTime: Infinity, meta: { once: true } } : {}),
  })
  const keyRef = useRef(queryKey)
  keyRef.current = queryKey
  const refresh = useCallback(() => refreshQueries(client, { queryKey: keyRef.current, exact: true }), [client])
  const data = allowed && query.data !== undefined ? query.data : null
  const loading = allowed && wanted && data === null && (query.status === 'pending' || query.fetchStatus === 'fetching')
  // 换了身份时，旧身份那边的取消（CustomerError cancelled）不是失败
  const error = allowed && !loading && !isCancelled(query.error) ? query.error : null
  const resource: Resource<T> = {
    data,
    loading,
    error,
    updatedAt: data === null ? undefined : query.dataUpdatedAt || undefined,
    placeholder: query.isPlaceholderData,
  }
  return { ...resource, refresh }
}

/** 员工资源：只给有员工角色的身份读；身份或角色一变，旧内容立即不再显示。 */
export function useStaffQuery<T>(key: readonly unknown[], load: () => Promise<T>, options: QueryOptions = {}) {
  const { refresh, ...resource } = useScopedQuery('staff', key, load, options)
  // 员工页的刷新不等结果（刷新按钮、写操作之后），读完由查询自己更新页面
  const refreshNow = useCallback(() => void refresh(), [refresh])
  return { ...resource, refresh: refreshNow }
}

/** 公开资源（门店已发布的活动等）：不分身份，没登录也能读。 */
export function usePublicQuery<T>(key: readonly unknown[], load: () => Promise<T>, options: QueryOptions = {}) {
  const { refresh, ...resource } = useScopedQuery('public', key, load, options)
  const refreshNow = useCallback(() => void refresh(), [refresh])
  return { ...resource, refresh: refreshNow }
}

/**
 * 顾客本人的数据：登录后读取，回到页面、下拉时重读。
 *
 * live 打开时，页面显示期间连着事件流：员工收款、确认预约、开台入座、充值这类改到本人数据的操作
 * 一提交就重读，不用等顾客自己下拉。只收本人的事件（后端过滤）；离开页面就断开，回来时重读补上。
 * 只给订单、订单详情、我的预约、本次手作、会员中心这几页打开——微信同时最多 5 条 socket。
 */
export function useCustomerQuery<T>(
  key: readonly unknown[],
  load: () => Promise<T>,
  options: QueryOptions & { live?: boolean } = {},
) {
  const resource = useScopedQuery('customer', key, load, options)
  useCustomerEvents(options.live === true)
  usePullDownRefresh(() => {
    void resource.refresh().finally(() => Taro.stopPullDownRefresh())
  })
  return resource
}

function useCustomerEvents(live: boolean) {
  const auth = useCustomer()
  const visible = usePageVisible()
  const client = useQueryClient()
  useEffect(() => {
    if (!live || !visible || auth.status !== 'authenticated') return
    // 连上（含重连）时也会回调一次：断线期间可能漏了事件，整体重读补上。
    // 一串事件合并成一次重读（员工收款会同时改订单和会员资产，各推一条）。
    const merged = coalesce(() => void refreshAll(client))
    const disconnect = connectEvents(merged.call)
    return () => {
      disconnect()
      merged.cancel()
    }
  }, [live, visible, auth.status, auth.account?.id, auth.account?.developerMode, auth.revision, client])
}

/**
 * 员工页的实时连接：页面显示期间连着事件流，事件到达、连上或重连时让显示中的查询重读。
 * pollMs 给随时间变化的状态兜底（计时倒计时、申请过期）：实时连接在线时 30 秒一次，断线时按页面给的间隔。
 * 返回的 refetchInterval 交给本页的查询；页面不显示时查询停用，定时刷新随之停止。
 */
export function useStaffEvents(pollMs = 0) {
  const auth = useCustomer()
  const visible = usePageVisible()
  const client = useQueryClient()
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const roleKey = auth.account?.roles?.join(',') || ''
  useEffect(() => {
    if (!visible || auth.status !== 'authenticated' || !roleKey) return
    // 一串事件合并成一次重读（收款会同时改订单、库存、会员，各推一条）
    const merged = coalesce(() => void refreshAll(client))
    const disconnect = connectEvents(merged.call, setConnection)
    return () => {
      disconnect()
      merged.cancel()
    }
  }, [visible, auth.status, auth.account?.id, roleKey, client])
  const online = connection === 'connected'
  return {
    connection,
    polling: pollMs > 0,
    refetchInterval: pollMs > 0 ? (online ? Math.max(pollMs, 30000) : pollMs) : (false as const),
  }
}

/** 写操作成功后、或用户点「刷新」：让当前显示的全部查询重读（不显示的页面回来时再读）。 */
export function useRefreshAll() {
  const client = useQueryClient()
  return useCallback(() => refreshAll(client), [client])
}
