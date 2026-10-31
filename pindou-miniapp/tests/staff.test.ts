import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { clockTime, dateOnly, dateTime } from '../src/services/format'
import {
  blankLine,
  decimalHundredths,
  fromStoreDateTime,
  hasUnsavedLines,
  orderLines,
  storeDateTime,
  validatedLines,
} from '../src/services/staff-workflow'
import { load } from './helpers/load'

// 请求客户端有模块级状态（同一操作的幂等键），每条用例按自己的 Taro 替身新装一份
const staffWith = (taro: Record<string, unknown>) =>
  load<typeof import('../src/services/staff')>('services/staff.ts', { '@tarojs/taro': { default: taro } })

// TEST-SESSION-001: 开台时间按门店时区输入，手机时区是什么都一样，并且原样换回那一刻。
test('session start time and displayed times follow the store timezone on any device', () => {
  const previous = process.env.TZ
  try {
    for (const zone of ['Asia/Shanghai', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
      process.env.TZ = zone
      for (const [instant, store] of [
        ['2026-09-06T04:00:00Z', '2026-09-06T12:00'],
        ['2026-09-05T17:30:00Z', '2026-09-06T01:30'],
        ['2026-12-31T16:00:00Z', '2027-01-01T00:00'],
      ]) {
        const date = new Date(instant)
        assert.equal(storeDateTime(date), store, zone)
        assert.equal(fromStoreDateTime(store).getTime(), date.getTime(), zone)
      }
      assert.equal(dateTime('2026-10-04T16:30:00Z'), '2026-10-05 00:30', zone)
      assert.equal(dateOnly('2026-10-04T16:30:00Z'), '2026-10-05', zone)
      assert.equal(clockTime('2026-10-04T16:30:05Z'), '00:30:05', zone)
      assert.equal(dateTime('不是时间'), '--', zone)
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

// TEST-ORDER-001: only a saved server-authoritative order can be paid.
test('all line edits, additions and removals require saving before payment', () => {
  const order: any = { lines: [{ name: 'Service', quantity: 1, unitPriceCents: 100 }] }
  assert.equal(hasUnsavedLines(order, orderLines(order)), false)
  for (const field of ['productId', 'name', 'quantity', 'unitPriceYuan']) {
    const lines: any = orderLines(order)
    lines[0][field] = 'changed'
    assert.equal(hasUnsavedLines(order, lines), true)
  }
  assert.equal(hasUnsavedLines(order, []), true)
  assert.equal(hasUnsavedLines(order, [...orderLines(order), blankLine()]), true)
  assert.deepEqual(validatedLines(orderLines(order)), [
    { name: 'Service', productId: undefined, quantity: 1, unitPriceCents: 100 },
  ])
  for (const amount of ['', '1.005', '-1', '9007199254740992'])
    assert.throws(() => validatedLines([{ name: 'Service', productId: '', quantity: '1', unitPriceYuan: amount }]))
})

test('uncertain financial request retries reuse the key, completed operations get a new key', async () => {
  const sent: any[] = []
  let attempt = 0
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      attempt++
      if (attempt === 1) throw new Error('timeout after commit')
      if (attempt === 2) return { statusCode: 503, data: {} }
      return { statusCode: 201, data: {} }
    },
  }
  const { staffApi } = await staffWith(taro)
  const discount = () =>
    staffApi.discountOrder('order', { kind: 'fixed', amountCents: 100, reason: 'reason' }, 'a'.repeat(64))
  for (let i = 0; i < 2; i++) await assert.rejects(discount())
  await discount()
  await discount()
  const keys = sent.map((value) => value.header['Idempotency-Key'])
  assert.equal(keys[0], keys[1])
  assert.equal(keys[1], keys[2])
  assert.notEqual(keys[2], keys[3])
  assert.ok(sent.every((value) => value.data.expectedVersion === 'a'.repeat(64)))
})

// 结果未知之后页面重读了：请求体里的版本号（或当前库存）变了，员工再点同一个按钮，内容不同就是一把新键，
// 后端当成新操作再执行一次（看板续时扣两次、9 折打两次成 81 折）。现在同一个动作先把上次未确认的那一条
// 原样（原请求体、原键）重发：后端重放出成功，说明上次已经生效，这次不再提交；后端拒绝（4xx），说明上次
// 确实没生效，再发这一次。
test('an unconfirmed action is resent as it was before the same action goes out with a newer version', async () => {
  const sent: any[] = []
  const replies: Array<() => any> = [
    () => {
      throw new Error('timeout after commit')
    },
    () => ({ statusCode: 201, data: { id: 'order', version: 'c'.repeat(64) } }),
  ]
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      return replies.shift()!()
    },
  }
  const { staffApi } = await staffWith(taro)
  const nineTenths = { kind: 'percentage' as const, rateBasisPoints: 1000, reason: '老顾客' }
  await assert.rejects(staffApi.discountOrder('order', nineTenths, 'a'.repeat(64)), (e: any) => e.code === 'network')
  // 重读后订单已是新版本（上次其实打上了），员工再点一次 9 折
  await assert.rejects(
    staffApi.discountOrder('order', nineTenths, 'b'.repeat(64)),
    (e: any) => e.code === 'previous_applied' && /已经生效/.test(e.message),
  )
  assert.equal(sent.length, 2, '新的那次不能再发出去')
  assert.equal(sent[1].data.expectedVersion, 'a'.repeat(64), '先发的是上次的原请求体')
  assert.equal(sent[1].header['Idempotency-Key'], sent[0].header['Idempotency-Key'], '用上次的原键')

  // 已经确认过了：之后的同一动作照常提交
  replies.push(() => ({ statusCode: 201, data: {} }))
  await staffApi.discountOrder('order', nineTenths, 'c'.repeat(64))
  assert.equal(sent.length, 3)
  assert.equal(sent[2].data.expectedVersion, 'c'.repeat(64))
  assert.notEqual(sent[2].header['Idempotency-Key'], sent[0].header['Idempotency-Key'])
})

test('an unconfirmed action that the server rejects on resend did not happen, so the new one goes out', async () => {
  const sent: any[] = []
  const replies: Array<() => any> = [
    () => ({ statusCode: 502, data: {} }),
    () => ({ statusCode: 409, data: { code: 'loyalty_conflict', message: '计时已变化，请刷新后重新确认' } }),
    () => ({ statusCode: 200, data: { session: {}, version: 'v3' } }),
  ]
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      return replies.shift()!()
    },
  }
  const staff = await staffWith(taro)
  const { loyalty } = await load<typeof import('../src/services/membership')>('services/membership.ts', {
    '@tarojs/taro': { default: taro },
    './customer': { CustomerError: class extends Error {} },
    './staff': staff,
  })
  await assert.rejects(loyalty.action({ action: 'renew', targetId: 'session', expectedVersion: 'a'.repeat(64) }))
  await loyalty.action({ action: 'renew', targetId: 'session', expectedVersion: 'b'.repeat(64) })
  assert.equal(sent.length, 3)
  assert.equal(sent[1].data.expectedVersion, 'a'.repeat(64))
  assert.equal(sent[1].header['Idempotency-Key'], sent[0].header['Idempotency-Key'])
  assert.equal(sent[2].data.expectedVersion, 'b'.repeat(64))
  assert.notEqual(sent[2].header['Idempotency-Key'], sent[0].header['Idempotency-Key'])

  // 别的会话、别的动作、只读的报价不受这条未确认的影响
  replies.push(() => {
    throw new Error('offline')
  })
  await assert.rejects(loyalty.action({ action: 'renew', targetId: 'session', expectedVersion: 'c'.repeat(64) }))
  replies.push(
    () => ({ statusCode: 200, data: {} }),
    () => ({ statusCode: 200, data: {} }),
    () => ({ statusCode: 200, data: {} }),
  )
  await loyalty.action({ action: 'renew', targetId: 'other-session', expectedVersion: 'd'.repeat(64) })
  await loyalty.action({ action: 'pause', targetId: 'session', expectedVersion: 'd'.repeat(64) })
  await loyalty.action({ action: 'quote', targetId: 'order', expectedVersion: 'd'.repeat(64), points: 10 })
  assert.deepEqual(
    sent.slice(4).map((request) => [request.data.action, request.data.targetId]),
    [
      ['renew', 'other-session'],
      ['pause', 'session'],
      ['quote', 'order'],
    ],
  )
})

// TEST-ORDER-002: a conflict never silently changes version or retries a write.
test('order mutations send the confirmed version and surface conflicts without resubmitting', async () => {
  const sent: any[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      return { statusCode: 409, data: { code: 'order_version_conflict' } }
    },
  }
  const { staffApi } = await staffWith(taro)
  const version = 'b'.repeat(64)
  for (const operation of [
    () => staffApi.updateOrder('order', [{ quantity: 1, unitPriceCents: 100 }], version),
    () => staffApi.payOrder('order', 'cash', 100, version),
    () => staffApi.discountOrder('order', { kind: 'fixed', amountCents: 10, reason: 'reason' }, version),
  ])
    await assert.rejects(operation(), (error: any) => error.code === 'order_version_conflict')
  assert.equal(sent.length, 3)
  assert.ok(sent.every((request) => request.data.expectedVersion === version && request.header['Idempotency-Key']))
})

test('discount input converts decimal text to exact integer hundredths', () => {
  assert.equal(decimalHundredths('0.29'), 29)
  assert.equal(decimalHundredths('10.1'), 1010)
  assert.equal(decimalHundredths(' 20 '), 2000)
  for (const input of ['0', '-1', '1.001', '1e2', '', '9007199254740992']) assert.throws(() => decimalHundredths(input))
})

// 生日礼物核销被拒：过期、已核销各有错误码，页面显示直白的说法（以前过期的回笼统的「请检查规则……有效期设置」）。
test('birthday gift refusals read plainly by their codes', async () => {
  for (const [code, message] of [
    ['birthday_gift_expired', '这份生日礼物已过期，不能再核销'],
    ['birthday_gift_fulfilled', '这份生日礼物已经核销过了，不能重复核销'],
  ]) {
    const taro = {
      getStorageSync: () => ({ accessToken: 'test-token' }),
      request: async () => ({ statusCode: 409, data: { code, message: code } }),
    }
    const { request } = await staffWith(taro)
    await assert.rejects(
      request('/loyalty/actions', 'POST', { action: 'fulfill_gift', accountId: 'u', targetId: 'g' }, true),
      (error: any) => {
        assert.equal(error.code, code)
        assert.equal(error.message, message)
        return true
      },
    )
  }
})

test('payment stock failures give actionable Chinese guidance', async () => {
  for (const response of [{ statusCode: 409, data: { code: 'insufficient_stock', message: '库存不足' } }]) {
    const sent: any[] = []
    const taro = {
      getStorageSync: () => ({ accessToken: 'test-token' }),
      request: async (request: any) => {
        sent.push(request)
        return response
      },
    }
    const { staffApi } = await staffWith(taro)
    await assert.rejects(staffApi.payOrder('order', 'wechat', 2990, 'a'.repeat(64)), (error: any) => {
      assert.equal(error.code, 'insufficient_stock')
      assert.match(error.message, /采购入库/)
      assert.match(error.message, /自定义服务/)
      return true
    })
    assert.equal(sent.length, 1, 'stock failure must not trigger automatic payment retries')
    // 只有收款时的库存不足才给「去采购入库 / 改用自定义服务」的指引
    await assert.rejects(
      staffApi.updateOrder('order', [{ quantity: 1, unitPriceCents: 100 }], 'a'.repeat(64)),
      (error: any) => {
        assert.equal(error.code, response.data.code)
        assert.doesNotMatch(error.message, /自定义服务/)
        return true
      },
    )
  }
})

test('WebSocket initial connect and reconnect refresh server resources', async () => {
  let opened: () => void = () => {},
    message: (event: unknown) => void = () => {},
    closed = 0,
    updates = 0
  const task = {
    onOpen: (fn: () => void) => {
      opened = fn
    },
    onMessage: (fn: (event: unknown) => void) => {
      message = fn
    },
    onClose: () => {},
    onError: () => {},
    close: () => {
      closed++
    },
  }
  const { connectEvents } = await load<typeof import('../src/services/events')>('services/events.ts', {
    '@tarojs/taro': {
      default: { getStorageSync: () => ({ accessToken: 'test-token' }), connectSocket: async () => task },
    },
  })
  const disconnect = connectEvents(() => updates++)
  await new Promise((resolve) => setImmediate(resolve))
  opened()
  message({ data: '{}' })
  assert.equal(updates, 2)
  disconnect()
  assert.equal(closed, 1)
})

// 员工端只在订单收款和工作台用订单列表，都只要待结账的单：交给服务端筛，不拉全部历史订单。
// 待结账：草稿和部分付款（分笔付款收了一部分、还没收齐）都要列出来，服务端按 status=open 一起筛。
test('staff order list asks the server for bills still open (draft and partially paid)', async () => {
  const sent: any[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      return { statusCode: 200, data: [] }
    },
  }
  const { staffApi } = await staffWith(taro)
  await staffApi.listDraftOrders()
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /\/sales-orders\?status=open$/)
  assert.equal(sent[0].method, 'GET')
})

// 实时事件常一次来好几条：合并成一次重读；连着来时最多等 2 秒，不会被一直推迟。
test('realtime events are coalesced with a maximum wait', async () => {
  const { coalesce } = await load<typeof import('../src/services/events')>('services/events.ts', {
    '@tarojs/taro': { default: {} },
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    let calls = 0
    const merged = coalesce(() => calls++)
    merged.call()
    merged.call()
    merged.call()
    vi.advanceTimersByTime(299)
    assert.equal(calls, 0)
    vi.advanceTimersByTime(1)
    assert.equal(calls, 1)
    // 每 250 毫秒一条，300 毫秒的合并等待永远等不满：第 2 秒那条到达时执行
    for (let i = 0; i < 9; i++) {
      merged.call()
      vi.advanceTimersByTime(250)
    }
    assert.equal(calls, 2)
    merged.cancel()
    vi.advanceTimersByTime(1000)
    assert.equal(calls, 2)
  } finally {
    vi.useRealTimers()
  }
})

// 员工找人、读预约都交给服务端筛选分页：只取一页，总数与实际页码从响应头读。
// 后端已不提供整表（不分页的 /accounts、不带 scope 的 /reservations/staff、/loyalty/staff 都删了）。
test('staff lists ask the server for one page and read its totals from the headers', async () => {
  const sent: any[] = []
  let reply: any = { statusCode: 200, data: [], header: {} }
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (request: any) => {
      sent.push(request)
      return reply
    },
  }
  const staff = await staffWith(taro)
  const customer = { CustomerError: class extends Error {} }
  const { reservations } = await load<typeof import('../src/services/reservations')>('services/reservations.ts', {
    './customer': customer,
    './staff': staff,
    './format': await load('services/format.ts'),
  })
  const { loyalty } = await load<typeof import('../src/services/membership')>('services/membership.ts', {
    '@tarojs/taro': { default: taro },
    './customer': customer,
    './staff': staff,
  })
  const path = () => sent.at(-1).url.replace(/^.*\/api\/v2/, '')

  // 真机上响应头常是全小写；X-Page 是服务端实际给的页（超出时落到最后一页）
  reply = { statusCode: 200, data: [{ id: 'a1', nickname: '小林' }], header: { 'x-total-count': '41', 'x-page': '3' } }
  const accounts = await staff.staffApi.searchAccounts('  138 0000 ', 5)
  assert.equal(path(), '/accounts?q=138%200000&page=5&pageSize=20', '关键字去掉首尾空白并转义')
  assert.equal(accounts.total, 41)
  assert.equal(accounts.page, 3)
  assert.equal(accounts.items.length, 1)
  assert.equal((staff.staffApi as any).listAccounts, undefined, '整表读取全部账户的入口已删除')

  reply = { statusCode: 200, data: [], header: { 'X-Total-Count': '0', 'X-Page': '1' } }
  await staff.staffApi.searchAccounts('x'.repeat(150), 1, 8)
  assert.equal(path(), `/accounts?q=${'x'.repeat(100)}&page=1&pageSize=8`, '关键字不超过契约的 100 字')

  reply = { statusCode: 200, data: { id: 'a1', nickname: '小林' }, header: {} }
  await staff.staffApi.getAccount('a/1')
  assert.equal(path(), '/accounts/a%2F1')

  reply = { statusCode: 200, data: [], header: { 'X-Total-Count': '3' } }
  const members = await loyalty.members('林', 2)
  assert.equal(path(), `/loyalty/members?q=${encodeURIComponent('林')}&page=2&pageSize=20`)
  assert.equal(members.total, 3)
  assert.equal(members.page, 2, '没有 X-Page 时按请求的页码')

  reply = { statusCode: 200, data: { admissions: [], tables: [] }, header: {} }
  await loyalty.shift()
  assert.equal(path(), '/loyalty/shift')
  assert.equal((loyalty as any).staff, undefined, '/loyalty/staff 已删除')

  await reservations.staffOpen()
  assert.equal(path(), '/reservations/staff?scope=open')
  reply = {
    statusCode: 200,
    data: { reservations: [{ reservation: { id: 'r1' } }], busy: [], packages: [], tables: [] },
    header: { 'x-total-count': '25', 'x-page': '2' },
  }
  const ended = await reservations.staffEnded(2)
  assert.equal(path(), '/reservations/staff?scope=ended&page=2&pageSize=20')
  assert.deepEqual(
    { total: ended.total, page: ended.page, ids: ended.items.map((entry) => entry.reservation.id) },
    { total: 25, page: 2, ids: ['r1'] },
  )
  // 按门店日期查：带 date，总数与页码照样从响应头读；不限日期时不带这个参数
  reply = { statusCode: 200, data: { reservations: [] }, header: { 'x-total-count': '3', 'x-page': '1' } }
  const day = await reservations.staffEnded(1, '2026-10-05')
  assert.equal(path(), '/reservations/staff?scope=ended&page=1&pageSize=20&date=2026-10-05')
  assert.deepEqual({ total: day.total, page: day.page }, { total: 3, page: 1 })
  await reservations.staffEnded(1, '')
  assert.equal(path(), '/reservations/staff?scope=ended&page=1&pageSize=20', '清除日期后不带 date')
  assert.equal((reservations as any).staff, undefined, '不带 scope 的整表读取已删除')

  // 响应头缺了（不该发生）：只认这一页，不在前端编总数
  reply = { statusCode: 200, data: [{ id: 'a1' }, { id: 'a2' }], header: {} }
  const bare = await staff.staffApi.searchAccounts('', 1)
  assert.deepEqual({ total: bare.total, page: bare.page }, { total: 2, page: 1 })
  assert.ok(sent.every((request) => request.method === 'GET'))
})
