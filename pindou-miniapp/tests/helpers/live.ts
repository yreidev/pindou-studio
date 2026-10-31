import { act } from 'react-test-renderer'
import { pageEvents } from './render'

// 真渲染数据层用例共用的替身：页面显示与隐藏、登录身份、实时连接、小程序的应用与网络事件。
// 用法（在测试文件顶部，vi.mock 会被提到 import 之前）：
//   vi.mock('@tarojs/taro', async () => (await import('./helpers/live')).taroModule)
//   vi.mock('../src/services/platform', async () => (await import('./helpers/live')).platformModule)
//   vi.mock('../src/services/events', async () => (await import('./helpers/live')).eventsModule)
// 用例里 import { page, session, events, app } from './helpers/live' 拿到同一份。

/** 当前页面的 onShow / onHide。 */
export const page = pageEvents()

type Account = { id: string; nickname?: string; roles: string[]; developerMode?: string }
type Auth = { status: string; account: Account | null; error: string; revision: number }

const signedIn = (roles: string[] = ['clerk'], id = 'employee'): Auth => ({
  status: 'authenticated',
  account: { id, nickname: '员工', roles },
  error: '',
  revision: 1,
})

/** 登录身份（services/platform 的 customer 替身）：useCustomer 订阅它。 */
export const session = (() => {
  let state: Auth = signedIn()
  const listeners = new Set<() => void>()
  const publish = (next: Auth) => {
    state = next
    act(() => listeners.forEach((listener) => listener()))
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reset(roles: string[] = ['clerk']) {
      state = signedIn(roles)
    },
    signIn(roles: string[] = ['clerk'], id = 'employee') {
      publish({ ...signedIn(roles, id), revision: state.revision + 1 })
    },
    /** 资料刷新带回新的角色：同一次会话（revision 不变）。 */
    changeRole(role: string) {
      publish({ ...state, account: { ...(state.account as Account), roles: [role] } })
    },
    signOut() {
      publish({ status: 'anonymous', account: null, error: '', revision: state.revision + 1 })
    },
  }
})()

export const platformModule = { customer: session }

type Connection = {
  onUpdate: () => void
  onConnection?: (state: 'connecting' | 'connected' | 'reconnecting') => void
  closed: boolean
}

/** 实时连接（services/events 的替身）：记下每条连接，用例替服务端推事件、改连接状态。 */
export const events = (() => {
  const connections: Connection[] = []
  return {
    connections,
    /** 还开着的连接。 */
    open: () => connections.filter((connection) => !connection.closed),
    reset() {
      connections.length = 0
    },
    /** 服务端推一条「资源已更新」给所有开着的连接。 */
    push() {
      act(() => connections.filter((c) => !c.closed).forEach((connection) => connection.onUpdate()))
    },
    state(value: 'connecting' | 'connected' | 'reconnecting') {
      act(() => connections.filter((c) => !c.closed).forEach((connection) => connection.onConnection?.(value)))
    },
  }
})()

export const eventsModule = {
  connectEvents(onUpdate: () => void, onConnection?: Connection['onConnection']) {
    const connection: Connection = { onUpdate, onConnection, closed: false }
    events.connections.push(connection)
    return () => {
      connection.closed = true
    }
  },
  // 合并等待由 staff.test.ts 单独测；这里直接执行，测的是连接与重读
  coalesce: (fn: () => void) => ({ call: fn, cancel() {} }),
}

/** 小程序的应用级事件：前后台切换、网络变化。 */
export const app = (() => {
  const listeners = {
    show: new Set<() => void>(),
    hide: new Set<() => void>(),
    network: new Set<(result: { isConnected: boolean }) => void>(),
  }
  return {
    listeners,
    networkType: 'wifi',
    show: () => act(() => listeners.show.forEach((fn) => fn())),
    hide: () => act(() => listeners.hide.forEach((fn) => fn())),
    network: (isConnected: boolean) => act(() => listeners.network.forEach((fn) => fn({ isConnected }))),
  }
})()

export const taroModule = {
  default: {
    stopPullDownRefresh() {},
    onAppShow: (fn: () => void) => app.listeners.show.add(fn),
    offAppShow: (fn: () => void) => app.listeners.show.delete(fn),
    onAppHide: (fn: () => void) => app.listeners.hide.add(fn),
    offAppHide: (fn: () => void) => app.listeners.hide.delete(fn),
    onNetworkStatusChange: (fn: (result: { isConnected: boolean }) => void) => app.listeners.network.add(fn),
    offNetworkStatusChange: (fn: (result: { isConnected: boolean }) => void) => app.listeners.network.delete(fn),
    getNetworkType: async () => ({ networkType: app.networkType }),
    getStorageSync: () => undefined,
  },
  useDidShow: page.useDidShow,
  useDidHide: page.useDidHide,
  usePullDownRefresh: () => {},
  useRouter: () => ({ path: '', params: {} }),
}
