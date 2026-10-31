import createClient, { type Middleware } from 'openapi-fetch'
import { clearSession, loadSession } from '../session'
import type { components, paths } from './schema'

// 接口客户端：openapi-fetch 按契约（docs/api.yaml，经 `pnpm api:types` 生成 schema.d.ts）检查路径、参数、
// 请求体和响应类型。会话令牌、错误中文化放在下面的中间件里，幂等键由 idempotentFetch 挑，语义照搬小程序
// services/staff.ts —— 结果未知的写请求先原样重试、确认上次生效没有，版本冲突（409）交给调用方重读后让人
// 再确认，绝不自动换版本重提。

/** 契约里的数据结构（components.schemas）。各模块按需起别名，不再手写接口类型。 */
export type Schemas = components['schemas']

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

let unauthorizedHandler: (() => void) | null = null

/** 登录失效（401）时的处理：清掉本地会话后交给路由跳回登录页。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/**
 * 资金、库存、人工折扣等写请求的幂等键请求头。契约要求 Idempotency-Key 的接口，类型会逼着调用方带上它：
 * `params: { header: idempotencyKey() }`。这里给的是一个新键，真正用哪个由 idempotentFetch 决定：
 * 同一个动作上次没拿到明确结果（断网、5xx）时，内容一样就沿用上次的键（后端只执行一次）；内容变了
 * （页面重读后版本号、当前库存变了）先把上次那一条原样重发，弄清它生效没有，再决定这一次。
 */
export function idempotencyKey(): { 'Idempotency-Key': string } {
  return { 'Idempotency-Key': newIdempotencyKey() }
}

/** 不带会话令牌的接口：契约里 `security: []` 的扫码登录与健康检查。 */
const anonymousPaths = new Set<keyof paths>([
  '/healthz',
  '/auth/web-login-challenges',
  '/auth/web-login-challenges/{challengeId}/session',
  '/auth/web-login-challenges/{challengeId}/code',
])

/**
 * 结果未知（断网、5xx）的写请求，按「同一个动作」记下原请求体和原幂等键。
 *
 * ★ 以前按「人 + 方法 + 地址 + 内容」复用键。请求体里带着版本号或当前库存，结果未知后页面一重读
 *   （实时事件、失败后的重读），版本就变了，再点同一个按钮内容不同、换了新键，后端当成新操作再执行一次：
 *   看板续时扣两次、9 折打两次成 81 折。现在同一个动作先把上次那一条原样重发，弄清它到底生效没有：
 *   成功（后端重放出上次的结果，或这才执行）就回 409 previous_applied 告诉员工「上次已生效」、不提交这一次；
 *   4xx 说明上次确实没生效，接着提交这一次；仍然未知就保留，等下次再试。和小程序 services/staff.ts 一致。
 */
interface Unconfirmed {
  body: string
  key: string
}
const unconfirmed = new Map<string, Unconfirmed>()

/** 只算不写的会员动作（结账报价、退款预览、规则计算示例）：不改数据，不必先确认上一次。 */
const readOnlyActions = new Set(['quote', 'refund_quote', 'preview_rule'])

/**
 * 「同一个动作」：同一人、同一方法和地址，请求体里同一种 action、同一个对象（targetId、accountId、
 * stockItemId、serviceTableId）。版本号、当前库存、金额这些不算——它们正是重读后会变的东西。只读动作为 null。
 */
export function actionSlot(user: string, method: string, url: string, body: string): string | null {
  let parsed: unknown
  try {
    parsed = body ? JSON.parse(body) : null
  } catch {
    parsed = null
  }
  const fields = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  if (typeof fields.action === 'string' && readOnlyActions.has(fields.action)) return null
  const pick = (name: string) => (typeof fields[name] === 'string' ? fields[name] : '')
  return JSON.stringify([
    user,
    method,
    url,
    pick('action'),
    pick('targetId'),
    pick('accountId'),
    pick('stockItemId'),
    pick('serviceTableId'),
  ])
}

/** 上次未确认的同一动作这回确认已经生效：这一次不再提交。 */
export const previousAppliedMessage =
  '上一次没收到结果的那次操作其实已经生效，这一次没有提交。请核对最新内容，需要的话再操作一次。'

/** 这次没有提交，因为上一次没收到结果的同一动作已经生效（见 idempotentFetch）：不是失败，页面按提醒显示。 */
export function isPreviousApplied(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'previous_applied'
}

/** 把 request 换成这个请求体和幂等键（其余请求头照旧）。 */
function withBody(request: Request, body: string, key: string): Request {
  const headers = new Headers(request.headers)
  headers.set('Idempotency-Key', key)
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body === '' ? undefined : body,
    signal: request.signal,
  })
}

/**
 * 发请求。带幂等键的写请求按上面的规则挑键、先确认上一次；其余原样发。
 * 每次现取全局 fetch（openapi-fetch 默认在创建时就记下了），单元测试换掉 fetch 才生效。
 */
async function idempotentFetch(request: Request): Promise<Response> {
  const proposed = request.headers.get('Idempotency-Key')
  if (!proposed) return globalThis.fetch(request)
  const body = await request.clone().text()
  const slot = actionSlot(loadSession()?.user.id ?? '', request.method, request.url, body)
  if (!slot) return globalThis.fetch(request)
  const previous = unconfirmed.get(slot)
  let key = proposed
  if (previous && previous.body !== body) {
    // 上次同一动作结果未知：先原样重发它（原请求体、原键）。断网照样抛出，5xx 原样交回：仍然未知，保留
    const replay = await globalThis.fetch(withBody(request, previous.body, previous.key))
    if (replay.status >= 500) return replay
    unconfirmed.delete(slot)
    if (replay.ok)
      return new Response(JSON.stringify({ code: 'previous_applied', message: previousAppliedMessage }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    // 4xx：上次确实没生效，接着提交这一次
  } else if (previous) {
    key = previous.key
  }
  unconfirmed.set(slot, { body, key })
  const response = await globalThis.fetch(withBody(request, body, key))
  if (response.status < 500 && unconfirmed.get(slot)?.key === key) unconfirmed.delete(slot)
  return response
}

type ErrorBody = { code?: string; message?: string; requestId?: string }

// 后端多数错误已带中文说明；无权、不存在等通用错误只回英文代号，这里换成中文（与小程序 services/staff.ts 一致）。
const codeMessages: Record<string, string> = {
  unauthorized: '登录已失效，请重新扫码登录',
  forbidden: '当前账号无权执行此操作',
  not_found: '要操作的记录不存在，请刷新后重试',
  last_owner: '系统必须保留至少一名老板',
  idempotency_required: '请求缺少幂等键',
  idempotency_conflict: '请求内容与上次提交不一致，请重新读取后再确认',
  order_version_conflict: '订单已被修改，请重新读取并确认',
  insufficient_stock: '库存不足',
  rate_limited: '操作太频繁，请稍后再试',
  // 生日礼物核销（/loyalty/actions 的 fulfill_gift）：过期、已核销各有错误码，说法同后端
  birthday_gift_expired: '这份生日礼物已过期，不能再核销',
  birthday_gift_fulfilled: '这份生日礼物已经核销过了，不能重复核销',
}
const statusMessages: Record<number, string> = {
  401: codeMessages.unauthorized,
  403: codeMessages.forbidden,
  404: codeMessages.not_found,
}
const hasChinese = /[一-鿿]/

/** 给人看的错误说明：后端有中文就原样用，否则按代号或状态换成中文。 */
export function readableMessage(status: number, body: ErrorBody | null): string {
  const message = body?.message ?? ''
  if (hasChinese.test(message)) return message
  const code = body?.code ?? ''
  return codeMessages[code] ?? statusMessages[status] ?? `请求未完成，请稍后重试（${code || status}）`
}

async function errorBody(response: Response): Promise<ErrorBody | null> {
  try {
    const body: unknown = await response.clone().json()
    return body && typeof body === 'object' ? (body as ErrorBody) : null
  } catch {
    return null
  }
}

const isAbort = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'

/**
 * 每个请求都经过这里：带上令牌与幂等键；失败（非 2xx）一律抛 ApiError，所以调用处拿到的都是成功的结果；
 * 401 且带了令牌时清掉本地会话、跳回登录页（扫码登录这类匿名请求的 401 不跳）。
 */
const sessionMiddleware: Middleware = {
  onRequest({ request, schemaPath, options }) {
    request.headers.set('Accept', options.parseAs === 'json' ? 'application/json' : '*/*')
    const session = anonymousPaths.has(schemaPath as keyof paths) ? null : loadSession()
    if (session) request.headers.set('Authorization', `Bearer ${session.accessToken}`)
  },
  async onResponse({ request, response }) {
    if (response.ok) return
    const body = await errorBody(response)
    if (response.status === 401 && request.headers.has('Authorization')) {
      clearSession()
      unauthorizedHandler?.()
    }
    throw new ApiError(
      response.status,
      body?.code ?? 'http_error',
      readableMessage(response.status, body),
      body?.requestId,
    )
  },
  onError({ error }) {
    // 取消（换页、离开页面）原样抛出，交给 TanStack Query 处理；其余都是没连上
    if (isAbort(error)) return
    return new ApiError(0, 'network_error', '网络连接失败，请检查网络后重试')
  },
}

/** 按契约检查的接口客户端，地址前缀 /api/v2（和页面同源）。 */
export const client = createClient<paths>({
  baseUrl: `${window.location.origin}/api/v2`,
  fetch: idempotentFetch,
})
client.use(sessionMiddleware)

/** openapi-fetch 的结果。失败已由中间件抛成 ApiError，走到这里的都是成功的响应。 */
interface Result<D> {
  data?: D
  response: Response
}

/** 取出成功响应的内容。 */
export async function read<D>(request: Promise<Result<D>>): Promise<D> {
  return (await request).data as D
}

/** 服务端分页列表的一页：总数与实际页码在 X-Total-Count、X-Page 响应头里（页码超出时服务端落到最后一页）。 */
export interface Page<T> {
  rows: T[]
  /** 符合条件的总条数。 */
  total: number
  /** 服务端实际返回的页码。 */
  page: number
}

/** 取一页列表：内容加上响应头里的总数和实际页码；响应头缺失时按这一页的条数和请求的页码算。 */
export async function readPage<T>(request: Promise<Result<T[]>>, requestedPage: number): Promise<Page<T>> {
  const { data, response } = await request
  const rows = data ?? []
  const total = Number(response.headers.get('X-Total-Count') ?? Number.NaN)
  const page = Number(response.headers.get('X-Page') ?? Number.NaN)
  return {
    rows,
    total: Number.isInteger(total) && total >= 0 ? total : rows.length,
    page: Number.isInteger(page) && page >= 1 ? page : requestedPage,
  }
}
