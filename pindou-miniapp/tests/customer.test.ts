import assert from 'node:assert/strict'
import { test } from 'vitest'
import { CustomerClient, CustomerError } from '../src/services/customer'
import { money } from '../src/services/format'
import { phoneAuthorizationResult } from '../src/services/phone-authorization'

const accountId = '11111111-1111-4111-8111-111111111111'
const orderId = '22222222-2222-4222-8222-222222222222'
const account = {
  id: accountId,
  nickname: '测试顾客',
  phoneMasked: '138****5678',
  phoneVerificationStatus: 'verified',
  roles: [],
}
const credential = { accountId, accessToken: 'test-credential', expiresAt: '2030-01-01T00:00:00Z' }
const session = { ...credential, user: account }
const order = { id: orderId, accountId, status: 'paid', receivableCents: 12800, paidCents: 12800 }
function harness(
  handler: (path: string, options: any) => any = () => ({ statusCode: 200, data: account }),
  stored: any = credential,
  manualLoginRequired = false,
) {
  const requests: any[] = [],
    saved: any[] = []
  let loginCount = 0,
    clearCount = 0,
    sessionCreatedCount = 0
  const port = {
    request: async (path, options) => {
      requests.push({ path, ...options })
      return handler(path, options)
    },
    login: async () => `fresh-code-${++loginCount}`,
    readCredential: () => stored,
    saveCredential: (value) => {
      stored = value
      saved.push(value)
    },
    clearCredential: () => {
      stored = null
      clearCount++
    },
    readManualLoginRequired: () => manualLoginRequired,
    setManualLoginRequired: (value) => {
      manualLoginRequired = value
    },
    now: () => Date.parse('2026-09-06T00:00:00Z'),
    onSessionCreated: () => {
      assert.ok(stored?.accessToken)
      sessionCreatedCount++
    },
  }
  const client = new CustomerClient(port)
  return {
    client,
    requests,
    saved,
    restart: () => new CustomerClient(port),
    get sessionCreatedCount() {
      return sessionCreatedCount
    },
    get stored() {
      return stored
    },
    get manualLoginRequired() {
      return manualLoginRequired
    },
    get loginCount() {
      return loginCount
    },
    get clearCount() {
      return clearCount
    },
  }
}

// TEST-USER-001 / TEST-SECURITY-001: identity and private order lifecycle.
test('developer switching rotates stored credentials and can return from guest without login navigation', async () => {
  let selected = 'developer'
  const h = harness((path, options) => {
    if (path === '/auth/developer-sessions') {
      selected = options.data.mode
      return {
        statusCode: 201,
        data: {
          ...session,
          accessToken: `test-${selected}`,
          user: {
            ...account,
            developerMode: selected,
            roles: ['clerk', 'manager', 'owner'].includes(selected) ? [selected] : [],
          },
        },
      }
    }
    return { statusCode: 200, data: { ...account, developerMode: selected, roles: [] } }
  })
  await h.client.bootstrap()
  await h.client.switchDeveloperMode('guest')
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.client.getSnapshot().account!.developerMode, 'guest')
  assert.equal(h.stored.accessToken, 'test-guest')
  await h.client.switchDeveloperMode('clerk')
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.deepEqual(Array.from(h.client.getSnapshot().account!.roles), ['clerk'])
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.requests.at(-1).accessToken, 'test-guest')
})

test('switching rejects parallel attempts and discards old-role account responses', async () => {
  let resolveOld, resolveSwitch
  let reads = 0
  const h = harness((path) => {
    if (path === '/auth/developer-sessions')
      return new Promise((resolve) => {
        resolveSwitch = resolve
      })
    if (++reads === 1) return { statusCode: 200, data: { ...account, developerMode: 'owner', roles: ['owner'] } }
    return new Promise((resolve) => {
      resolveOld = resolve
    })
  })
  await h.client.bootstrap()
  const refreshing = h.client.refreshAccount()
  const switching = h.client.switchDeveloperMode('clerk')
  await assert.rejects(h.client.switchDeveloperMode('owner'), (error: any) => error.code === 'busy')
  resolveSwitch({
    statusCode: 201,
    data: { ...session, accessToken: 'new-role-token', user: { ...account, developerMode: 'clerk', roles: ['clerk'] } },
  })
  await switching
  resolveOld({ statusCode: 200, data: { ...account, developerMode: 'owner', roles: ['owner'] } })
  await assert.rejects(refreshing, (error: any) => error.code === 'cancelled')
  assert.equal(h.client.getSnapshot().account!.developerMode, 'clerk')
})

test('ordinary accounts cannot invoke developer switching', async () => {
  const h = harness()
  await h.client.bootstrap()
  await assert.rejects(h.client.switchDeveloperMode('owner'), (error: any) => error.status === 403)
  assert.equal(h.requests.length, 1)
})

test('login retry from an existing page announces success once, while profile refresh does not', async () => {
  let available = false
  const h = harness(
    (path) =>
      !available
        ? { statusCode: 503, data: { code: 'wechat_unavailable' } }
        : { statusCode: 200, data: path === '/auth/wechat-sessions' ? session : account },
    null,
  )
  await h.client.bootstrap()
  await h.client.signIn()
  assert.equal(h.client.getSnapshot().status, 'error')
  assert.equal(h.sessionCreatedCount, 0)
  available = true
  await h.client.signIn()
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.sessionCreatedCount, 1)
  await h.client.refreshAccount()
  assert.equal(h.sessionCreatedCount, 1)
})
test('startup without credentials stays a guest without WeChat or API calls', async () => {
  const h = harness(() => ({ statusCode: 201, data: session }), null)
  await h.client.bootstrap()
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.loginCount, 0)
  assert.equal(h.requests.length, 0)
})
test('leaving login invalidates a pending response without logging the guest back in', async () => {
  let resolve
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done
      }),
    null,
  )
  const signingIn = h.client.signIn()
  await new Promise((done) => setImmediate(done))
  h.client.cancelAuthentication()
  resolve({ statusCode: 201, data: session })
  await signingIn
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.saved.length, 0)
})
test('leaving registration discards a late account response', async () => {
  let resolve
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done
      }),
    null,
  )
  const registering = h.client.register({ nickname: '新顾客', phone: '13800135678', privacyContractVersion: 'v1' })
  await new Promise((done) => setImmediate(done))
  h.client.cancelAuthentication()
  resolve({ statusCode: 201, data: session })
  await assert.rejects(registering, (error: any) => error.code === 'cancelled')
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.saved.length, 0)
})
// ★ 构建期开关 TARO_APP_WECHAT_PHONE_AUTH 删掉了：它管的是一件一辈子不变的事
//   （本小程序主体有没有手机号快速验证能力），却要改配置 + 重新构建上传才能翻。
//   现在按钮一直给，主体没能力时由下面这些翻译兜住 —— 它们才是真正的护栏。
test('phone authorization distinguishes permission, privacy, cancellation and network failures', () => {
  assert.match(
    phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail jsapi has no permission', errno: 102 }).message,
    /暂无法快捷填写.*错误码 102/,
  )
  assert.match(
    phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail privacy permission denied' }).message,
    /隐私授权未完成/,
  )
  assert.match(
    phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail privacy authorization' }).message,
    /隐私授权未完成/,
  )
  assert.deepEqual(phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail user deny' }), { code: '', message: '' })
  assert.deepEqual(phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail user cancel' }), { code: '', message: '' })
  assert.match(
    phoneAuthorizationResult({ errMsg: 'getPhoneNumber:fail network timeout', errCode: -1 }).message,
    /连接失败.*错误码 -1/,
  )
})
test('phone authorization accepts only a successful code and safely handles missing results', () => {
  assert.deepEqual(phoneAuthorizationResult({ code: 'one-use-code', errMsg: 'getPhoneNumber:ok', errno: 0 }), {
    code: 'one-use-code',
    message: '',
  })
  assert.equal(phoneAuthorizationResult({ code: 'stale', errMsg: 'getPhoneNumber:fail', errno: 102 }).code, '')
  for (const detail of [null, undefined, {}, { code: '' }, { errMsg: 'getPhoneNumber:ok' }]) {
    const result = phoneAuthorizationResult(detail)
    assert.equal(result.code, '')
    assert.match(result.message, /没有拿到手机号/)
  }
})
test('phone authorization errors do not display raw credentials or personal information', () => {
  const result = phoneAuthorizationResult({
    errMsg: 'getPhoneNumber:fail secret 13800135678',
    code: 'one-use-secret',
    encryptedData: 'encrypted-secret',
    errCode: '13800135678',
  })
  assert.equal(result.code, '')
  assert.doesNotMatch(result.message, /secret|13800135678/)
})
test('explicit logout survives repeated startup and a new client instance', async () => {
  const h = harness()
  await h.client.bootstrap()
  h.client.signOut()
  assert.equal(h.stored, null)
  assert.equal(h.manualLoginRequired, true)
  await h.client.bootstrap()
  await h.client.bootstrap()
  const restarted = h.restart()
  await restarted.bootstrap()
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(restarted.getSnapshot().status, 'anonymous')
  assert.equal(h.loginCount, 0)
  assert.equal(h.requests.length, 1)
})
test('manual-login requirement takes precedence over leftover credentials', async () => {
  const h = harness(undefined, credential, true)
  await h.client.bootstrap()
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.stored, null)
  assert.equal(h.loginCount, 0)
  assert.equal(h.requests.length, 0)
})
test('successful manual login allows subsequent credential restoration', async () => {
  const h = harness((path) => ({ statusCode: 200, data: path === '/auth/wechat-sessions' ? session : account }))
  await h.client.bootstrap()
  h.client.signOut()
  await h.client.signIn()
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.manualLoginRequired, false)
  const restarted = h.restart()
  await restarted.bootstrap()
  assert.equal(restarted.getSnapshot().status, 'authenticated')
  assert.equal(h.loginCount, 1)
  assert.equal(h.requests.at(-1).accessToken, credential.accessToken)
})
test('failed manual login does not re-enable automatic login on restart', async () => {
  const h = harness(() => ({ statusCode: 503, data: { code: 'wechat_unavailable' } }), null, true)
  await h.client.signIn()
  assert.equal(h.client.getSnapshot().status, 'error')
  assert.equal(h.manualLoginRequired, true)
  const restarted = h.restart()
  await restarted.bootstrap()
  assert.equal(restarted.getSnapshot().status, 'anonymous')
  assert.equal(h.loginCount, 1)
  assert.equal(h.requests.length, 1)
})
test('logout during login rejects a late session and preserves logout on restart', async () => {
  let release
  let started
  const requestStarted = new Promise((resolve) => {
    started = resolve
  })
  const h = harness(
    () =>
      new Promise((resolve) => {
        release = resolve
        started()
      }),
    null,
  )
  const login = h.client.signIn()
  await requestStarted
  h.client.signOut()
  release({ statusCode: 200, data: session })
  await login
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.saved.length, 0)
  assert.equal(h.manualLoginRequired, true)
  const restarted = h.restart()
  await restarted.bootstrap()
  assert.equal(restarted.getSnapshot().status, 'anonymous')
  assert.equal(h.loginCount, 1)
})
test('successful registration clears a previous logout requirement', async () => {
  const h = harness(() => ({ statusCode: 201, data: session }), null, true)
  await h.client.register({ nickname: '顾客', phone: '13800135678', privacyContractVersion: 'v1' })
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.manualLoginRequired, false)
  assert.deepEqual(h.stored, credential)
})

test('profile avatar is sent only when edited and follows the server response', async () => {
  let current = { ...account, avatarDataUrl: 'data:image/jpeg;base64,original' }
  const h = harness((_path, options) => {
    if (options.method === 'PATCH')
      current = {
        ...current,
        nickname: options.data.nickname,
        ...(options.data.avatarDataUrl !== undefined
          ? { avatarDataUrl: options.data.avatarDataUrl ? 'data:image/jpeg;base64,normalized' : undefined }
          : {}),
      }
    return { statusCode: 200, data: current }
  })
  await h.client.bootstrap()
  await h.client.updateProfile({ nickname: '修改昵称' })
  assert.equal(Object.hasOwn(h.requests.at(-1).data, 'avatarDataUrl'), false)
  assert.equal(h.client.getSnapshot().account!.avatarDataUrl, 'data:image/jpeg;base64,original')
  await h.client.updateProfile({ nickname: '修改头像', avatarDataUrl: 'data:image/png;base64,input' })
  assert.equal(h.requests.at(-1).data.avatarDataUrl, 'data:image/png;base64,input')
  assert.equal(h.client.getSnapshot().account!.avatarDataUrl, 'data:image/jpeg;base64,normalized')
  await h.client.updateProfile({ nickname: '清除头像', avatarDataUrl: '' })
  assert.equal(h.requests.at(-1).data.avatarDataUrl, '')
  assert.equal(h.client.getSnapshot().account!.avatarDataUrl, undefined)
})

// 改手机号原先只能手输，写进去一律「未验证」，那个标签就摘不掉了。
// 微信授权换号走 phoneCode，和注册同一条路；两个一起给要在本地就拦住。
test('a profile update carries either a typed phone or a WeChat phone code, never both', async () => {
  const h = harness((_path, options) =>
    options.method === 'PATCH' && options.data.phoneCode
      ? { statusCode: 200, data: { ...account, phoneVerificationStatus: 'verified' } }
      : options.method === 'PATCH'
        ? { statusCode: 200, data: { ...account, phoneVerificationStatus: 'unverified' } }
        : { statusCode: 200, data: account },
  )
  await h.client.bootstrap()

  await h.client.updateProfile({ nickname: '我', phone: '13900139000' })
  assert.equal(h.requests.at(-1).data.phone, '13900139000')
  assert.equal(Object.hasOwn(h.requests.at(-1).data, 'phoneCode'), false)
  assert.equal(h.client.getSnapshot().account!.phoneVerificationStatus, 'unverified')

  await h.client.updateProfile({ nickname: '我', phoneCode: 'wx-code' })
  assert.equal(h.requests.at(-1).data.phoneCode, 'wx-code')
  assert.equal(Object.hasOwn(h.requests.at(-1).data, 'phone'), false)
  assert.equal(h.client.getSnapshot().account!.phoneVerificationStatus, 'verified')

  const before = h.requests.length
  await assert.rejects(() => h.client.updateProfile({ nickname: '我', phone: '13900139000', phoneCode: 'wx-code' }))
  assert.equal(h.requests.length, before, '本地就该拦住，不该发出去让后端 400')
})

test('restores only credential metadata and refreshes the account', async () => {
  const h = harness()
  await h.client.bootstrap()
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.loginCount, 0)
  assert.equal(h.requests[0].path, `/accounts/${accountId}`)
  assert.equal(h.sessionCreatedCount, 0)
  assert.equal(h.requests[0].accessToken, credential.accessToken)
})
test('unregistered identity becomes registration state, without retaining login code', async () => {
  const h = harness(() => ({ statusCode: 404, data: { code: 'not_registered' } }), null)
  await h.client.bootstrap()
  await h.client.signIn()
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.saved.length, 0)
  assert.equal(h.requests[0].accessToken, undefined)
  assert.equal(h.sessionCreatedCount, 0)
})
test('registration gets a fresh login code and stores no phone or profile', async () => {
  const h = harness(
    () => ({ statusCode: 201, data: { ...session, user: { ...account, phoneVerificationStatus: 'unverified' } } }),
    null,
  )
  await h.client.register({ nickname: '  新顾客  ', phone: '13800135678', privacyContractVersion: 'v1' })
  assert.equal(h.requests[0].data.nickname, '新顾客')
  assert.equal(h.requests[0].data.wechatLoginCode, 'fresh-code-1')
  assert.equal(h.requests[0].data.phoneCode, undefined)
  assert.equal(Object.hasOwn(h.requests[0].data, 'avatarDataUrl'), false)
  assert.deepEqual(h.saved[0], credential)
  assert.equal(h.client.getSnapshot().account!.phoneVerificationStatus, 'unverified')
  assert.equal(h.sessionCreatedCount, 1)
})
test('registration saves an optional avatar in the same request and uses the normalized account', async () => {
  const normalized = 'data:image/jpeg;base64,normalized'
  const h = harness(
    () => ({ statusCode: 201, data: { ...session, user: { ...account, avatarDataUrl: normalized } } }),
    null,
  )
  await h.client.register({
    nickname: '顾客',
    phone: '13800135678',
    privacyContractVersion: 'v1',
    avatarDataUrl: 'data:image/png;base64,selected',
  })
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].path, '/accounts')
  assert.equal(h.requests[0].data.avatarDataUrl, 'data:image/png;base64,selected')
  assert.equal(h.client.getSnapshot().account!.avatarDataUrl, normalized)
  assert.deepEqual(h.saved[0], credential)
})
test('rejected registration avatar does not establish a session and can be omitted on retry', async () => {
  const h = harness(
    (_path, options) =>
      options.data.avatarDataUrl
        ? { statusCode: 400, data: { code: 'invalid_avatar' } }
        : { statusCode: 201, data: session },
    null,
    true,
  )
  await h.client.bootstrap()
  const input = { nickname: '顾客', phone: '13800135678', privacyContractVersion: 'v1' }
  await assert.rejects(
    h.client.register({ ...input, avatarDataUrl: 'bad-image' }),
    (error: any) => error.code === 'invalid_avatar',
  )
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.equal(h.saved.length, 0)
  assert.equal(h.manualLoginRequired, true)
  await h.client.register(input)
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.requests[1].data.wechatLoginCode, 'fresh-code-2')
  assert.equal(Object.hasOwn(h.requests[1].data, 'avatarDataUrl'), false)
})
test('phone authorization uses code alone and trusts server verification result', async () => {
  const h = harness(() => ({ statusCode: 201, data: session }), null)
  await h.client.register({ nickname: '顾客', phoneCode: 'one-use-phone-code', privacyContractVersion: 'v1' })
  assert.equal(h.requests[0].data.phone, undefined)
  assert.equal(h.client.getSnapshot().account!.phoneVerificationStatus, 'verified')
})
test('invalid phone sources or missing agreement cannot submit registration', async () => {
  const h = harness()
  for (const input of [
    { nickname: '顾客', privacyContractVersion: 'v1' },
    { nickname: '顾客', phone: '13800135678', phoneCode: 'code', privacyContractVersion: 'v1' },
    { nickname: ' ', phone: '13800135678', privacyContractVersion: 'v1' },
    { nickname: '顾客', phone: 'bad', privacyContractVersion: 'v1' },
    { nickname: '顾客', phone: '13800135678', privacyContractVersion: '' },
  ]) {
    await assert.rejects(h.client.register(input), (error: any) => error.code === 'invalid_request')
  }
  assert.equal(h.requests.length, 0)
})
test('queries own order resource and rejects mismatched ownership even for staff', async () => {
  const h = harness((path) => ({
    statusCode: 200,
    data: path.endsWith('sales-orders')
      ? [order]
      : path.startsWith('/sales-orders/')
        ? { ...order, accountId: 'other' }
        : { ...account, roles: ['owner'] },
  }))
  await h.client.bootstrap()
  assert.deepEqual(await h.client.listOrders(), [order])
  assert.equal(h.requests[1].path, `/accounts/${accountId}/sales-orders`)
  await assert.rejects(h.client.getOrder(orderId), (error: any) => error.status === 403)
  await assert.rejects(h.client.getOrder('../accounts'), (error: any) => error.status === 404)
})
test('expired server session clears credentials and returns anonymous', async () => {
  const h = harness((path) =>
    path.endsWith('sales-orders')
      ? { statusCode: 401, data: { code: 'unauthorized' } }
      : { statusCode: 200, data: account },
  )
  await h.client.bootstrap()
  await assert.rejects(h.client.listOrders(), (error: any) => error.status === 401)
  assert.equal(h.client.getSnapshot().account, null)
  assert.equal(h.client.getSnapshot().status, 'anonymous')
  assert.ok(h.clearCount)
  const restarted = h.restart()
  await restarted.bootstrap()
  assert.equal(restarted.getSnapshot().status, 'anonymous')
  assert.equal(h.loginCount, 0)
})
test('logout discards in-flight account and order responses', async () => {
  let release
  const h = harness((path) =>
    path.endsWith('sales-orders')
      ? new Promise((resolve) => {
          release = resolve
        })
      : { statusCode: 200, data: account },
  )
  await h.client.bootstrap()
  const request = h.client.listOrders()
  h.client.signOut()
  release({ statusCode: 200, data: [order] })
  await assert.rejects(request, (error: any) => error.code === 'cancelled')
  assert.equal(h.client.getSnapshot().account, null)
})
test('profile edit omits unchanged masked phone and preserves verification', async () => {
  const h = harness((_path, options) => ({
    statusCode: 200,
    data: options.method === 'PATCH' ? { ...account, nickname: options.data.nickname } : account,
  }))
  await h.client.bootstrap()
  await h.client.updateProfile({ nickname: '新昵称' })
  assert.deepEqual(h.requests[1].data, { nickname: '新昵称' })
  assert.equal(h.client.getSnapshot().account!.phoneVerificationStatus, 'verified')
})
test('network errors never expose raw response or sensitive payload', async () => {
  const h = harness(() => {
    throw new Error('secret phone 13800135678')
  })
  await h.client.bootstrap()
  assert.equal(h.client.getSnapshot().status, 'error')
  assert.equal(h.client.getSnapshot().error.includes('13800135678'), false)
})
test('money formatting preserves integer cents including safe integer limit', () => {
  assert.equal(money(0), '0.00')
  assert.equal(money(1), '0.01')
  assert.equal(money(12800), '128.00')
  assert.equal(money(-123), '-1.23')
  assert.equal(money(Number.MAX_SAFE_INTEGER), '90071992547409.91')
  assert.equal(money(1.5), '--')
})
// 分笔付款收了一部分的单（partially_paid）是正常的订单：顾客的订单列表与详情照常显示，不当成坏数据。
test('a partially paid order passes the order check; unknown statuses still do not', async () => {
  const partial = {
    ...order,
    status: 'partially_paid',
    paidCents: 1000,
    outstandingCents: 1990,
    payments: [{ id: 'p1', method: 'wechat', amountCents: 1000, createdAt: '2026-10-06T02:00:00Z' }],
  }
  const h = harness((path) => ({
    statusCode: 200,
    data: path.endsWith('sales-orders') ? [partial] : path.startsWith('/sales-orders/') ? partial : account,
  }))
  await h.client.bootstrap()
  assert.deepEqual(await h.client.listOrders(), [partial])
  assert.equal((await h.client.getOrder(orderId)).status, 'partially_paid')
  const odd = harness((path) => ({
    statusCode: 200,
    data: path.endsWith('sales-orders') ? [{ ...order, status: 'mystery' }] : account,
  }))
  await odd.client.bootstrap()
  await assert.rejects(odd.client.listOrders(), CustomerError)
})

// 订单卡片与详情上那一个金额：待结账写应收，部分付款写已付和还差多少（接口给的数），已付写实付，整单免单注明。
test('order amount: receivable for drafts, paid and still owed for partial payments', async () => {
  const { orderAmount, isOpenOrder, pendingAmount, orderLabels } = await import('../src/services/format')
  assert.deepEqual(orderAmount({ status: 'draft', receivableCents: 2990, paidCents: 0 }), {
    label: '应收金额',
    cents: 2990,
  })
  assert.deepEqual(
    orderAmount({ status: 'partially_paid', receivableCents: 2990, paidCents: 1000, outstandingCents: 1990 }),
    { label: '已付金额（部分付款，还差 ¥19.90）', cents: 1000 },
  )
  assert.deepEqual(orderAmount({ status: 'paid', receivableCents: 2990, paidCents: 0, settlement: 'comp' }), {
    label: '实付金额（已免单）',
    cents: 0,
  })
  assert.equal(orderLabels.partially_paid, '部分付款')
  assert.ok(isOpenOrder({ status: 'partially_paid' }) && isOpenOrder({ status: 'draft' }))
  assert.equal(isOpenOrder({ status: 'paid' }), false)
  assert.deepEqual(
    pendingAmount({ status: 'partially_paid', receivableCents: 2990, paidCents: 1000, outstandingCents: 1990 }),
    {
      cents: 1990,
      label: '部分付款 · 还差',
      text: '部分付款，还差 19.90 元',
    },
  )
  assert.equal(pendingAmount({ status: 'draft', receivableCents: 2990, paidCents: 0 }).label, '应收')
})
test('unsafe order amounts are rejected before rendering', async () => {
  const h = harness((path) => ({
    statusCode: 200,
    data: path.endsWith('sales-orders') ? [{ ...order, paidCents: 1.25 }] : account,
  }))
  await h.client.bootstrap()
  await assert.rejects(h.client.listOrders(), CustomerError)
})

// 主动退出要让服务端作废这张令牌（否则它还能用到过期）；网络失败也照样在本地退出。
test('manual logout revokes the server session without waiting for it', async () => {
  for (const failing of [false, true]) {
    const h = harness((_path, options) => {
      if (options.method === 'DELETE') {
        if (failing) throw new Error('offline')
        return { statusCode: 204, data: null }
      }
      return { statusCode: 200, data: account }
    })
    await h.client.bootstrap()
    const token = h.stored.accessToken
    h.client.logOut()
    assert.equal(h.client.getSnapshot().status, 'anonymous')
    assert.equal(h.stored, null)
    assert.equal(h.manualLoginRequired, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const revoke = h.requests.find((request) => request.method === 'DELETE')
    assert.equal(revoke?.path, '/auth/sessions/current')
    assert.equal(revoke?.accessToken, token)
  }
})

test('认领会员用新的微信登录码，成功后保存会话并回到登录前目标；失败不创建本地会话', async () => {
  const h = harness(
    (path) => ({
      statusCode: path === '/auth/member-claims' ? 201 : 200,
      data: path === '/auth/member-claims' ? session : account,
    }),
    null,
  )
  await h.client.claimMember({ phone: '138-0000-5678', password: '12345678', privacyContractVersion: 'privacy-v1' })
  assert.deepEqual(h.requests[0].data, {
    phone: '13800005678',
    password: '12345678',
    privacyContractVersion: 'privacy-v1',
    wechatLoginCode: 'fresh-code-1',
  })
  assert.equal(h.requests[0].path, '/auth/member-claims')
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.saved.length, 1)
  assert.equal(h.sessionCreatedCount, 1)
  const failed = harness(() => ({ statusCode: 401, data: { code: 'invalid_credentials' } }), null)
  await assert.rejects(
    failed.client.claimMember({ phone: '13800005678', password: 'bad', privacyContractVersion: 'privacy-v1' }),
    (e) => e instanceof CustomerError && e.code === 'invalid_credentials',
  )
  assert.equal(failed.saved.length, 0)
})

test('认领成功可保存会话但不跳转，让页面展示欢迎与历史资产', async () => {
  const h = harness(() => ({ statusCode: 200, data: session }), null)
  await h.client.claimMember(
    { phone: '13800005678', password: '12345678', privacyContractVersion: 'privacy-v1' },
    false,
  )
  assert.equal(h.client.getSnapshot().status, 'authenticated')
  assert.equal(h.saved.length, 1)
  assert.equal(h.sessionCreatedCount, 0)
})

test('代开和认领的手机号规则：去掉空格横线，接受 6 至 15 位数字和开头的加号', async () => {
  const { loginPhoneIsValid } = await import('../src/services/customer')
  assert.equal(loginPhoneIsValid('123-456'), true)
  assert.equal(loginPhoneIsValid('+86 138-0000-5678'), true)
  for (const phone of ['12345', '1'.repeat(16), 'abc123456', '123+456']) assert.equal(loginPhoneIsValid(phone), false)
})
