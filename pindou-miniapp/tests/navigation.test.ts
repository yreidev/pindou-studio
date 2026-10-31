import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, vi } from 'vitest'
import { load, src } from './helpers/load'

type Navigation = typeof import('../src/services/navigation')

async function navigation(pages: any[], backFails = false, destinationFails = false, confirmed = false) {
  const calls: any[] = []
  const taro = {
    getCurrentPages: () => pages,
    navigateBack: async () => {
      calls.push(['back'])
      if (backFails) throw new Error('empty stack')
    },
    switchTab: async ({ url }) => {
      calls.push(['tab', url])
      if (destinationFails) throw new Error('failed')
    },
    redirectTo: async ({ url }) => {
      calls.push(['redirect', url])
      if (destinationFails) throw new Error('failed')
    },
    navigateTo: async ({ url }) => {
      calls.push(['navigate', url])
      if (destinationFails) throw new Error('failed')
    },
    showModal: async () => {
      calls.push(['confirm'])
      return { confirm: confirmed }
    },
    showToast: (options) => {
      calls.push(['toast', options.title])
    },
  }
  // 导航只依赖 Taro：这里只替换了 Taro，别的依赖混进来就不再是被测的这一份行为
  const source = fs.readFileSync(path.join(src, 'services/navigation.ts'), 'utf8')
  for (const [, name] of source.matchAll(/^import .* from '([^']+)'/gm)) assert.equal(name, '@tarojs/taro')
  // 每次都是新装载的模块：登录目标、离开保护是模块级状态，不能从上一个用例漏过来
  const exports = await load<Navigation>('services/navigation.ts', { '@tarojs/taro': { default: taro } })
  return { ...exports, calls }
}

// TEST-USER-001 / TEST-ROLE-001 / TEST-SESSION-001 / TEST-ORDER-001.
test('new-session navigation opens home and navigation failure does not reject login', async () => {
  const h = await navigation([{ route: 'pages/orders/index' }])
  await h.openHome()
  assert.deepEqual(h.calls, [['tab', '/pages/index/index']])
  const failed = await navigation([], false, true)
  await failed.openHome()
  assert.equal(failed.calls.at(-1)[0], 'toast')
})
test('platform wires accepted sessions to the one-time login destination', async () => {
  let port,
    navigations = 0
  await load('services/platform.ts', {
    '@tarojs/taro': { default: {} },
    './customer': {
      CustomerClient: class {
        constructor(value) {
          port = value
        }
      },
    },
    './navigation': {
      completeLogin: () => {
        navigations++
      },
      clearLoginTarget: () => {},
    },
  })
  assert.equal(navigations, 0)
  port.onSessionCreated()
  assert.equal(navigations, 1)
})

// 把 app.config.ts 真跑一遍取出全部页面路径。
//
// ★ 不能再用正则抓 `'pages/...'`：2026-09-19 做分包之后，分包页在配置里写的是**相对
//   subPackages[].root 的路径**（`'membership/index'`），正则抓不到，这条断言会从 23
//   掉到 13 —— 也就是 10 个员工页和开发者页悄悄失去「有没有兜底页」的保护。
//   真正的页面路径是 root + '/' + page，必须按微信的拼接规则还原。
async function registeredRoutes() {
  // Taro 的编译期全局：运行时不存在，这里原样返回配置对象即可。
  vi.stubGlobal('defineAppConfig', (config) => config)
  try {
    const { default: config } = await load('app.config.ts', { './brand': { brandName: '（测试）' } })
    const sub = (config.subPackages ?? []).flatMap((pkg) =>
      pkg.pages.map((page) => `${pkg.root.replace(/\/$/, '')}/${page}`),
    )
    return [...new Set<string>([...config.pages, ...sub])]
  } finally {
    vi.unstubAllGlobals()
  }
}

test('消息和消费详情已登记，入口保留详情编号并有返回落点', async () => {
  const h = await navigation([])
  assert.equal(h.sanitizeTarget('/pages/customer/messages/index'), '/pages/customer/messages/index')
  const routes = await registeredRoutes()
  for (const page of ['messages', 'consumption-detail']) assert.ok(routes.includes(`pages/customer/${page}/index`))
  assert.equal(h.sanitizeTarget('/pages/customer/messages/index'), '/pages/customer/messages/index')
  assert.equal(
    h.sanitizeTarget('/pages/customer/consumption-detail/index?id=entry-1&token=secret'),
    '/pages/customer/consumption-detail/index?id=entry-1',
  )
  assert.equal(h.fallbackPage('pages/customer/messages/index'), '/pages/profile/index')
  assert.equal(h.fallbackPage('pages/customer/consumption-detail/index'), '/pages/customer/membership/index')
})

// ★ 加了页面、加进了导航菜单，却忘了加进 sanitizeTarget 的白名单 —— 点菜单直接弹回首页，
//   不报错、不提示，看起来像「这个功能没做」。2026-09-20 桌码页就是这么坏的。
//   凡是能从员工导航点到的页面，都必须是可导航的。
test('every staff destination is actually navigable', async () => {
  const { sanitizeTarget } = await navigation([])
  const { staffDestinations } =
    await load<typeof import('../src/services/staff-navigation')>('services/staff-navigation.ts')
  for (const { page, label } of staffDestinations(['owner'])) {
    const target = `/pages/staff/${page}/index`
    assert.equal(sanitizeTarget(target), target, `导航里有「${label}」却导航不过去，会静默弹回首页`)
  }
})

// 底部四格固定是现场 / 桌位 / 预约 / 会员（2026-10-20 重做）；系统内收费关着（2026-10-10 起，钱在美团、大众点评收）时
// 没有待结账可收，侧栏里也不留「待结账」。
test('员工底部四格是现场、桌位、预约、会员；收费关着时没有待结账', async () => {
  const { staffDestinations, staffTabs } =
    await load<typeof import('../src/services/staff-navigation')>('services/staff-navigation.ts')
  const pages = (billing: boolean) => staffDestinations(['clerk'], billing).map((link) => link.label)
  assert.deepEqual(pages(true).slice(0, 4), ['现场', '桌位', '预约', '会员'])
  assert.deepEqual(pages(false).slice(0, 4), ['现场', '桌位', '预约', '会员'])
  assert.deepEqual(staffTabs, ['workbench', 'tables', 'reservations', 'membership'])
  assert.ok(pages(true).includes('待结账'))
  assert.equal(pages(false).includes('待结账'), false)
  assert.ok(pages(true).includes('连电脑'))
})

test('every registered page has an intentional fallback and never defaults to customer orders', async () => {
  const { fallbackPage } = await navigation([])
  const routes = await registeredRoutes()
  // 这个数字是故意钉死的：加页面就必须回来想清楚它退到哪里去。
  assert.equal(routes.length, 29)
  // 分包页的路径必须是 root + page 拼出来的完整路径；只拿到相对路径的话下面的断言
  // 会全部“恰好通过”（fallbackPage 认不出 pages/staff/ 前缀，一律退首页也不报错）。
  for (const route of routes) assert.match(route, /^pages\/[\w-]+\/(?:[\w-]+\/)?index$/, route)
  for (const route of routes) {
    const target = fallbackPage(route)
    assert.notEqual(target, '/pages/orders/index', route)
    assert.ok(routes.includes(target.slice(1)), `${route}: missing destination`)
    assert.equal(fallbackPage(`/${route}?id=test`), target)
  }
  assert.equal(fallbackPage('pages/customer/profile-edit/index'), '/pages/profile/index')
  assert.equal(fallbackPage('pages/staff/workbench/index'), '/pages/profile/index')
  assert.equal(fallbackPage('pages/staff/web-login/index'), '/pages/staff/workbench/index')
  assert.equal(fallbackPage('pages/staff/tables/index'), '/pages/staff/workbench/index')
  assert.equal(fallbackPage('pages/staff/booking/index'), '/pages/staff/reservations/index')
  assert.equal(fallbackPage('pages/staff/checkout/index'), '/pages/staff/orders/index')
  assert.equal(fallbackPage('pages/customer/reservations/index'), '/pages/index/index')
  assert.equal(fallbackPage('pages/customer/my-reservations/index'), '/pages/profile/index')
  assert.equal(fallbackPage('pages/staff/reservations/index'), '/pages/staff/workbench/index')
  assert.equal(fallbackPage('pages/staff/receiving/index'), '/pages/staff/workbench/index')
  assert.equal(fallbackPage('pages/maker/pattern/index'), '/pages/maker/mine/index')
  assert.equal(fallbackPage('pages/maker/import/index'), '/pages/maker/mine/index')
  assert.equal(fallbackPage('pages/maker/mine/index'), '/pages/patterns/index')
  assert.equal(fallbackPage('pages/maker/photo/index'), '/pages/patterns/index')
  // 开台页、会话页、扫码给电脑三页 2026-10-20 删了：开台、会话是桌位页的弹层，扫码给电脑并进「连电脑」
  for (const gone of ['session-start', 'session-detail', 'scan-relay'])
    assert.equal(routes.includes(`pages/staff/${gone}/index`), false, gone)
})
test('return uses real history when it exists', async () => {
  const h = await navigation([{ route: 'pages/orders/index' }, { route: 'pages/customer/order-detail/index' }])
  await h.returnToPreviousPage()
  assert.deepEqual(h.calls, [['back']])
})
test('direct entry and failed native back choose the correct native navigation method', async () => {
  const profile = await navigation([{ route: 'pages/customer/profile-edit/index' }])
  await profile.returnToPreviousPage()
  assert.deepEqual(profile.calls, [['tab', '/pages/profile/index']])
  const staff = await navigation([{ route: 'pages/staff/checkout/index' }])
  await staff.returnToPreviousPage()
  assert.deepEqual(staff.calls, [['redirect', '/pages/staff/orders/index']])
  const failed = await navigation([{}, { route: 'pages/staff/booking/index' }], true)
  await failed.returnToPreviousPage()
  assert.deepEqual(failed.calls, [['back'], ['redirect', '/pages/staff/reservations/index']])
  const empty = await navigation([])
  await empty.returnToPreviousPage()
  assert.deepEqual(empty.calls, [['tab', '/pages/index/index']])
})
test('navigation failure does not turn a completed business operation into a failed one', async () => {
  const h = await navigation([{ route: 'pages/staff/checkout/index' }], false, true)
  await h.returnToPreviousPage()
  assert.equal(h.calls.at(-1)[0], 'toast')
})

test('login consumes only the explicit destination once, then defaults to home', async () => {
  const h = await navigation([])
  await h.beginLogin('/pages/orders/index')
  await h.completeLogin()
  await h.completeLogin()
  assert.deepEqual(h.calls, [
    ['navigate', '/pages/register/index'],
    ['tab', '/pages/orders/index'],
    ['tab', '/pages/index/index'],
  ])
})
test('login cancellation and failure cannot retain an old destination', async () => {
  const h = await navigation([])
  await h.beginLogin('/pages/staff/tables/index')
  h.clearLoginTarget()
  await h.completeLogin()
  assert.deepEqual(h.calls.at(-1), ['tab', '/pages/index/index'])
  const failed = await navigation([], false, true)
  await failed.beginLogin('/pages/orders/index')
  await failed.completeLogin()
  assert.ok(failed.calls.some(([type, url]) => type === 'tab' && url === '/pages/index/index'))
})
test('login targets reject external URLs and unknown paths, strip unrelated parameters', async () => {
  const h = await navigation([])
  for (const input of [
    'https://example.com',
    '//example.com',
    '/pages/register/index',
    '/pages/unknown/index',
    '/pages/staff/qr-approve/index?challengeId=old',
    '/pages/orders/index#old',
  ])
    assert.equal(h.sanitizeTarget(input), '/pages/index/index')
  assert.equal(
    h.sanitizeTarget('/pages/customer/order-detail/index?id=abc-123&token=secret&returnTo=evil'),
    '/pages/customer/order-detail/index?id=abc-123',
  )
  assert.equal(h.sanitizeTarget('/pages/orders/index?id=stale'), '/pages/orders/index')
  assert.equal(h.sanitizeTarget('/pages/customer/order-detail/index?id=%ZZ'), '/pages/index/index')
  // 在「我的预约」页登录后回到这一页，不是首页
  assert.equal(h.sanitizeTarget('/pages/customer/my-reservations/index'), '/pages/customer/my-reservations/index')
})
test('protected employee login destinations remain employee routes for authorization boundary', async () => {
  const h = await navigation([])
  await h.beginLogin('/pages/staff/checkout/index?id=order-1')
  await h.completeLogin()
  assert.deepEqual(h.calls.at(-1), ['redirect', '/pages/staff/checkout/index?id=order-1'])
})
// 库存、订单管理搬去电脑后台之后，员工页不再接受 filter 参数：待结账页只列待结账，不用筛。
// 登录后回到原目标时，不认识的参数（包括令牌）一律丢掉。
test('staff shortcuts survive login and discard parameters the page does not take', async () => {
  const h = await navigation([])
  await h.beginLogin('/pages/staff/orders/index?filter=draft&token=secret')
  await h.completeLogin()
  assert.deepEqual(h.calls.at(-1), ['redirect', '/pages/staff/orders/index'])
  for (const page of ['inventory', 'operations', 'roles', 'table-codes'])
    assert.equal(h.sanitizeTarget(`/pages/staff/${page}/index`), '/pages/index/index', `${page} 已删除，不能再导航过去`)
  assert.equal(h.sanitizeTarget('/pages/staff/tables/index?filter=low'), '/pages/staff/tables/index')
})
test('shortcut navigation failure is reported to the user', async () => {
  const h = await navigation([], false, true)
  assert.equal(await h.navigateApp('/pages/staff/orders/index', true), false)
  assert.deepEqual(h.calls[0], ['redirect', '/pages/staff/orders/index'])
  assert.equal(h.calls.at(-1)[0], 'toast')
})
test('dirty form cancellation blocks navigation, confirmation allows it, submission blocks it', async () => {
  const pages = [{ route: 'pages/customer/profile-edit/index' }]
  const cancelled = await navigation(pages)
  cancelled.registerLeaveGuard('/pages/customer/profile-edit/index', () => ({ dirty: true, busy: false }))
  await cancelled.returnToPreviousPage()
  assert.deepEqual(cancelled.calls, [['confirm']])
  const accepted = await navigation(pages, false, false, true)
  const clear = accepted.registerLeaveGuard('/pages/customer/profile-edit/index', () => ({ dirty: true, busy: false }))
  await accepted.returnToPreviousPage()
  assert.deepEqual(accepted.calls, [['confirm'], ['tab', '/pages/profile/index']])
  clear()
  await accepted.returnToPreviousPage()
  assert.deepEqual(accepted.calls.at(-1), ['tab', '/pages/profile/index'])
  const busy = await navigation(pages)
  busy.registerLeaveGuard('/pages/customer/profile-edit/index', () => ({ dirty: false, busy: true }))
  await busy.navigateApp('/pages/index/index')
  assert.equal(busy.calls[0][0], 'toast')
  assert.equal(busy.calls.length, 1)
})

// 登录页上那一句「登录后接着……」：按登录目标说回到哪件事，回首页、图纸或直接打开登录页的不写
test('the login page says where it goes back to after signing in', async () => {
  const reservations = await load('services/reservations.ts', {
    './customer': { CustomerError: class extends Error {} },
    './staff': { request: async () => ({}) },
    './format': await load('services/format.ts'),
  })
  const { loginHint } = await load<typeof import('../src/services/login-hint')>('services/login-hint.ts', {
    './reservations': reservations,
  })
  const { membershipName } = await load('brand.ts')
  const now = new Date('2026-10-20T02:00:00Z')
  const at = Date.parse('2026-10-20T06:00:00Z') / 1000
  assert.equal(loginHint(`/pages/customer/reservations/index?at=${at}`, now), '登录后接着预约今天 14:00')
  assert.equal(loginHint('/pages/customer/reservations/index?at=x', now), '登录后接着预约座位')
  assert.equal(loginHint('/pages/customer/experience/index?tableId=t1', now), '登录后接着本次手作')
  assert.equal(loginHint('/pages/customer/membership/index', now), `登录后打开${membershipName}`)
  assert.equal(loginHint('/pages/staff/web-login/index?id=w1', now), '登录后接着登录电脑')
  assert.equal(loginHint('/pages/staff/tables/index', now), '登录后回到员工页面')
  for (const target of [undefined, '', '/pages/index/index', '/pages/patterns/index'])
    assert.equal(loginHint(target, now), '', String(target))
})

// 员工底部导航的待办数：现场＝没人认领的呼叫＋等确认的扫码入座＋快到点和已超时的桌＋顾客今天取消了还没人点「知道了」的；
// 预约＝等确认的加过了时间还没来的。
// ★ 看 displayStatus 不看 status：过期的申请 status 永远停在 pending。
test('staff navigation badges count what still needs someone', async () => {
  const { staffBadges } = await load<typeof import('../src/hooks/staff-overview')>('hooks/staff-overview.ts', {
    './query': { useStaffQuery() {} },
    '../services/staff': { staffApi: {} },
    '../services/membership': { loyalty: {} },
    '../services/reservations': { reservations: {} },
    '../services/service-calls': {
      needsAlert: (call: { claimStatus: string }) => call.claimStatus !== 'claimed',
      serviceCalls: {},
    },
    '../services/timing-alerts': { timingAlerts: (tables: { alert?: boolean }[]) => tables.filter((t) => t.alert) },
  })
  const overview: any = {
    tables: [{ alert: true }, {}, { alert: true }],
    sessions: [],
    shift: {
      admissions: [{ displayStatus: 'pending' }, { displayStatus: 'expired' }, { displayStatus: 'confirmed' }],
      tables: [],
    },
    reservations: [{ displayStatus: 'pending' }, { displayStatus: 'expired' }, { displayStatus: 'confirmed' }],
    // 接口只下发今天被顾客取消、还没人点「知道了」的，有几条算几条
    cancellations: [{ displayStatus: 'cancelled' }],
    orders: [],
  }
  const calls: any = [{ claimStatus: 'none' }, { claimStatus: 'claimed' }, { claimStatus: 'lapsed' }]
  assert.deepEqual(staffBadges(overview, calls, Date.now()), { workbench: 6, reservations: 2 })
  assert.deepEqual(staffBadges(null, null, Date.now()), { workbench: 0, reservations: 0 })
})

test('认领会员入口保留手机号，拒绝多余参数', async () => {
  const h = await navigation([])
  const path = '/pages/customer/member-claim/index'
  assert.equal(h.sanitizeTarget(`${path}?phone=%2B8613800000000&token=secret`), `${path}?phone=%2B8613800000000`)
  assert.equal(h.sanitizeTarget(`${path}?phone=abc`), path)
})

test('认领页已登记，直接进入后返回登录', async () => {
  assert.equal((await registeredRoutes()).includes('pages/customer/member-claim/index'), true)
  const h = await navigation([{ route: 'pages/customer/member-claim/index' }])
  await h.returnToPreviousPage()
  assert.deepEqual(h.calls, [['redirect', '/pages/register/index']])
})

test('用认领替换登录页后，成功仍回到登录前的目标', async () => {
  const h = await navigation([])
  await h.beginLogin('/pages/customer/reservations/index?at=1792893600')
  await h.navigateApp('/pages/customer/member-claim/index?phone=13800005678', true)
  await h.completeLogin()
  assert.deepEqual(h.calls, [
    ['navigate', '/pages/register/index'],
    ['redirect', '/pages/customer/member-claim/index?phone=13800005678'],
    ['redirect', '/pages/customer/reservations/index?at=1792893600'],
  ])
})
