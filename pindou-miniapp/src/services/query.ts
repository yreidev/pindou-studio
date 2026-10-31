import {
  QueryCache,
  QueryClient,
  environmentManager,
  focusManager,
  onlineManager,
  type Query,
  type QueryFilters,
} from '@tanstack/react-query'
import Taro from '@tarojs/taro'
import { CustomerError, type AuthState } from './customer'
import { StaffError } from './staff'

// 读接口数据统一交给 TanStack Query：页面只声明「读什么」（查询键 + 读取函数），什么时候重读由这里定。
//
// ★ 金额、库存、状态只以接口为准：不做乐观更新，不往本机存。写操作仍走 services 里的请求函数
//   （幂等键、不确定结果用同一个键重试的逻辑都在那里），成功后调 refreshQueries 让查询重读。
// ★ 重读的时机：页面显示时（hooks/query.ts 按页面显示与否开关查询）、实时事件到达或重连时
//   （refreshQueries）、前台定时（refetchInterval，只在页面显示时跑）、回到前台与网络恢复时
//   （下面接到 Taro 的应用事件上；小程序里没有 window/document 的 visibilitychange、online 事件）。

/** 无权、未登录、不存在：这类失败不能留着上次读到的内容；其余失败（断网、超时、5xx）保留并提示。 */
export const isRestricted = (error: unknown) =>
  (error instanceof StaffError || error instanceof CustomerError) && [401, 403, 404].includes(error.status)

// 刷新时正在读的查询：那次请求可能是在数据变化之前发出的，结束后要再读一次。
const again = new WeakSet<Query<any, any, any, any>>()

export function createQueryClient() {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isRestricted(error)) query.setState({ data: undefined, dataUpdatedAt: 0 })
      },
    }),
    defaultOptions: {
      queries: {
        // 失败不自动重试：错误要马上让人看见（显示上次内容并提示），实时事件、定时刷新和手动重试会再读。
        retry: false,
        // 离线时照样发请求、照样报「网络连接失败」，不让查询静默暂停：读取失败的提示是现有规则。
        networkMode: 'always',
        // 网络恢复时显示中的查询重读。networkMode 为 always 时这一项默认是关的，要显式打开。
        refetchOnReconnect: true,
      },
    },
  })
  client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !again.has(event.query)) return
    if (event.action.type !== 'success' && event.action.type !== 'error') return
    again.delete(event.query)
    const { queryKey } = event.query
    setTimeout(() => {
      void client.refetchQueries({ queryKey, exact: true, type: 'active' }, { cancelRefetch: false })
    }, 0)
  })
  return client
}

export const queryClient = createQueryClient()

/**
 * 数据变了（写操作成功、手动刷新）：让查询过期，正在显示的立刻重读。
 *
 * ★ 正在读的那次不打断、不并发再发一次（网络慢时超时 15 秒，事件、轮询、切回页面叠在一起会同时
 *   压上好几批请求），只记下「还要再读」，它结束后补读一次 —— 它可能是在这次变化之前发出的。
 * ★ 页面不显示时查询是停用的，这里只标记过期，等页面再显示时重读。
 */
export function refreshQueries(client: QueryClient, filters: QueryFilters = {}) {
  for (const query of client.getQueryCache().findAll(filters))
    if (query.state.fetchStatus === 'fetching') again.add(query)
  return client.invalidateQueries(filters, { cancelRefetch: false })
}

/** 实时事件、写操作之后：全部查询重读，只读一次就够的（once）除外。 */
export function refreshAll(client: QueryClient) {
  return refreshQueries(client, { predicate: (query) => query.meta?.once !== true })
}

/**
 * 查询键的身份段：身份变了（登录、退出、开发者切换体验身份、角色变了）就是另一组查询，
 * 上一个身份读到的内容一律不再显示，迟到的响应也只会落到旧键上。
 * 员工查询带上角色；顾客查询不带（资料刷新时角色变了不必重读本人订单）。
 */
export function identityOf(auth: AuthState, kind: 'staff' | 'customer') {
  const base = `${auth.status}:${auth.account?.id || ''}:${auth.account?.developerMode || ''}:${auth.revision}`
  return kind === 'staff' ? `${base}:${auth.account?.roles?.join(',') || ''}` : base
}

/** 身份变了：把其他身份的查询连同数据一起删掉，不等它们自然过期。 */
export function forgetOtherIdentities(client: QueryClient, auth: AuthState) {
  // 等页面按新身份重新渲染、换到新键之后再删，避免还挂着的旧查询被删后又按旧键读一次
  setTimeout(() => {
    client.removeQueries({
      predicate: (query) => {
        const [kind, identity] = query.queryKey
        return (kind === 'staff' || kind === 'customer') && identity !== identityOf(auth, kind)
      },
    })
  }, 0)
}

/**
 * 接到 Taro 的应用与网络事件上。默认实现监听 window 的 visibilitychange / online，小程序里没有。
 *
 * - 回到前台：TanStack Query 让显示中的、已过期的查询重读；切到后台：定时刷新暂停。
 * - 网络恢复：显示中的查询重读。
 * 页面级的显示与隐藏（跳到别的页、切 Tab）在 hooks/query.ts 里按页面开关查询。
 */
export function connectAppLifecycle() {
  // 小程序是客户端：不按「有没有 window」猜（Taro 注入的 window 不是浏览器的那个）
  environmentManager.setIsServer(() => false)
  focusManager.setEventListener((setFocused) => {
    const show = () => setFocused(true)
    const hide = () => setFocused(false)
    Taro.onAppShow(show)
    Taro.onAppHide(hide)
    return () => {
      Taro.offAppShow(show)
      Taro.offAppHide(hide)
    }
  })
  onlineManager.setEventListener((setOnline) => {
    const change = (result: { isConnected: boolean }) => setOnline(result.isConnected)
    Taro.onNetworkStatusChange(change)
    Taro.getNetworkType()
      .then((result) => setOnline(result.networkType !== 'none'))
      .catch(() => {
        /* 读不到网络状态就按在线处理（默认值） */
      })
    return () => Taro.offNetworkStatusChange(change)
  })
}
