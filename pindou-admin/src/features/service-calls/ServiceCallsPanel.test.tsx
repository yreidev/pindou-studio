import { Notification, Toast } from '@douyinfe/semi-ui'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServiceCall } from '../../api/service-calls'
import { saveSession } from '../../session'
import { FakeAudioContext } from '../../test/fake-audio'
import { fakeNotificationApi } from '../../test/fake-notification'
import { alertPrefsKey } from './alert-prefs'
import { CallAlertsProvider } from './CallAlerts'
import { Chime } from './chime'
import { ServiceCallsPanel } from './ServiceCallsPanel'

const call = (id: string, tableCode: string, seatNumber: number, nickname: string): ServiceCall => ({
  id,
  venueSessionId: `00000000-0000-4000-8000-00000000000${id.length}`,
  serviceTableId: '00000000-0000-4000-8000-000000000010',
  tableCode,
  seatNumber,
  status: 'pending',
  displayStatus: 'pending',
  createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  handledAt: null,
  cooldownSeconds: 0,
  customer: { id: '00000000-0000-4000-8000-000000000020', nickname, phoneMasked: '138****8000' },
  handledBy: null,
  claimStatus: 'none',
  claimedAt: null,
  claimedBy: null,
})

const me = { id: '00000000-0000-4000-8000-0000000000d1', nickname: '阿贝', phoneMasked: '139****0001' }
const zhou = { id: '00000000-0000-4000-8000-0000000000d2', nickname: '小周', phoneMasked: '139****0002' }

/**
 * 模拟后端：GET 回当前还没处理的呼叫，POST handle 把那一条处理掉；POST claim 记成「阿贝」认领，
 * 已被别人认领着的回 409「XX 已在处理」。
 */
function backend(initial: ServiceCall[]) {
  const state = { open: initial, handled: [] as string[], claims: [] as string[], reads: 0 }
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url)
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (request.method === 'GET' && url.pathname === '/api/v2/service-calls') {
      state.reads++
      return reply(200, state.open)
    }
    const claimed = /^\/api\/v2\/service-calls\/([^/]+)\/claim$/.exec(url.pathname)
    if (request.method === 'POST' && claimed) {
      state.claims.push(claimed[1])
      const target = state.open.find((c) => c.id === claimed[1])
      if (!target) return reply(404, { code: 'not_found', message: '没有', requestId: 'r' })
      if (target.claimStatus === 'claimed' && target.claimedBy?.id !== me.id)
        return reply(409, {
          code: 'service_call_claimed',
          message: `${target.claimedBy?.nickname} 已在处理`,
          requestId: 'r',
        })
      const next: ServiceCall = {
        ...target,
        claimStatus: 'claimed',
        claimedAt: new Date().toISOString(),
        claimedBy: me,
      }
      state.open = state.open.map((c) => (c.id === target.id ? next : c))
      return reply(200, next)
    }
    const handled = /^\/api\/v2\/service-calls\/([^/]+)\/handle$/.exec(url.pathname)
    if (request.method === 'POST' && handled) {
      const target = state.open.find((c) => c.id === handled[1])
      state.open = state.open.filter((c) => c.id !== handled[1])
      state.handled.push(handled[1])
      return reply(200, { ...target, status: 'handled', displayStatus: 'handled', handledAt: new Date().toISOString() })
    }
    return reply(404, { code: 'not_found', message: '没有', requestId: 'r' })
  })
  vi.stubGlobal('fetch', fetch)
  return state
}

/** 挂上面板；给了 alerts 时连全站提醒一起挂（看板页上就是这样：同一个查询两处在用）。 */
function mount(alerts?: { chime: Chime; onOpenBoard?: () => void }) {
  saveSession({
    accessToken: 'web-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'u-owner', nickname: '阿贝', roles: ['owner'] },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      {alerts ? (
        <CallAlertsProvider onBoard onOpenBoard={alerts.onOpenBoard ?? (() => {})} chime={alerts.chime}>
          <ServiceCallsPanel />
        </CallAlertsProvider>
      ) : (
        <ServiceCallsPanel />
      )}
    </QueryClientProvider>,
  )
  return queryClient
}

/** 改标签页可见与否（jsdom 里永远是 visible），并像浏览器一样派发 visibilitychange。 */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  // 删掉实例上的覆盖，回到 jsdom 原来的 visible
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('呼叫店员面板', () => {
  it('列出没处理的呼叫：桌位、座号、顾客、叫了多久；点已处理后按接口重读', async () => {
    const state = backend([call('a', 'B3', 2, '小林')])
    mount()
    expect(await screen.findByText('B3 桌 · 2 号座')).toBeTruthy()
    expect(screen.getByText('小林 · 3 分钟前')).toBeTruthy()
    // 标题是 6 级标题（读屏能按标题跳过来），没处理的个数用徽标
    expect(screen.getByRole('heading', { name: '呼叫店员', level: 6 })).toBeTruthy()
    expect(document.querySelector('.service-calls-panel .semi-badge-count')?.textContent).toBe('1')
    // 不在全站提醒里面时没有「提醒设置」入口
    expect(screen.queryByRole('button', { name: '提醒设置' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'B3 桌 · 2 号座 已处理' }))
    await waitFor(() => expect(state.handled).toEqual(['a']))
    expect(await screen.findByText('暂时没有顾客呼叫')).toBeTruthy()
  })

  it('「我去处理」：认领后写谁在处理、只留「已处理」；别人先认领了提示「XX 已在处理」；认领满 10 分钟没处理的重新给「我去处理」', async () => {
    const warning = vi.spyOn(Toast, 'warning')
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const state = backend([
      call('a', 'B3', 2, '小林'),
      { ...call('bb', 'C1', 1, '阿青'), claimStatus: 'claimed', claimedAt: minutesAgo(2), claimedBy: zhou },
      { ...call('ccc', 'E2', 1, '小何'), claimStatus: 'lapsed', claimedAt: minutesAgo(12), claimedBy: zhou },
    ])
    mount()
    expect(await screen.findByText('B3 桌 · 2 号座')).toBeTruthy()

    // 别人认领着的：写「小周 正在处理 · 2 分钟前」，没有「我去处理」，「已处理」照旧能点
    expect(screen.getByText('小周 正在处理 · 2 分钟前')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'C1 桌 · 1 号座 我去处理' })).toBeNull()
    expect(screen.getByRole('button', { name: 'C1 桌 · 1 号座 已处理' })).toBeTruthy()
    // 认领满 10 分钟还没处理：写出来，谁都能再认领
    expect(screen.getByText('小周 12 分钟前说去处理，还没处理')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'E2 桌 · 1 号座 我去处理' })).toBeTruthy()

    // 我去 B3：按接口重读后写我在处理，「我去处理」收起
    await userEvent.click(screen.getByRole('button', { name: 'B3 桌 · 2 号座 我去处理' }))
    expect(await screen.findByText('阿贝 正在处理 · 刚刚')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'B3 桌 · 2 号座 我去处理' })).toBeNull()
    expect(state.claims).toEqual(['a'])

    // 手里的列表还是旧的、小周其实已经接了 E2：后端拒绝，提示是谁在处理，列表随后重读
    state.open = state.open.map((c) =>
      c.id === 'ccc' ? { ...c, claimStatus: 'claimed', claimedAt: minutesAgo(0), claimedBy: zhou } : c,
    )
    await userEvent.click(screen.getByRole('button', { name: 'E2 桌 · 1 号座 我去处理' }))
    await waitFor(() => expect(warning).toHaveBeenCalledWith('小周 已在处理'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'E2 桌 · 1 号座 我去处理' })).toBeNull())
    expect(screen.getByText('小周 正在处理 · 刚刚')).toBeTruthy()
  })
})

describe('全站呼叫提醒（看板页上和面板同时在）', () => {
  it('提示音默认开、第一次点页面后才出声；新呼叫只响一次、提示一次；后台时弹系统通知、标题闪', async () => {
    // 右上角提示由 Semi 另起一棵 React 树渲染（要 react19-adapter），这里只核对弹了什么
    const inPage = vi.spyOn(Notification, 'warning').mockReturnValue('service-call-alert')
    vi.spyOn(Notification, 'close').mockReturnValue('service-call-alert')
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const system = fakeNotificationApi('granted')
    vi.stubGlobal('Notification', system.api)
    const audio = new FakeAudioContext()
    const openBoard = vi.fn()
    const state = backend([call('a', 'B3', 2, '小林')])
    const queryClient = mount({ chime: new Chime(() => audio as unknown as AudioContext), onOpenBoard: openBoard })

    await screen.findByText('B3 桌 · 2 号座')
    // 打开时已挂着的不算新到
    expect(inPage).not.toHaveBeenCalled()
    expect(audio.starts).toBe(0)
    // 还没点过页面：顶部挂着提示，点一下任意处就开启
    expect(screen.getByText('点一下页面任意处开启提示音')).toBeTruthy()
    await userEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText('点一下页面任意处开启提示音')).toBeNull())
    expect(audio.starts).toBe(0)

    // 实时事件到达（RealtimeProvider 让查询过期重读）：多了一条。面板和全站提醒用同一个查询，只响一次（两声）
    state.open = [...state.open, call('bb', 'C1', 1, '阿青')]
    await act(() => queryClient.invalidateQueries())
    expect(await screen.findByText('C1 桌 · 1 号座')).toBeTruthy()
    await waitFor(() => expect(audio.starts).toBe(2))
    expect(inPage).toHaveBeenCalledTimes(1)
    expect(inPage).toHaveBeenCalledWith(expect.objectContaining({ title: 'C1 桌 · 1 号座 呼叫店员' }))
    // 人正看着页面：不弹系统通知
    expect(system.shown).toHaveLength(0)

    // 切到别的标签页：来了新呼叫要弹系统通知、标题闪「(1) 新呼叫」
    const baseTitle = '示例工坊后台'
    document.title = baseTitle
    setVisibility('hidden')
    state.open = [...state.open, call('ccc', 'E2', 1, '小周')]
    await act(() => queryClient.invalidateQueries())
    await waitFor(() => expect(system.shown).toHaveLength(1))
    expect(system.shown[0].title).toBe('E2 桌 · 1 号座 呼叫店员')
    expect(system.shown[0].options).toMatchObject({ tag: 'ccc', body: '顾客：小周。点这里打开「现场」处理' })
    expect(document.title).toBe(`(1) 新呼叫 · ${baseTitle}`)
    expect(audio.starts).toBe(4)

    // 点系统通知：回到这个页面并去「现场」
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    system.shown[0].click()
    expect(focus).toHaveBeenCalled()
    expect(openBoard).toHaveBeenCalledTimes(1)

    // 切回来：标题恢复
    setVisibility('visible')
    expect(document.title).toBe(baseTitle)

    // 这条被处理了（手机上点的也一样）：系统通知跟着关掉
    state.open = state.open.filter((c) => c.id !== 'ccc')
    await act(() => queryClient.invalidateQueries())
    await waitFor(() => expect(system.shown[0].closed).toBe(true))
  })

  it('提醒设置：从面板头部打开，关掉提示音后新呼叫不响，设置按浏览器存下来', async () => {
    vi.spyOn(Notification, 'warning').mockReturnValue('service-call-alert')
    vi.spyOn(Notification, 'close').mockReturnValue('service-call-alert')
    const system = fakeNotificationApi('default')
    vi.stubGlobal('Notification', system.api)
    const audio = new FakeAudioContext()
    const state = backend([])
    const queryClient = mount({ chime: new Chime(() => audio as unknown as AudioContext) })
    await screen.findByText('暂时没有顾客呼叫')

    await userEvent.click(screen.getByRole('button', { name: '提醒设置' }))
    const sound = await screen.findByRole('switch', { name: '提示音' })
    expect(sound.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('这些设置只对这台电脑的这个浏览器有效', { exact: false })).toBeTruthy()

    // 系统通知还没授权：点「开启系统通知」才向浏览器请求
    expect(system.requests.count).toBe(0)
    await userEvent.click(screen.getByRole('button', { name: '开启系统通知' }))
    await waitFor(() => expect(system.requests.count).toBe(1))
    expect(await screen.findByText('浏览器已允许')).toBeTruthy()

    // 试听：唤醒声音并响一次
    await userEvent.click(screen.getByRole('button', { name: '试听' }))
    await waitFor(() => expect(audio.starts).toBe(2))

    await userEvent.click(sound)
    expect(JSON.parse(window.localStorage.getItem(alertPrefsKey) ?? '{}')).toMatchObject({ sound: false, notify: true })

    state.open = [call('a', 'B3', 2, '小林')]
    await act(() => queryClient.invalidateQueries())
    expect(await screen.findByText('B3 桌 · 2 号座')).toBeTruthy()
    expect(audio.starts).toBe(2)
  })
})
