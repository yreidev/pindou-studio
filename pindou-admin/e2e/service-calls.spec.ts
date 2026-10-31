import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockApi, type MockHandler } from './mock-api'
import { orderListResult } from './order-list'

// 呼叫店员：看板侧栏第一格列出还没处理的呼叫，点「已处理」后按接口重读；提醒是全站的（features/service-calls/CallAlerts.tsx）：
// 停在哪一页、标签页在不在前台都提醒——右上角提示、提示音（默认开，打开页面后第一次点击才出声；默认一直响到有人处理，
// 每 4 秒一轮，最长 5 分钟）、系统通知（允许了才弹，页面不在眼前时）、标签页标题「(N) 新呼叫」。
// 这里换上假的 AudioContext 数响了几声、记每声的音量，假的 Notification 记弹了什么。
// 持续响铃按真实时间等，所以这几个用例慢一些。

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const call = (id: string, tableCode: string, seatNumber: number, nickname: string, createdAt: string) => ({
  id,
  venueSessionId: '00000000-0000-4000-8000-0000000000a1',
  serviceTableId: '00000000-0000-4000-8000-0000000000b1',
  tableCode,
  seatNumber,
  status: 'pending',
  displayStatus: 'pending',
  createdAt,
  handledAt: null,
  cooldownSeconds: 0,
  customer: { id: '00000000-0000-4000-8000-0000000000c1', nickname, phoneMasked: '138****8000' },
  handledBy: null,
  claimStatus: 'none' as 'none' | 'claimed' | 'lapsed',
  claimedAt: null as string | null,
  claimedBy: null as { id: string; nickname: string; phoneMasked: string } | null,
})

/** 登录的这位（signIn 的 u-owner）在网页上点「我去处理」时，后端记的认领人。 */
const me = { id: '00000000-0000-4000-8000-0000000000d1', nickname: '阿贝', phoneMasked: '139****0001' }
/** 另一位店员，在手机上点「我去处理」。 */
const zhou = { id: '00000000-0000-4000-8000-0000000000d2', nickname: '小周', phoneMasked: '139****0002' }

/** 看板其余几块读到的都是空的：这里只看呼叫栏。 */
const quietBoard: MockHandler = ({ method, path }) => {
  if (method !== 'GET') return undefined
  if (path === '/service-tables' || path === '/venue-sessions') return { status: 200, body: [] }
  if (path === '/loyalty/shift') return { status: 200, body: { admissions: [], tables: [] } }
  if (path === '/reservations/staff')
    return {
      status: 200,
      body: {
        reservations: [],
        busy: [],
        packages: [],
        tables: [],
        settings: {
          enabled: true,
          openMinute: 540,
          closeMinute: 1320,
          slotMinutes: 30,
          advanceDays: 7,
          leadMinutes: 30,
          graceMinutes: 30,
        },
        settingsVersion: 's1',
        version: 'r1',
      },
    }
  return undefined
}

/** 订单页读到的是空列表；数一数读了几次（后台时别的资源事件不该让它重读）。 */
function quietOrders() {
  const state = { reads: 0 }
  const handler: MockHandler = ({ method, path, search }) => {
    if (method !== 'GET' || path !== '/sales-orders') return undefined
    state.reads++
    return orderListResult([], search)
  }
  return { state, handler }
}

/**
 * 模拟后端：只给 scope=open 的；标记已处理后那一条不再列出；「我去处理」记成阿贝认领，别人认领着时回 409「XX 已在处理」。
 * reads 数一数读了几次。
 */
function callsBackend(initial = [call('c1', 'B3', 2, '小林', minutesAgo(3))]) {
  const state = { open: initial, handled: [] as string[], claimed: [] as string[], reads: 0 }
  const handler: MockHandler = ({ method, path, search }) => {
    if (method === 'GET' && path === '/service-calls') {
      state.reads++
      return search.get('scope') === 'open'
        ? { status: 200, body: state.open }
        : { status: 400, body: { code: 'invalid_request', message: 'scope 只能是 open', requestId: 'mock' } }
    }
    const claimed = /^\/service-calls\/([^/]+)\/claim$/.exec(path)
    if (method === 'POST' && claimed) {
      const target = state.open.find((c) => c.id === claimed[1])
      if (!target) return { status: 404, body: { code: 'not_found', message: '呼叫不存在', requestId: 'mock' } }
      if (target.claimStatus === 'claimed' && target.claimedBy?.id !== me.id)
        return {
          status: 409,
          body: { code: 'service_call_claimed', message: `${target.claimedBy?.nickname} 已在处理`, requestId: 'mock' },
        }
      state.claimed.push(target.id)
      const next = { ...target, claimStatus: 'claimed' as const, claimedAt: new Date().toISOString(), claimedBy: me }
      state.open = state.open.map((c) => (c.id === target.id ? next : c))
      return { status: 200, body: next }
    }
    const handled = /^\/service-calls\/([^/]+)\/handle$/.exec(path)
    if (method === 'POST' && handled) {
      const target = state.open.find((c) => c.id === handled[1])
      if (!target) return { status: 404, body: { code: 'not_found', message: '呼叫不存在', requestId: 'mock' } }
      state.open = state.open.filter((c) => c.id !== target.id)
      state.handled.push(target.id)
      const by = { id: '00000000-0000-4000-8000-0000000000d1', nickname: '阿贝', phoneMasked: '139****0001' }
      return {
        status: 200,
        body: {
          ...target,
          status: 'handled',
          displayStatus: 'handled',
          handledAt: new Date().toISOString(),
          handledBy: by,
        },
      }
    }
    return undefined
  }
  return { state, handler }
}

interface FakeWindow {
  __beeps: number
  /** 每声渐入到的峰值增益（音量）。 */
  __peaks: number[]
  __notes: { title: string; body?: string; tag?: string; closed: boolean }[]
  __noteObjects: { onclick: ((event: Event) => void) | null }[]
  __permissionRequests: number
}

/**
 * 假的 WebAudio（数 oscillator.start 的次数，一声提示音是两下）和假的 Notification（记下弹了什么，授权状态由测试定）。
 * 每次加载页面（含刷新）都重新装上，计数从 0 开始。
 */
async function installFakes(page: Page, permission: NotificationPermission) {
  await page.addInitScript((initial) => {
    const w = window as unknown as FakeWindow & { AudioContext: unknown; Notification: unknown }
    w.__beeps = 0
    w.__peaks = []
    w.__notes = []
    w.__noteObjects = []
    w.__permissionRequests = 0
    w.AudioContext = class {
      state = 'suspended'
      currentTime = 0
      destination = {}
      async resume() {
        this.state = 'running'
      }
      async close() {
        this.state = 'closed'
      }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { value: 0 },
          connect: (node: unknown) => node,
          start: () => {
            w.__beeps++
          },
          stop: () => {},
        }
      }
      createGain() {
        let peaked = false
        return {
          gain: {
            setValueAtTime: () => {},
            // 先渐入到峰值、再渐出：第一次就是峰值
            exponentialRampToValueAtTime: (value: number) => {
              if (peaked) return
              peaked = true
              w.__peaks.push(value)
            },
          },
          connect: (node: unknown) => node,
        }
      }
    }
    class FakeNotification {
      static permission: NotificationPermission = initial
      static async requestPermission() {
        w.__permissionRequests++
        FakeNotification.permission = 'granted'
        return 'granted'
      }
      onclick: ((event: Event) => void) | null = null
      private readonly record: FakeWindow['__notes'][number]
      constructor(title: string, options: NotificationOptions = {}) {
        this.record = { title, body: options.body, tag: options.tag, closed: false }
        w.__notes.push(this.record)
        w.__noteObjects.push(this)
      }
      close() {
        this.record.closed = true
      }
    }
    w.Notification = FakeNotification
  }, permission)
}

const fakes = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as FakeWindow
    return { beeps: w.__beeps, peaks: w.__peaks, notes: w.__notes, permissionRequests: w.__permissionRequests }
  })
const beeps = async (page: Page) => (await fakes(page)).beeps

/** 持续响铃的间隔（features/service-calls/ringer.ts）。 */
const ringIntervalMs = 4_000

/** 等一个间隔多一点：这期间一声都没再响（铃声停了）。 */
async function expectQuiet(page: Page) {
  const before = await beeps(page)
  await page.waitForTimeout(ringIntervalMs + 1_000)
  expect(await beeps(page)).toBe(before)
}

/** 模拟切到别的标签页、切回来：改 visibilityState 并像浏览器一样派发 visibilitychange。 */
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/** 后端推一条「呼叫有变化」：和顾客在小程序里呼叫时一样。 */
async function pushCallsEvent(api: MockApi, resource = 'service-calls') {
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'resource.updated', resource }))
}

function watchProblems(page: Page) {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  return problems
}

const unlockHint = (page: Page) => page.locator('.call-alert-hint').getByText('点一下页面任意处开启提示音')
const callAlert = (page: Page) => page.locator('.semi-notification-notice')
const acknowledgeButton = (page: Page) => callAlert(page).getByRole('button', { name: '知道了' })

/** 从账户菜单打开「提醒设置」。 */
async function openSettingsFromMenu(page: Page) {
  await page.locator('.account-trigger').click()
  await page.getByRole('menuitem', { name: '提醒设置' }).click()
  const dialog = page.locator('.semi-modal-content')
  await expect(dialog.getByText('提醒设置', { exact: true })).toBeVisible()
  return dialog
}

/** 关上「提醒设置」（Semi 弹窗底部按钮的 aria-label 是英文 confirm，按文字找）。 */
async function closeSettings(page: Page) {
  await page.locator('.semi-modal button', { hasText: '完成' }).click()
  await expect(page.locator('.semi-modal-content')).toHaveCount(0)
}

test('看板的呼叫店员：看到哪桌哪座谁在叫；新呼叫默认一直响到有人处理，点「知道了」或在别处处理后停', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'default')
  const backend = callsBackend()
  const api = await mockApi(page, { handlers: [backend.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/board')

  const panel = page.locator('.service-calls-panel')
  await expect(panel.getByText('呼叫店员', { exact: true })).toBeVisible()
  await expect(panel.getByText('B3 桌 · 2 号座')).toBeVisible()
  await expect(panel.getByText('小林 · 3 分钟前')).toBeVisible()
  // 标题是 6 级标题，没处理的个数用徽标（同看板其他侧栏）
  await expect(panel.getByRole('heading', { name: '呼叫店员', level: 6 })).toBeVisible()
  await expect(panel.locator('.semi-badge-count')).toHaveText('1')
  // 看板其他侧栏没有内容时用 List 自己的空状态说明
  await expect(page.locator('.board-panel', { hasText: '待确认入座' }).locator('.semi-list-empty')).toContainText(
    '没有等待确认的申请',
  )
  await expect(page.locator('.board-panel', { hasText: '即将到店' }).locator('.semi-list-empty')).toContainText(
    '没有要到店的预约',
  )
  // 打开时已挂着的不算新到：不提示、不响
  await expect(callAlert(page)).toHaveCount(0)
  expect(await beeps(page)).toBe(0)

  // 提示音默认开：还没点过页面时顶部挂着提示，点一下任意处就开启（不用专门去点开关）
  await expect(unlockHint(page)).toBeVisible()
  await page.getByRole('heading', { name: '现场' }).click()
  await expect(unlockHint(page)).toHaveCount(0)
  expect(await beeps(page)).toBe(0)

  // 另一位顾客呼叫：实时事件到达 → 重读 → 列出、右上角提示、马上响一轮。面板和全站提醒同在这一页，只有一路（一轮两声）
  backend.state.open = [...backend.state.open, call('c2', 'C1', 1, '阿青', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(panel.getByText('C1 桌 · 1 号座')).toBeVisible()
  await expect(panel.getByText('阿青 · 刚刚')).toBeVisible()
  await expect(callAlert(page)).toHaveCount(1)
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 呼叫店员')
  await expect.poll(() => beeps(page)).toBe(2)
  await page.waitForTimeout(500)
  expect(await beeps(page)).toBe(2)
  // 没人处理就接着响：4 秒后又一轮
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBe(4)
  // 在看板上：响着时提示留着，只有标题和「知道了」（谁在叫看旁边的呼叫栏），不带「去现场」，挡不住「已处理」
  await expect(acknowledgeButton(page)).toBeVisible()
  await expect(callAlert(page)).not.toContainText('顾客')
  await expect(callAlert(page).getByText('去「现场」处理')).toHaveCount(0)
  const notice = await callAlert(page).boundingBox()
  const firstHandle = await panel.getByRole('button', { name: '已处理' }).first().boundingBox()
  if (!notice || !firstHandle) throw new Error('提示或「已处理」不在页面上')
  expect(notice.y + notice.height).toBeLessThan(firstHandle.y)
  await page.screenshot({ path: testInfo.outputPath('看板-响铃中的提示.png') })

  // 点「知道了」：不再响；看板上提示随后自己收起（呼叫栏就在旁边）
  await acknowledgeButton(page).click()
  await expect(acknowledgeButton(page)).toHaveCount(0)
  await page.mouse.move(0, 0)
  await expectQuiet(page)
  await expect(callAlert(page)).toHaveCount(0, { timeout: 10_000 })
  await expect(panel.getByText('C1 桌 · 1 号座')).toBeVisible()

  // 又来一位：重新响，直到店员在手机上处理掉（接口不再返回它）
  const beforeThird = await beeps(page)
  backend.state.open = [...backend.state.open, call('c3', 'E2', 1, '小周', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('E2 桌 · 1 号座 呼叫店员')
  await expect.poll(() => beeps(page)).toBe(beforeThird + 2)
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBe(beforeThird + 4)
  backend.state.open = backend.state.open.filter((c) => c.id !== 'c3')
  await pushCallsEvent(api)
  await expect(panel.getByText('E2 桌 · 1 号座')).toHaveCount(0)
  // 呼叫没了：提示收起、铃声停
  await expect(callAlert(page)).toHaveCount(0)
  await expectQuiet(page)
  const settled = await beeps(page)

  // 去过 B3 了：点已处理（不带幂等键，重复点无害），按接口重读后不再列出
  await panel.getByRole('button', { name: 'B3 桌 · 2 号座 已处理' }).click()
  await expect(page.locator('.semi-toast').getByText('B3 桌 · 2 号座 的呼叫已处理')).toBeVisible()
  await expect(panel.getByText('B3 桌 · 2 号座')).toHaveCount(0)
  await expect(panel.getByText('C1 桌 · 1 号座')).toBeVisible()
  expect(backend.state.handled).toEqual(['c1'])
  expect(api.writes.filter((w) => w.path.startsWith('/service-calls'))).toEqual([
    { method: 'POST', path: '/service-calls/c1/handle', body: null, idempotencyKey: undefined },
  ])
  // 处理掉一条不是新到：不再响
  expect(await beeps(page)).toBe(settled)
  // 人正看着页面（也没授权）：没有系统通知
  expect((await fakes(page)).notes).toEqual([])

  expect(problems).toEqual([])
})

test('「我去处理」：点了就停响、提示收起，看板写谁在处理；手机上别人认领的同样停；认领满 10 分钟没处理重新响；别人先认领了说清是谁', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'default')
  const backend = callsBackend([])
  const api = await mockApi(page, { handlers: [backend.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/board')
  const panel = page.locator('.service-calls-panel')
  await expect(panel.getByText('暂时没有顾客呼叫')).toBeVisible()
  await page.getByRole('heading', { name: '现场' }).click()
  await expect(unlockHint(page)).toHaveCount(0)

  // 两位顾客呼叫：响起来，每条都有「我去处理」「已处理」
  backend.state.open = [call('c2', 'C1', 1, '阿青', minutesAgo(0)), call('c3', 'E2', 1, '小何', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(panel.getByText('C1 桌 · 1 号座')).toBeVisible()
  await expect.poll(() => beeps(page)).toBe(2)
  await expect(acknowledgeButton(page)).toBeVisible()
  await expect(panel.getByRole('button', { name: 'C1 桌 · 1 号座 我去处理' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'E2 桌 · 1 号座 我去处理' })).toBeVisible()

  // 我去 C1：按接口重读后写我在处理、只留「已处理」；E2 还没人去，接着响
  await panel.getByRole('button', { name: 'C1 桌 · 1 号座 我去处理' }).click()
  await expect(page.locator('.semi-toast').getByText('C1 桌 · 1 号座 的呼叫已认领')).toBeVisible()
  await expect(panel.getByText('阿贝 正在处理 · 刚刚')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'C1 桌 · 1 号座 我去处理' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'C1 桌 · 1 号座 已处理' })).toBeVisible()
  const afterMine = await beeps(page)
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBeGreaterThan(afterMine)
  await expect(acknowledgeButton(page)).toBeVisible()

  // 小周在手机上认领了 E2：实时事件到达、重读；引起响铃的都有人去了，停，提示收起
  backend.state.open = backend.state.open.map((c) =>
    c.id === 'c3' ? { ...c, claimStatus: 'claimed' as const, claimedAt: minutesAgo(0), claimedBy: zhou } : c,
  )
  await pushCallsEvent(api)
  await expect(panel.getByText('小周 正在处理 · 刚刚')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'E2 桌 · 1 号座 我去处理' })).toHaveCount(0)
  await expect(callAlert(page)).toHaveCount(0)
  await expectQuiet(page)
  // 两条都还挂在呼叫栏，等人点「已处理」
  await expect(panel.locator('.semi-badge-count')).toHaveText('2')
  await page.screenshot({ path: testInfo.outputPath('看板-两条都有人在处理.png') })

  // 小周认领满 10 分钟还没处理：后端按时间标成 lapsed（时间到了没有推送，靠重读；这里推一条事件代替 30 秒兜底重读），
  // 当作新到重新响、提示，谁都能再认领
  const beforeLapse = await beeps(page)
  backend.state.open = backend.state.open.map((c) =>
    c.id === 'c3' ? { ...c, claimStatus: 'lapsed' as const, claimedAt: minutesAgo(11) } : c,
  )
  await pushCallsEvent(api)
  await expect(panel.getByText('小周 11 分钟前说去处理，还没处理')).toBeVisible()
  await expect.poll(() => beeps(page)).toBe(beforeLapse + 2)
  await expect(callAlert(page)).toContainText('E2 桌 · 1 号座 呼叫店员')
  await page.screenshot({ path: testInfo.outputPath('看板-认领满10分钟重新提醒.png') })

  // 我接手：停
  await panel.getByRole('button', { name: 'E2 桌 · 1 号座 我去处理' }).click()
  await expect(panel.getByText('阿贝 正在处理 · 刚刚')).toHaveCount(2)
  await expect(callAlert(page)).toHaveCount(0)
  await expectQuiet(page)

  // 又一位顾客呼叫，手里的列表还没重读、小周已经在手机上认领了：后端拒绝，提示是谁在处理，列表随后重读，也不再响
  backend.state.open = [...backend.state.open, call('c4', 'A1', 1, '小陈', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(panel.getByRole('button', { name: 'A1 桌 · 1 号座 我去处理' })).toBeVisible()
  backend.state.open = backend.state.open.map((c) =>
    c.id === 'c4' ? { ...c, claimStatus: 'claimed' as const, claimedAt: minutesAgo(0), claimedBy: zhou } : c,
  )
  await panel.getByRole('button', { name: 'A1 桌 · 1 号座 我去处理' }).click()
  await expect(page.locator('.semi-toast').getByText('小周 已在处理')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'A1 桌 · 1 号座 我去处理' })).toHaveCount(0)
  await expect(panel.getByText('小周 正在处理 · 刚刚')).toBeVisible()
  await expectQuiet(page)

  // 认领重复点无害，不带幂等键
  expect(backend.state.claimed).toEqual(['c2', 'c3'])
  expect(api.writes.filter((w) => w.path.startsWith('/service-calls'))).toEqual(
    ['c2', 'c3', 'c4'].map((id) => ({
      method: 'POST',
      path: `/service-calls/${id}/claim`,
      body: null,
      idempotencyKey: undefined,
    })),
  )

  // 浏览器把那次 409 记进控制台是预期的（上面就是要它被拒），别的错误一条都不能有
  expect(problems.filter((p) => !/status of 409 \(Conflict\)/.test(p))).toEqual([])
})

test('选「响一下」只响一轮；停在订单页也提醒：右上角提示一直留着，点「去现场处理」到看板；呼叫被处理后提示自己收起', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'default')
  const backend = callsBackend([])
  const orders = quietOrders()
  const api = await mockApi(page, { handlers: [backend.handler, orders.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: '订单与退款' })).toBeVisible()
  await expect.poll(() => backend.state.reads).toBeGreaterThan(0)

  // 设成「响一下」（这一下点击也开启了提示音）
  const dialog = await openSettingsFromMenu(page)
  await expect(unlockHint(page)).toHaveCount(0)
  await dialog.getByRole('radio', { name: '响一下' }).check()
  await expect(dialog.getByRole('radio', { name: '响一下' })).toBeChecked()
  await closeSettings(page)

  backend.state.open = [call('c2', 'C1', 1, '阿青', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 呼叫店员')
  await expect.poll(() => beeps(page)).toBe(2)
  // 只响这一轮，提示上也就没有「知道了」；不在看板上：一直留着，直到处理或关掉
  await expect(acknowledgeButton(page)).toHaveCount(0)
  await page.waitForTimeout(7000)
  await expect(callAlert(page)).toHaveCount(1)
  expect(await beeps(page)).toBe(2)

  // 再来一条：同一个提示里列出两条，再响一轮
  backend.state.open = [...backend.state.open, call('c3', 'E2', 1, '小周', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('2 位顾客呼叫店员')
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 · 阿青')
  await expect(callAlert(page)).toContainText('E2 桌 · 1 号座 · 小周')
  await expect(callAlert(page)).toHaveCount(1)
  await expect.poll(() => beeps(page)).toBe(4)
  await page.screenshot({ path: testInfo.outputPath('订单页-两条呼叫的提示.png') })

  // 店员在手机上处理了 C1：提示里只剩 E2
  backend.state.open = backend.state.open.filter((c) => c.id !== 'c2')
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('E2 桌 · 1 号座 呼叫店员')
  await expect(callAlert(page)).not.toContainText('C1')

  await callAlert(page).getByText('去「现场」处理').click()
  await expect(page).toHaveURL(/\/board$/)
  await expect(callAlert(page)).toHaveCount(0)
  await expect(page.locator('.service-calls-panel').getByText('E2 桌 · 1 号座')).toBeVisible()
  expect(await beeps(page)).toBe(4)

  expect(problems).toEqual([])
})

test('点「知道了」就停、提示留着；响着时又来新呼叫重新计时；关掉提示音也停', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'default')
  const backend = callsBackend([])
  const orders = quietOrders()
  const api = await mockApi(page, { handlers: [backend.handler, orders.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: '订单与退款' })).toBeVisible()
  await expect.poll(() => backend.state.reads).toBeGreaterThan(0)
  await page.getByRole('heading', { name: '订单与退款' }).click()
  await expect(unlockHint(page)).toHaveCount(0)

  backend.state.open = [call('c2', 'C1', 1, '阿青', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 呼叫店员')
  await expect.poll(() => beeps(page)).toBe(2)
  await expect(acknowledgeButton(page)).toBeVisible()
  // 等滑入动画走完再截图
  await page.waitForTimeout(500)
  await page.screenshot({ path: testInfo.outputPath('订单页-响铃中的提示.png') })

  // 知道了：不再响；不在看板上，提示照旧留着（还没处理），只是没有「知道了」了
  await acknowledgeButton(page).click()
  await expect(acknowledgeButton(page)).toHaveCount(0)
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 呼叫店员')
  await expect(callAlert(page).getByText('去「现场」处理')).toBeVisible()
  await expectQuiet(page)
  await expect(callAlert(page)).toHaveCount(1)

  // 又来一位：马上响一轮，从这一条起重新计时，只有一路接着响（一轮仍是两声，不叠响）
  const before = await beeps(page)
  backend.state.open = [...backend.state.open, call('c3', 'E2', 1, '小周', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('2 位顾客呼叫店员')
  await expect.poll(() => beeps(page)).toBe(before + 2)
  await expect(acknowledgeButton(page)).toBeVisible()
  await page.waitForTimeout(1_000)
  expect(await beeps(page)).toBe(before + 2)
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBe(before + 4)

  // 在「提醒设置」里关掉提示音：马上停
  const dialog = await openSettingsFromMenu(page)
  await dialog.getByRole('switch', { name: '提示音' }).click()
  await expect(dialog.getByText('已关闭', { exact: true })).toBeVisible()
  await expectQuiet(page)
  await closeSettings(page)
  await expect(acknowledgeButton(page)).toHaveCount(0)
  await expect(callAlert(page)).toHaveCount(1)

  expect(problems).toEqual([])
})

test('标签页在后台：呼叫事件到达立即重读，弹系统通知（只弹一次）、标题闪「(1) 新呼叫」、照样持续响，点通知就停；别的查询仍只标过期', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'granted')
  const backend = callsBackend([])
  const orders = quietOrders()
  const api = await mockApi(page, { handlers: [backend.handler, orders.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/orders')
  await expect(page.getByRole('heading', { name: '订单与退款' })).toBeVisible()
  await expect.poll(() => backend.state.reads).toBeGreaterThan(0)
  await expect.poll(() => orders.state.reads).toBeGreaterThan(0)
  await page.getByRole('heading', { name: '订单与退款' }).click()
  await expect(unlockHint(page)).toHaveCount(0)
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  // 等连上后的那次整体重读落定
  await page.waitForTimeout(500)
  const title = await page.title()

  await setVisibility(page, 'hidden')
  const ordersBefore = orders.state.reads
  const callsBefore = backend.state.reads

  // 后台时订单变了：只标过期，不重读
  await pushCallsEvent(api, 'sales-orders')
  await page.waitForTimeout(1500)
  expect(orders.state.reads).toBe(ordersBefore)
  expect(backend.state.reads).toBe(callsBefore)

  // 顾客呼叫：后台也立刻重读呼叫，弹系统通知、标题提醒、响铃
  backend.state.open = [call('c2', 'C1', 1, '阿青', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect.poll(() => backend.state.reads).toBe(callsBefore + 1)
  await expect
    .poll(async () => (await fakes(page)).notes)
    .toEqual([
      { title: 'C1 桌 · 1 号座 呼叫店员', body: '顾客：阿青。点这里打开「现场」处理', tag: 'c2', closed: false },
    ])
  await expect.poll(() => page.title()).toBe(`(1) 新呼叫 · ${title}`)
  await expect.poll(() => beeps(page)).toBe(2)
  expect(orders.state.reads).toBe(ordersBefore)
  // 在后台也接着响；系统通知不随每轮再弹
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBe(4)
  expect((await fakes(page)).notes).toHaveLength(1)

  // 点系统通知：算知道了，铃声停；回到这个页面、打开「现场」，通知关掉
  await page.evaluate(() => {
    const w = window as unknown as FakeWindow
    w.__noteObjects[0].onclick?.(new Event('click', { cancelable: true }))
  })
  await expect(page).toHaveURL(/\/board$/)
  expect((await fakes(page)).notes[0].closed).toBe(true)
  await expectQuiet(page)
  expect((await fakes(page)).notes).toHaveLength(1)

  // 切回前台：标题恢复，后台积下的过期查询补读
  await setVisibility(page, 'visible')
  await expect.poll(() => page.title()).toBe(title)
  await expect(page.locator('.service-calls-panel').getByText('C1 桌 · 1 号座')).toBeVisible()

  expect(problems).toEqual([])
})

test('提示音默认开、设置按浏览器存：响铃时长、音量、开关刷新后照旧；点页面之前来的呼叫点一下后接着响；系统通知点按钮才请求授权', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const problems = watchProblems(page)
  await installFakes(page, 'default')
  const backend = callsBackend([])
  const api = await mockApi(page, { handlers: [backend.handler, quietBoard] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/board')
  const panel = page.locator('.service-calls-panel')
  await expect(panel.getByText('暂时没有顾客呼叫')).toBeVisible()
  await expect(unlockHint(page)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('看板-点一下开启提示音.png') })

  // 还没点过页面时来了呼叫：浏览器不许出声，只有页面提示
  backend.state.open = [call('c1', 'B3', 2, '小林', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('B3 桌 · 2 号座 呼叫店员')
  expect(await beeps(page)).toBe(0)

  // 第一次点页面（这里点的是顶栏的账户菜单，响着时右上角提示盖在呼叫栏头部上）：声音随之开启，还没人处理的这条接着响出来
  const dialog = await openSettingsFromMenu(page)
  await expect(unlockHint(page)).toHaveCount(0)
  await expect.poll(() => beeps(page), { timeout: ringIntervalMs + 2_000 }).toBe(2)
  await expect(dialog.getByRole('switch', { name: '提示音' })).toBeChecked()
  await expect(dialog.getByText('已开启，能出声')).toBeVisible()
  await expect(dialog.getByText('这些设置只对这台电脑的这个浏览器有效', { exact: false })).toBeVisible()

  // 默认一直响到有人处理、音量 80；改成「响一下」：正在响的也停了
  await expect(dialog.getByRole('radio', { name: '一直响到有人处理（最长 5 分钟）' })).toBeChecked()
  const volume = dialog.getByRole('slider', { name: '音量' })
  await expect(volume).toHaveAttribute('aria-valuenow', '80')
  await dialog.getByRole('radio', { name: '响一下' }).check()
  await expect(dialog.getByRole('radio', { name: '一直响到有人处理（最长 5 分钟）' })).not.toBeChecked()
  await expectQuiet(page)

  // 系统通知：默认开，但要点按钮向浏览器请求授权（授权弹窗只能由点击触发）
  await expect(dialog.getByRole('switch', { name: '系统通知' })).toBeChecked()
  await expect(dialog.getByText('浏览器还没允许')).toBeVisible()
  expect((await fakes(page)).permissionRequests).toBe(0)
  await dialog.getByRole('button', { name: '开启系统通知' }).click()
  await expect(dialog.getByText('浏览器已允许')).toBeVisible()
  expect((await fakes(page)).permissionRequests).toBe(1)

  // 音量调到 50（键盘每按一下 5），试听按这个音量响一轮
  await volume.focus()
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
  await expect(volume).toHaveAttribute('aria-valuenow', '50')
  const beforeTest = await fakes(page)
  await dialog.getByRole('button', { name: '试听' }).click()
  await expect.poll(() => beeps(page)).toBe(beforeTest.beeps + 2)
  const testPeaks = (await fakes(page)).peaks.slice(beforeTest.peaks.length)
  // 音量 80 时每声峰值约 0.51，50 时约 0.2（按平方换算）
  expect(beforeTest.peaks.at(-1)).toBeCloseTo(0.512, 2)
  expect(testPeaks.map((peak) => Number(peak.toFixed(2)))).toEqual([0.2, 0.2])
  await page.screenshot({ path: testInfo.outputPath('提醒设置-响一下-音量50.png') })

  // 刷新：响铃时长和音量都照旧
  await closeSettings(page)
  await page.reload()
  await expect(panel.getByText('B3 桌 · 2 号座')).toBeVisible()
  await page.getByRole('heading', { name: '现场' }).click()
  await openSettingsFromMenu(page)
  await expect(dialog.getByRole('radio', { name: '响一下' })).toBeChecked()
  await expect(dialog.getByRole('slider', { name: '音量' })).toHaveAttribute('aria-valuenow', '50')

  // 关掉提示音：时长和音量跟着不能改；刷新后仍是关的，顶部不再提示去点
  await dialog.getByRole('switch', { name: '提示音' }).click()
  await expect(dialog.getByText('已关闭', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('radio', { name: '响一下' })).toBeDisabled()
  await closeSettings(page)
  await page.reload()
  await expect(panel.getByText('B3 桌 · 2 号座')).toBeVisible()
  await expect(unlockHint(page)).toHaveCount(0)
  await page.getByRole('heading', { name: '现场' }).click()
  backend.state.open = [...backend.state.open, call('c2', 'C1', 1, '阿青', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(callAlert(page)).toContainText('C1 桌 · 1 号座 呼叫店员')
  await page.waitForTimeout(300)
  expect(await beeps(page)).toBe(0)

  // 从账户菜单打开设置，重新打开提示音（这一下点击里唤醒并试响），刷新后仍是开的
  await openSettingsFromMenu(page)
  await expect(dialog.getByRole('switch', { name: '提示音' })).not.toBeChecked()
  await dialog.getByRole('switch', { name: '提示音' }).click()
  await expect.poll(() => beeps(page)).toBe(2)
  await page.reload()
  await expect(panel.getByText('C1 桌 · 1 号座')).toBeVisible()
  await expect(unlockHint(page)).toBeVisible()
  await page.getByRole('heading', { name: '现场' }).click()
  await expect(unlockHint(page)).toHaveCount(0)
  backend.state.open = [...backend.state.open, call('c3', 'E2', 1, '小周', minutesAgo(0))]
  await pushCallsEvent(api)
  await expect(panel.getByText('E2 桌 · 1 号座')).toBeVisible()
  // 刷新后仍是「响一下」：只响一轮
  await expect.poll(() => beeps(page)).toBe(2)
  await expectQuiet(page)

  expect(problems).toEqual([])
})

test('浏览器拒绝过通知：如实显示，并写清在地址栏左侧的站点设置里重新允许', async ({ page }) => {
  await installFakes(page, 'denied')
  await mockApi(page, { handlers: [quietBoard] })
  await signIn(page, { id: 'u-owner', roles: ['clerk'] })
  await page.goto('/')
  await page.locator('.account-trigger').click()
  await page.getByRole('menuitem', { name: '提醒设置' }).click()
  const dialog = page.locator('.semi-modal-content')
  await expect(dialog.getByText('浏览器已拒绝通知')).toBeVisible()
  await expect(dialog.getByText('地址栏左侧', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '开启系统通知' })).toHaveCount(0)
  expect((await fakes(page)).permissionRequests).toBe(0)
})

test('没有顾客呼叫时面板说没有', async ({ page }) => {
  await mockApi(page, { handlers: [quietBoard] })
  await signIn(page, { id: 'u-owner', roles: ['clerk'] })
  await page.goto('/board')
  await expect(page.locator('.service-calls-panel').getByText('暂时没有顾客呼叫')).toBeVisible()
})
