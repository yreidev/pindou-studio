import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSession, saveSession } from '../session'
import { ApiError, client, read, readPage, setUnauthorizedHandler } from './client'

function respond(status: number, body?: unknown, headers?: Record<string, string>) {
  return vi.fn<(request: Request) => Promise<Response>>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
  )
}

function login() {
  saveSession({
    accessToken: 'web-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    user: { id: 'u1', nickname: '阿贝', roles: ['owner'] },
  })
}

const requestOf = (fetch: ReturnType<typeof respond>, call = 0) => fetch.mock.calls[call][0]

const receipt = { stockItemId: 's1', quantity: 2 }
const purchase = {
  supplierName: '供应商',
  items: [{ productId: '00000000-0000-0000-0000-000000000001', quantity: 2, unitCostCents: 100 }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  setUnauthorizedHandler(null)
})

describe('接口客户端', () => {
  it('带上会话令牌和幂等键，请求体按 JSON 发', async () => {
    login()
    const fetch = respond(201, { id: 'p1' })
    vi.stubGlobal('fetch', fetch)
    const result = await client.POST('/stock-receipts', {
      params: { header: { 'Idempotency-Key': 'key-1' } },
      body: purchase,
    })
    expect(result.data).toEqual({ id: 'p1' })
    expect(result.response.status).toBe(201)
    const request = requestOf(fetch)
    expect(new URL(request.url).pathname).toBe('/api/v2/stock-receipts')
    expect(request.method).toBe('POST')
    expect(await request.text()).toBe(JSON.stringify(purchase))
    expect(request.headers.get('Authorization')).toBe('Bearer web-token')
    expect(request.headers.get('Idempotency-Key')).toBe('key-1')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('Accept')).toBe('application/json')
  })

  it('匿名接口不带令牌', async () => {
    login()
    const fetch = respond(201, {})
    vi.stubGlobal('fetch', fetch)
    await client.POST('/auth/web-login-challenges')
    expect(requestOf(fetch).headers.has('Authorization')).toBe(false)
  })

  it('服务端错误转成 ApiError，保留错误码、中文说明和请求编号', async () => {
    login()
    vi.stubGlobal('fetch', respond(409, { code: 'version_conflict', message: '订单已被别人修改', requestId: 'req-9' }))
    const error = await client
      .POST('/sales-orders/{salesOrderId}/refunds', {
        params: { path: { salesOrderId: 'o1' }, header: { 'Idempotency-Key': 'k' } },
        body: { expectedVersion: 'v', amountCents: 1, reason: '退' },
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'version_conflict',
      message: '订单已被别人修改',
      requestId: 'req-9',
    })
    expect(loadSession()).not.toBeNull()
  })

  it('401 清掉本地会话并通知回登录页', async () => {
    login()
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', respond(401, { code: 'unauthorized', message: '请重新登录' }))
    await expect(client.GET('/accounts/{accountId}', { params: { path: { accountId: 'u1' } } })).rejects.toMatchObject({
      status: 401,
    })
    expect(loadSession()).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('没登录时的 401 不触发跳转（例如扫码登录的匿名请求）', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    vi.stubGlobal('fetch', respond(401, {}))
    await expect(client.POST('/auth/web-login-challenges')).rejects.toMatchObject({ status: 401 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('网络断开给出中文提示；取消请求原样抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(client.GET('/accounts/{accountId}', { params: { path: { accountId: 'u1' } } })).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: '网络连接失败，请检查网络后重试',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }),
    )
    const aborted = await client.GET('/catalog-items').catch((e: unknown) => e)
    expect(aborted).not.toBeInstanceOf(ApiError)
    expect(aborted).toMatchObject({ name: 'AbortError' })
  })

  it('成功的内容直接取出；分页的总数与实际页码读响应头', async () => {
    login()
    vi.stubGlobal('fetch', respond(200, [{ id: 'c1', name: '豆子', unitPriceCents: 100 }]))
    expect(await read(client.GET('/catalog-items'))).toEqual([{ id: 'c1', name: '豆子', unitPriceCents: 100 }])

    vi.stubGlobal('fetch', respond(200, [{ id: 'a' }], { 'X-Total-Count': '41', 'X-Page': '3' }))
    const page = await readPage(client.GET('/system/audit-events', { params: { query: { page: 9, pageSize: 20 } } }), 9)
    expect(page).toMatchObject({ rows: [{ id: 'a' }], total: 41, page: 3 })

    // 没有分页响应头（不带 pageSize 的旧接口）时按这一页算
    vi.stubGlobal('fetch', respond(200, [{ id: 'a' }, { id: 'b' }]))
    expect(await readPage(client.GET('/system/audit-events'), 2)).toMatchObject({ total: 2, page: 2 })
  })
})

describe('幂等键', () => {
  const keyOf = (fetch: ReturnType<typeof respond>, call: number) =>
    requestOf(fetch, call).headers.get('Idempotency-Key')
  const adjust = (body: { stockItemId: string; quantity: number }, key: string) =>
    client.POST('/stock-adjustments', {
      params: { header: { 'Idempotency-Key': key } },
      body: { stockItemId: body.stockItemId, quantityDelta: body.quantity, reason: '盘点' },
    })

  it('同一请求重试沿用同一个键，拿到明确结果后作废；内容变了换新键', async () => {
    login()
    const failing = respond(503, {})
    vi.stubGlobal('fetch', failing)
    await adjust(receipt, 'first').catch(() => {})
    await adjust(receipt, 'second').catch(() => {})
    expect(keyOf(failing, 0)).toBe('first')
    expect(keyOf(failing, 1)).toBe('first')

    // 断网同样保留
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await adjust(receipt, 'third').catch(() => {})

    const ok = respond(201, { id: 's1', quantity: 4 })
    vi.stubGlobal('fetch', ok)
    await adjust(receipt, 'fourth')
    await adjust(receipt, 'fifth')
    await adjust({ ...receipt, quantity: 3 }, 'sixth')
    expect(keyOf(ok, 0)).toBe('first')
    expect(keyOf(ok, 1)).toBe('fifth')
    expect(keyOf(ok, 2)).toBe('sixth')
  })

  it('4xx 也是明确结果：作废键，下次用新键', async () => {
    login()
    const rejected = respond(409, { code: 'stock_quantity_conflict', message: '库存已变化' })
    vi.stubGlobal('fetch', rejected)
    await adjust(receipt, 'first').catch(() => {})
    await adjust(receipt, 'second').catch(() => {})
    expect(keyOf(rejected, 1)).toBe('second')
  })

  it('换了人就不沿用别人的键', async () => {
    login()
    vi.stubGlobal('fetch', respond(503, {}))
    await adjust(receipt, 'mine').catch(() => {})
    saveSession({
      accessToken: 'other-token',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      user: { id: 'u2', nickname: '小林', roles: ['manager'] },
    })
    const fetch = respond(201, {})
    vi.stubGlobal('fetch', fetch)
    await adjust(receipt, 'theirs')
    expect(keyOf(fetch, 0)).toBe('theirs')
  })

  // 结果未知之后页面重读了，请求体里的版本号（或当前库存）跟着变：以前内容一变就换新键，后端当成新操作
  // 再执行一次（看板续时扣两次、9 折打两次成 81 折）。现在同一个动作先把上次未确认的那一条原样重发。
  const discount = (expectedVersion: string, key: string) =>
    client.POST('/sales-orders/{salesOrderId}/discounts', {
      params: { path: { salesOrderId: 'o1' }, header: { 'Idempotency-Key': key } },
      body: { expectedVersion, kind: 'percentage', rateBasisPoints: 1000, reason: '老顾客' },
    })
  const bodyOf = async (fetch: ReturnType<typeof respond>, call: number) =>
    JSON.parse(await requestOf(fetch, call).clone().text()) as Record<string, unknown>

  it('结果未知后同一动作换了版本：先原样重发上次的，已生效就停下、不再提交新的', async () => {
    login()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await discount('a'.repeat(64), 'first').catch(() => {})
    // 重读后订单已是新版本（上次其实打上了），员工再点一次 9 折
    const replayed = respond(201, { id: 'o1' })
    vi.stubGlobal('fetch', replayed)
    const error = await discount('b'.repeat(64), 'second').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'previous_applied' })
    expect((error as ApiError).message).toMatch(/已经生效/)
    expect(replayed).toHaveBeenCalledOnce()
    expect(keyOf(replayed, 0)).toBe('first')
    expect(await bodyOf(replayed, 0)).toMatchObject({ expectedVersion: 'a'.repeat(64) })

    // 确认过了：之后照常提交
    const next = respond(201, { id: 'o1' })
    vi.stubGlobal('fetch', next)
    await discount('c'.repeat(64), 'third')
    expect(keyOf(next, 0)).toBe('third')
    expect(await bodyOf(next, 0)).toMatchObject({ expectedVersion: 'c'.repeat(64) })
  })

  it('原样重发被拒（4xx）说明上次没生效：接着提交这一次', async () => {
    login()
    vi.stubGlobal('fetch', respond(502, {}))
    const renew = (expectedVersion: string, key: string) =>
      client.POST('/loyalty/actions', {
        params: { header: { 'Idempotency-Key': key } },
        body: { action: 'renew', targetId: '00000000-0000-0000-0000-00000000000a', expectedVersion },
      })
    await renew('a'.repeat(64), 'first').catch(() => {})
    const replies = [
      new Response(JSON.stringify({ code: 'loyalty_conflict', message: '计时已变化' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response(JSON.stringify({ session: {}, version: 'v' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]
    const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => replies.shift()!)
    vi.stubGlobal('fetch', fetch)
    await renew('b'.repeat(64), 'second')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(keyOf(fetch, 0)).toBe('first')
    expect(await bodyOf(fetch, 0)).toMatchObject({ expectedVersion: 'a'.repeat(64) })
    expect(keyOf(fetch, 1)).toBe('second')
    expect(await bodyOf(fetch, 1)).toMatchObject({ expectedVersion: 'b'.repeat(64) })
  })

  it('别的对象、别的动作、只读的报价不受一条未确认的影响', async () => {
    login()
    vi.stubGlobal('fetch', respond(503, {}))
    await discount('a'.repeat(64), 'pending').catch(() => {})
    const fetch = respond(200, {})
    vi.stubGlobal('fetch', fetch)
    await client.POST('/sales-orders/{salesOrderId}/discounts', {
      params: { path: { salesOrderId: 'o2' }, header: { 'Idempotency-Key': 'other-order' } },
      body: { expectedVersion: 'b'.repeat(64), kind: 'fixed', amountCents: 100, reason: '老顾客' },
    })
    await client.POST('/loyalty/actions', {
      params: { header: { 'Idempotency-Key': 'quote' } },
      body: { action: 'quote', targetId: '00000000-0000-0000-0000-00000000000b', expectedVersion: 'b'.repeat(64) },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(keyOf(fetch, 0)).toBe('other-order')
    expect(keyOf(fetch, 1)).toBe('quote')
  })

  it('退款预览只算不写：上一次没拿到结果也不先重发它', async () => {
    login()
    const refundQuote = (amountCents: number, key: string) =>
      client.POST('/loyalty/actions', {
        params: { header: { 'Idempotency-Key': key } },
        body: {
          action: 'refund_quote',
          targetId: '00000000-0000-0000-0000-00000000000c',
          expectedVersion: 'c'.repeat(64),
          amountCents,
        },
      })
    vi.stubGlobal('fetch', respond(503, {}))
    await refundQuote(1000, 'first').catch(() => {})
    const fetch = respond(200, {})
    vi.stubGlobal('fetch', fetch)
    await refundQuote(500, 'second')
    expect(fetch).toHaveBeenCalledOnce()
    expect(keyOf(fetch, 0)).toBe('second')
  })

  it('不要求幂等的请求不带键', async () => {
    login()
    const fetch = respond(200, [])
    vi.stubGlobal('fetch', fetch)
    await client.GET('/system/audit-events')
    expect(keyOf(fetch, 0)).toBeNull()
  })
})

describe('下载', () => {
  it('带令牌取回文件内容；失败时给出中文错误', async () => {
    login()
    const fetch = vi.fn<(request: Request) => Promise<Response>>(async () => new Response('xlsx', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const blob = await read(
      client.GET('/reports/exports/{kind}', {
        params: { path: { kind: 'orders' }, query: { from: '2026-10-01' } },
        parseAs: 'blob',
      }),
    )
    expect(await blob.text()).toBe('xlsx')
    const request = requestOf(fetch)
    expect(request.headers.get('Authorization')).toBe('Bearer web-token')
    expect(request.headers.get('Accept')).toBe('*/*')
    vi.stubGlobal('fetch', respond(403, { code: 'forbidden', message: '当前账号无权执行此操作' }))
    await expect(client.POST('/system/data-exports', { parseAs: 'blob' })).rejects.toMatchObject({
      status: 403,
      message: '当前账号无权执行此操作',
    })
  })
})

describe('错误说明', () => {
  it('后端的中文说明原样显示；只有英文代号时换成中文', async () => {
    login()
    vi.stubGlobal('fetch', respond(403, { code: 'forbidden', message: 'forbidden' }))
    await expect(client.GET('/system/audit-events')).rejects.toMatchObject({ message: '当前账号无权执行此操作' })
    vi.stubGlobal('fetch', respond(404, { code: 'not_found', message: 'not_found' }))
    await expect(
      client.GET('/sales-orders/{salesOrderId}', { params: { path: { salesOrderId: 'x' } } }),
    ).rejects.toMatchObject({ message: '要操作的记录不存在，请刷新后重试' })
    vi.stubGlobal('fetch', respond(409, { code: 'order_version_conflict', message: '订单已被他人修改，请刷新后重试' }))
    await expect(
      client.POST('/sales-orders/{salesOrderId}/refunds', {
        params: { path: { salesOrderId: 'x' }, header: { 'Idempotency-Key': 'k' } },
        body: { expectedVersion: 'v', amountCents: 1, reason: '退' },
      }),
    ).rejects.toMatchObject({ message: '订单已被他人修改，请刷新后重试' })
    // 生日礼物核销被拒：过期、已核销各有错误码，后端说明不是中文时也按代号说清楚
    for (const [code, message] of [
      ['birthday_gift_expired', '这份生日礼物已过期，不能再核销'],
      ['birthday_gift_fulfilled', '这份生日礼物已经核销过了，不能重复核销'],
    ]) {
      vi.stubGlobal('fetch', respond(409, { code, message: code }))
      await expect(
        client.POST('/loyalty/actions', {
          params: { header: { 'Idempotency-Key': `k-${code}` } },
          body: { action: 'fulfill_gift', accountId: 'u', targetId: `g-${code}` },
        }),
      ).rejects.toMatchObject({ status: 409, code, message })
    }
    vi.stubGlobal('fetch', respond(500, {}))
    await expect(client.GET('/accounts')).rejects.toMatchObject({ message: '请求未完成，请稍后重试（500）' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad Gateway', { status: 502 })),
    )
    await expect(client.GET('/accounts')).rejects.toMatchObject({
      code: 'http_error',
      message: '请求未完成，请稍后重试（502）',
    })
  })
})
