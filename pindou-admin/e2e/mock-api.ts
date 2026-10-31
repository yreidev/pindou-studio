import type { Page, Route, WebSocketRoute } from '@playwright/test'

// 模拟接口：真后端提供页面和 /healthz，/api/v2 由这里接管，用来走完扫码登录、实时同步这些
// 需要员工在手机上操作的流程（批准与领会话的服务端规则由 Go 测试覆盖）。

export interface MockAccount {
  id: string
  nickname: string
  roles: string[]
  phoneVerificationStatus: 'verified'
}

/** 额外的模拟接口：认得这个请求就返回响应，不认得返回 undefined 交给下一个。 */
export type MockHandler = (request: {
  method: string
  path: string
  search: URLSearchParams
  body: unknown
  /** 请求带的 Idempotency-Key（模拟后端按键重放上次的结果时用）。 */
  idempotencyKey?: string
}) => MockResult | undefined | Promise<MockResult | undefined>

/** headers 用来模拟分页总数这类放在响应头里的信息（如订单列表的 X-Total-Count）。 */
export interface MockResult {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface MockApi {
  challenges: number
  claims: number
  accountReads: number
  logouts: number
  sockets: WebSocketRoute[]
  account: MockAccount
  /** 第几次轮询起批准（从 1 数）；0 表示一直等待。 */
  approveOnClaim: number
  /** 每次轮询都回 410（被拒或已用过），用来测二维码换新。 */
  closeEveryChallenge: boolean
  /** 能不能换到小程序码；默认不能（和开发后端一样没配微信），网页退回普通二维码 */
  miniProgramCode: boolean
  /**
   * 系统内收费开没开（GET /system/billing-settings）；默认开着，这样结账、订单、价格的用例照旧。
   * 收费关着时的界面（「结束」放座、不显示价格）另有用例。
   */
  billingEnabled: boolean
  /** 各功能页自己的模拟接口，按顺序匹配。 */
  handlers: MockHandler[]
  /** 收到过的写请求（方法 路径 内容），断言用。 */
  writes: { method: string; path: string; body: unknown; idempotencyKey?: string }[]
}

const json = (route: Route, status: number, body?: unknown, headers?: Record<string, string>) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
  })

export async function mockApi(page: Page, overrides: Partial<MockApi> = {}): Promise<MockApi> {
  const state: MockApi = {
    challenges: 0,
    claims: 0,
    accountReads: 0,
    logouts: 0,
    sockets: [],
    account: { id: 'u-owner', nickname: '阿贝', roles: ['owner'], phoneVerificationStatus: 'verified' },
    approveOnClaim: 2,
    closeEveryChallenge: false,
    miniProgramCode: false,
    billingEnabled: true,
    handlers: [],
    writes: [],
    ...overrides,
  }
  const later = (ms: number) => new Date(Date.now() + ms).toISOString()

  await page.route('**/api/v2/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v2', '')
    const method = request.method()
    const body: unknown = (() => {
      try {
        return request.postDataJSON()
      } catch {
        return undefined
      }
    })()
    const idempotencyKey = request.headers()['idempotency-key']
    if (method !== 'GET' && !path.startsWith('/auth/web-login-challenges'))
      state.writes.push({ method, path, body, idempotencyKey })
    for (const handler of state.handlers) {
      const result = await handler({ method, path, search: url.searchParams, body, idempotencyKey })
      if (!result) continue
      await json(route, result.status, result.body, result.headers)
      // 和真后端一样：写请求成功后向在线的实时连接推一条「资源已更新」。不推的话，
      // 「重读又触发写、写又推事件」这类循环（例如发布确认框里的计算示例）在测试里永远测不出来。
      if (method !== 'GET' && result.status >= 200 && result.status < 300 && !path.startsWith('/auth/'))
        for (const ws of state.sockets)
          ws.send(JSON.stringify({ type: 'resource.updated', resource: path.split('/')[1] }))
      return
    }

    if (method === 'POST' && path === '/auth/web-login-challenges') {
      state.challenges++
      const id = `c${state.challenges}`
      return json(route, 201, {
        id,
        pollToken: `poll-${id}`,
        qrText: `pindou-web-login:${id}`,
        expiresAt: later(180_000),
      })
    }
    const codeFor = path.match(/^\/auth\/web-login-challenges\/([^/]+)\/code$/)
    if (method === 'POST' && codeFor) {
      if ((body as { pollToken?: string } | undefined)?.pollToken !== `poll-${codeFor[1]}`)
        return json(route, 404, { code: 'not_found' })
      if (!state.miniProgramCode)
        return json(route, 503, { code: 'wechat_unavailable', message: '尚未配置微信小程序码服务' })
      // 1×1 的 PNG，够让页面把它当图片显示
      return json(route, 200, {
        imageDataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      })
    }
    const claim = path.match(/^\/auth\/web-login-challenges\/([^/]+)\/session$/)
    if (method === 'POST' && claim) {
      state.claims++
      if ((body as { pollToken?: string } | undefined)?.pollToken !== `poll-${claim[1]}`)
        return json(route, 404, { code: 'not_found' })
      if (state.closeEveryChallenge) return json(route, 410, { code: 'challenge_closed', message: '这次扫码已失效' })
      if (state.approveOnClaim > 0 && state.claims >= state.approveOnClaim) {
        return json(route, 201, { accessToken: 'web-token', expiresAt: later(12 * 3_600_000), user: state.account })
      }
      return json(route, 202, { expiresAt: later(170_000) })
    }
    if (method === 'GET' && path === `/accounts/${state.account.id}`) {
      state.accountReads++
      return json(route, 200, state.account)
    }
    if (method === 'DELETE' && path === '/auth/sessions/current') {
      state.logouts++
      return route.fulfill({ status: 204 })
    }
    // 现场看板的「呼叫店员」面板：功能页自己的模拟接口没接管时，当作没有顾客呼叫
    if (method === 'GET' && path === '/service-calls') return json(route, 200, [])
    // 桌码页读的设置：功能页自己没接管时，小程序码指向体验版、网页桌码印正式域名
    if (method === 'GET' && path === '/system/code-settings')
      return json(route, 200, {
        envVersion: 'trial',
        customerWebsite: 'https://pindou.example.invalid',
        updatedAt: null,
      })
    // 没有手机上报时，首页明确显示尚未收到。
    if (method === 'GET' && path === '/system/miniapp-version') return json(route, 200, { release: null })
    // 系统内收费开关：功能页自己没接管时按 billingEnabled
    if (method === 'GET' && path === '/system/billing-settings')
      return json(route, 200, { enabled: state.billingEnabled, updatedAt: null })
    return json(route, 404, { code: 'not_found', message: `模拟接口未覆盖：${method} ${path}` })
  })

  await page.routeWebSocket('**/api/v2/event-streams', (ws) => {
    state.sockets.push(ws)
  })
  return state
}

/** 直接写入已登录的网页会话，跳过扫码。 */
export async function signIn(page: Page, account: Partial<MockAccount> & { id: string }, token = 'web-token') {
  const session = {
    accessToken: token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { nickname: '阿贝', roles: ['owner'], ...account },
  }
  await page.addInitScript((value) => {
    if (!window.sessionStorage.getItem('e2e-signed-in')) {
      window.localStorage.setItem('pindou-admin.session', value)
      window.sessionStorage.setItem('e2e-signed-in', '1')
    }
  }, JSON.stringify(session))
}
