import { expect, test, type Page } from '@playwright/test'
import { accountListResult } from './account-list'
import { mockApi, signIn, type MockApi, type MockHandler } from './mock-api'

// 「现场」看板：平面图上每个座位的状态（空闲、使用中、陪客中、快到点、超时、暂停、待结账、停用）与 30 分钟内的预约；
// 侧栏的待确认入座、即将到店、快到点与超时；点有人的座位开会话详情做暂停、续时、去结账，以及换桌换座、陪客、撤销误开，
// 点空座位开台（整桌开台），停用的只提示；实时断开时的提示与定时重读；全屏藏起侧栏。接口照 docs/api.yaml 模拟，时间按此刻现算。

/** 门店布局（layout/store-layout.json）里的 21 个座位。 */
const codes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'C1', 'C2', 'C3']
codes.push('D1', 'D2', 'E1', 'E2', 'E3')

const customers = [
  { id: 'u-wang', nickname: '小王', phoneMasked: '138****1234' },
  { id: 'u-li', nickname: '李同学', phoneMasked: '139****5678' },
  { id: 'u-zhou', nickname: '周末常来拼豆的大学生团体负责人', phoneMasked: '137****0000' },
  { id: 'u-lin', nickname: '小林', phoneMasked: '136****1111' },
  { id: 'u-chen', nickname: '小陈', phoneMasked: '135****2222' },
  { id: 'u-aunt', nickname: '王阿姨', phoneMasked: '133****3333' },
]
const label = (id: string) => {
  const person = customers.find((c) => c.id === id)!
  return { id: person.id, nickname: person.nickname, phoneMasked: person.phoneMasked }
}

const pkg = {
  id: 'p-2h',
  kind: 'package',
  name: '畅玩 2 小时',
  enabled: true,
  amountCents: 8800,
  giftCents: 0,
  points: 0,
  rateBasisPoints: 0,
  maxBasisPoints: 0,
  minimumPoints: 0,
  validDays: 0,
  mode: '',
  scope: '',
  stack: false,
  productId: '',
  quantity: 0,
  perUserLimit: 0,
  durationMinutes: 120,
  renewalMinutes: 30,
  renewalCents: 2000,
  pauseLimitMinutes: 15,
  overtime: 'manual',
}
/** 已发布的计时套餐，同生产：1、2、3 小时，另有到打烊的「全天不限时」。预约、入座用的是 2 小时那个。 */
const packages = [
  { ...pkg, id: 'p-1h', name: '畅玩 1 小时', amountCents: 4800, durationMinutes: 60 },
  pkg,
  { ...pkg, id: 'p-3h', name: '畅玩 3 小时', amountCents: 12800, durationMinutes: 180 },
  { ...pkg, id: 'p-day', name: '全天不限时', amountCents: 16800, durationMinutes: 0, untilClose: true },
]

type Json = Record<string, unknown>

/** 模拟后端：桌位、会话、当班申请、预约，写操作改到状态上（下一次读就是新的）。 */
function boardBackend() {
  const now = Date.now()
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
  const tables: Json[] = codes.map((code) => ({
    id: `t-${code}`,
    code,
    zone: code[0],
    floorAreaId: `area-${code[0]}`,
    number: Number(code.slice(1)),
    seatCount: code.startsWith('D') ? 2 : 1,
    wholeTable: code.startsWith('D'),
    enabled: code !== 'B2',
    occupancy: 'idle',
    seatBased: false,
  }))
  const sessions: Json[] = []
  const admissions: Json[] = []
  const table = (code: string) => tables.find((t) => t.code === code)!

  /** 开一张桌：endsIn 分钟后到点（负数是已超时）。 */
  const occupy = (code: string, endsIn: number | null, session: Json, accountId?: string) => {
    const startedAt = at(endsIn === null ? -40 : endsIn - 120)
    Object.assign(table(code), {
      occupancy: 'occupied',
      seatBased: Boolean(session.admissionId),
      ...(endsIn === null
        ? { timingMode: 'free' }
        : {
            startedAt,
            endsAt: at(endsIn),
            remainingSeconds: Math.max(0, endsIn * 60),
            timingStatus: endsIn < 0 ? 'overdue' : endsIn <= 10 ? 'expiring' : 'running',
          }),
    })
    sessions.push({
      id: `s-${code}`,
      serviceTableId: `t-${code}`,
      startedAt,
      timingMode: endsIn === null ? 'free' : 'timed',
      ...(endsIn === null ? {} : { durationMinutes: 120 }),
      status: 'active',
      ...(accountId ? { accountId } : {}),
      ...session,
    })
  }
  /** 按座会话：扫码入座确认后的那条申请也在当班列表里。 */
  const seatBased = (code: string, endsIn: number, accountId: string, session: Json = {}) => {
    occupy(code, endsIn, { admissionId: `a-${code}`, seatNumber: 1, ...session }, accountId)
    admissions.push({
      admission: {
        id: `a-${code}`,
        accountId,
        serviceTableId: `t-${code}`,
        seatNumber: 1,
        package: pkg,
        status: 'confirmed',
        venueSessionId: `s-${code}`,
        createdAt: at(endsIn - 125),
      },
      session: sessions.at(-1),
      sessionVersion: `v-${code}`,
      order: {
        id: `o-s-${code}`,
        version: `o-${code}`,
        venueSessionId: `s-${code}`,
        accountId,
        status: 'draft',
        receivableCents: 8800,
        paidCents: 0,
        refundedCents: 0,
        refundableCents: 0,
        settlement: 'standard',
        createdAt: at(endsIn - 120),
      },
      displayStatus: 'confirmed',
      customer: label(accountId),
    })
  }

  seatBased('A1', 45, 'u-wang')
  // A2 的时长对得上带续时方案的套餐（后端按开台时记下的价给 renewal），B5 对不上
  occupy('A2', 6, { renewal: { minutes: 30, amountCents: 1500, packageName: '畅玩 2 小时' } }, 'u-li')
  seatBased('A3', -4.5, 'u-zhou')
  occupy('A4', 30, { status: 'paused', pausedAt: at(-3), pausedSeconds: 0 })
  seatBased('A5', -2, 'u-chen', { stoppedAt: at(-4) })
  occupy('A6', null, {})
  occupy('B5', 9, {}, 'u-lin')
  occupy('D1', -14.5, {})
  occupy('B3', 50, { status: 'companion' }, 'u-aunt')
  /** 整桌会话已建好的草稿续时后跟着改价没有（后端的 draftOrder）：A2 的是系统生成的明细，D1 的被员工改过。 */
  const drafts: Record<string, Json> = {
    's-A2': { id: 'o-s-A2', repriced: true, receivableCents: 10800 },
    's-D1': { id: 'o-s-D1', repriced: false, receivableCents: 6600 },
  }
  /** 整桌会话 PATCH 按幂等键记下的结果：同一个键再来原样重放（和真后端一样），不再执行。 */
  const replies = new Map<string, Json>()
  // loseNextReply：下一次整桌会话 PATCH 已生效但回包丢了（员工那边看到的是 502）；dropNextPatch：下一次整桌会话 PATCH
  // 没到后端就断了（502，什么也没改）；failNextSeat：下一次到店开台被后端拒绝（座位刚被占）
  const network = { loseNextReply: false, dropNextPatch: false, failNextSeat: false }
  /** 桌位上随会话走的计时摘要：换桌、换座时整份搬到新桌，撤销时清掉。 */
  const timingKeys = ['occupancy', 'seatBased', 'timingMode', 'startedAt', 'endsAt', 'remainingSeconds', 'timingStatus']
  const release = (tableId: unknown) => {
    const from = tables.find((t) => t.id === tableId)!
    for (const key of timingKeys) delete from[key]
    Object.assign(from, { occupancy: 'idle', seatBased: false })
  }
  const relocate = (fromId: unknown, toId: unknown) => {
    const from = tables.find((t) => t.id === fromId)!
    const to = tables.find((t) => t.id === toId)!
    for (const key of timingKeys) {
      delete to[key]
      if (key in from) to[key] = from[key]
    }
    release(fromId)
  }
  /** 当班视图的桌位占用（/loyalty/shift 的 tables）：启用的桌，不分座的整桌会话与整桌单位占满全部座号。 */
  const shiftTables = () =>
    tables
      .filter((t) => t.enabled)
      .map((t) => ({
        id: t.id,
        code: t.code,
        zone: t.zone,
        number: t.number,
        seatCount: t.seatCount,
        wholeTable: t.wholeTable,
        occupiedSeats: sessions
          .filter((s) => s.serviceTableId === t.id)
          .flatMap((s) =>
            s.seatNumber && !t.wholeTable
              ? [s.seatNumber]
              : Array.from({ length: Number(t.seatCount) }, (_, index) => index + 1),
          ),
        floorAreaId: t.floorAreaId,
        floorAreaName: `${String(t.zone)} 区`,
      }))
  admissions.push(
    {
      admission: {
        id: 'a-new',
        accountId: 'u-lin',
        serviceTableId: 't-C1',
        seatNumber: 1,
        package: pkg,
        status: 'pending',
        createdAt: at(-3),
        // 顾客扫码时记下的团购（选填）
        coupon: { platform: 'meituan', code: '123456789012' },
      },
      displayStatus: 'pending',
      // 失效时刻由后端给（申请时刻加确认时限）
      expiresAt: at(27),
      customer: label('u-lin'),
    },
    {
      admission: {
        id: 'a-old',
        accountId: 'u-chen',
        serviceTableId: 't-C3',
        seatNumber: 1,
        package: pkg,
        status: 'pending',
        createdAt: at(-45),
      },
      displayStatus: 'expired',
      customer: label('u-chen'),
    },
  )
  const booking = (id: string, code: string, startsIn: number, extra: Json, displayStatus = 'confirmed') => ({
    reservation: {
      id,
      serviceTableId: `t-${code}`,
      seatNumber: 1,
      packageId: pkg.id,
      packageName: pkg.name,
      durationMinutes: 120,
      amountCents: 8800,
      startAt: at(startsIn),
      status: displayStatus === 'pending' ? 'pending' : 'confirmed',
      createdBy: 'u-owner',
      createdAt: at(-600),
      ...extra,
    },
    displayStatus,
    endAt: at(startsIn + 120),
    tableNumber: Number(code.slice(1)),
    ...(extra.accountId
      ? {
          customerName: label(String(extra.accountId)).nickname,
          phoneMasked: label(String(extra.accountId)).phoneMasked,
        }
      : { customerName: String(extra.guestName ?? '') }),
  })
  const reservations = [
    booking('r-e1', 'E1', 10, { guestName: '王阿姨' }),
    // 预约之后套餐涨过价：到店开台按现行的 ¥88.00 开，确认框要说清楚
    booking('r-b1', 'B1', 20, { accountId: 'u-chen', amountCents: 7800 }),
    booking('r-c2', 'C2', 45, { accountId: 'u-wang' }, 'pending'),
    booking('r-c3', 'C3', 120, { accountId: 'u-li' }),
  ]
  const reads = { tables: 0 }
  const orders: Json[] = [
    {
      id: 'o-s-D1',
      version: 'o-D1',
      venueSessionId: 's-D1',
      status: 'draft',
      receivableCents: 6600,
      paidCents: 0,
      refundedCents: 0,
      refundableCents: 0,
      settlement: 'standard',
      createdAt: at(-60),
      lines: [{ name: '包间熟客价', quantity: 1, unitPriceCents: 6600 }],
    },
  ]

  const handler: MockHandler = ({ method, path, search, body, idempotencyKey }) => {
    const ok = (value: unknown, status = 200) => ({ status, body: value })
    if (method === 'GET' && path === '/service-tables') {
      reads.tables++
      return ok(tables)
    }
    if (method === 'GET' && path === '/venue-sessions')
      return search.get('status') === 'live'
        ? ok(sessions)
        : { status: 400, body: { code: 'invalid_request', message: 'status 必须是 live', requestId: 'm' } }
    if (method === 'GET' && path === '/loyalty/shift') return ok({ admissions, tables: shiftTables() })
    if (method === 'GET' && path === '/reservations/staff' && search.get('scope') === 'open')
      return ok({
        reservations,
        busy: [],
        packages,
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
      })
    if (method === 'GET' && path === '/accounts') return accountListResult(customers, search)
    const account = customers.find((c) => path === `/accounts/${c.id}`)
    if (method === 'GET' && account) return ok({ ...account, roles: [], phoneVerificationStatus: 'verified' })

    if (method === 'POST' && path === '/loyalty/actions') {
      const input = body as {
        action: string
        targetId: string
        expectedVersion?: string
        serviceTableId?: string
        seatNumber?: number
      }
      const session = sessions.find((s) => s.id === input.targetId)
      if (session && input.action === 'pause') session.status = 'paused'
      if (session && input.action === 'stop') session.stoppedAt = new Date().toISOString()
      // 结束（系统内收费关着时）：会话没了，座位空出来
      if (session && input.action === 'end') {
        release(session.serviceTableId)
        sessions.splice(sessions.indexOf(session), 1)
        session.status = 'ended'
        const shift = admissions.findIndex((entry) => (entry.admission as Json).venueSessionId === session.id)
        if (shift >= 0) admissions.splice(shift, 1)
        return ok({ session, version: 'v-next' })
      }
      // 换座：目标座位被占回 409（同真后端的「目标座位不可用」）；换过去后计时摘要跟着走
      if (session && input.action === 'move') {
        const target = shiftTables().find((t) => t.id === input.serviceTableId)
        if (!target || target.occupiedSeats.includes(Number(input.seatNumber)))
          return { status: 409, body: { code: 'loyalty_conflict', message: '目标座位不可用', requestId: 'm' } }
        relocate(session.serviceTableId, input.serviceTableId)
        Object.assign(session, { serviceTableId: input.serviceTableId, seatNumber: input.seatNumber })
      }
      if (session) return ok({ session, version: 'v-next' })
      return ok(admissions.find((entry) => (entry.admission as Json).id === input.targetId)?.admission ?? {})
    }
    const patch = path.match(/^\/venue-sessions\/([^/]+)$/)
    // 撤销误开：会话没了，桌位空出来；已撤销的再撤销照样 204（同真后端）
    if (method === 'DELETE' && patch) {
      const index = sessions.findIndex((s) => s.id === patch[1])
      if (index >= 0) {
        release(sessions[index].serviceTableId)
        sessions.splice(index, 1)
      }
      return { status: 204 }
    }
    if (method === 'PATCH' && patch) {
      const session = sessions.find((s) => s.id === patch[1])!
      const input = body as Json
      const replayed = idempotencyKey ? replies.get(idempotencyKey) : undefined
      if (replayed) return ok(replayed)
      if (network.dropNextPatch) {
        network.dropNextPatch = false
        return { status: 502, body: {} }
      }
      // 换桌：目标桌有人 409 table_occupied；桌上有预约 409 seat_reserved（真后端只拒绝时段压到预约的，这里有预约就拒）
      if (typeof input.serviceTableId === 'string') {
        const target = tables.find((t) => t.id === input.serviceTableId)
        if (!target?.enabled) return { status: 404, body: { code: 'not_found', message: 'not found', requestId: 'm' } }
        if (target.occupancy === 'occupied')
          return { status: 409, body: { code: 'table_occupied', message: '目标桌位正在使用中', requestId: 'm' } }
        if (reservations.some((entry) => entry.reservation.serviceTableId === target.id))
          return {
            status: 409,
            body: {
              code: 'seat_reserved',
              message: '目标桌在这个时间段已有预约，请先处理预约或更换桌位',
              requestId: 'm',
            },
          }
        relocate(session.serviceTableId, target.id)
      }
      if (session.status === 'companion' && (input.status === 'paused' || input.status === 'active'))
        return {
          status: 409,
          body: { code: 'invalid_session_state', message: '陪客不计时，不能暂停或继续', requestId: 'm' },
        }
      let result: Json
      if (typeof input.extendMinutes === 'number') {
        // 续时：在看到的时长上追加；看到的已经不是现在的就拒绝
        if (input.expectedDurationMinutes !== session.durationMinutes)
          return {
            status: 409,
            body: {
              code: 'session_conflict',
              message: `这一台的计时刚被改过，现在是 ${String(session.durationMinutes)} 分钟，请核对后再续时`,
              requestId: 'm',
            },
          }
        session.durationMinutes = Number(session.durationMinutes) + input.extendMinutes
        result = { ...session, ...(drafts[session.id as string] ? { draftOrder: drafts[session.id as string] } : {}) }
      } else if (input.end === true) {
        // 结束（系统内收费关着时）：会话没了，桌位空出来
        release(session.serviceTableId)
        sessions.splice(sessions.indexOf(session), 1)
        result = { ...session, status: 'ended' }
      } else if (input.stop === true) {
        // 停止计时：停在这一刻（暂停中的先结束暂停），状态仍是 active，同真后端
        Object.assign(session, { stoppedAt: new Date().toISOString(), status: 'active' })
        delete session.pausedAt
        result = { ...session }
      } else {
        Object.assign(session, input)
        result = { ...session }
      }
      if (idempotencyKey) replies.set(idempotencyKey, result)
      if (network.loseNextReply) {
        network.loseNextReply = false
        return { status: 502, body: {} }
      }
      return ok(result)
    }
    // 结账页读订单、读会话（按座会话的套餐单只读）
    const order = orders.find((o) => path === `/sales-orders/${o.id}`)
    if (method === 'GET' && order) return ok(order)
    const live = sessions.find((s) => path === `/venue-sessions/${s.id}`)
    if (method === 'GET' && live) return ok(live)
    if (method === 'POST' && path === '/sales-orders') {
      const input = body as { venueSessionId: string }
      const created = {
        id: `o-${input.venueSessionId}`,
        version: 'o-v1',
        venueSessionId: input.venueSessionId,
        status: 'draft',
        receivableCents: 8800,
        paidCents: 0,
        refundedCents: 0,
        refundableCents: 0,
        settlement: 'standard',
        createdAt: new Date().toISOString(),
        lines: [{ name: pkg.name, quantity: 1, unitPriceCents: 8800 }],
      }
      if (!orders.some((o) => o.id === created.id)) orders.push(created)
      return ok(created, 201)
    }
    // 整桌开台：停用或不存在 404，桌上有人 409 table_occupied，桌上有预约 409 seat_reserved（真后端只拒绝时段压到预约的，
    // 这里桌上有预约就拒），否则开出会话、桌位变成使用中
    if (method === 'POST' && path === '/venue-sessions') {
      const input = body as {
        serviceTableId: string
        accountId?: string
        startedAt?: string
        timingMode: 'timed' | 'free'
        durationMinutes?: number
      }
      // 「现在」开台不带开始时间，和真后端一样按收到请求的这一刻算
      const startedAt = input.startedAt ?? new Date().toISOString()
      const target = tables.find((t) => t.id === input.serviceTableId)
      if (!target?.enabled) return { status: 404, body: { code: 'not_found', message: 'not found', requestId: 'm' } }
      if (target.occupancy === 'occupied')
        return { status: 409, body: { code: 'table_occupied', message: '该桌位正在使用中', requestId: 'm' } }
      if (reservations.some((entry) => entry.reservation.serviceTableId === target.id))
        return {
          status: 409,
          body: { code: 'seat_reserved', message: '该桌在这个时间段已有预约，请先处理预约或更换桌位', requestId: 'm' },
        }
      const created: Json = { id: `s-${String(target.code)}`, status: 'active', ...input, startedAt }
      sessions.push(created)
      const endsAt = input.durationMinutes
        ? new Date(Date.parse(startedAt) + input.durationMinutes * 60_000).toISOString()
        : undefined
      Object.assign(target, {
        occupancy: 'occupied',
        ...(endsAt ? { startedAt, endsAt, remainingSeconds: 3600, timingStatus: 'running' } : { timingMode: 'free' }),
      })
      return ok(created, 201)
    }
    if (method === 'POST' && path === '/reservations/actions' && network.failNextSeat) {
      network.failNextSeat = false
      return { status: 409, body: { code: 'table_occupied', message: '该桌位正在使用中', requestId: 'm' } }
    }
    if (method === 'POST' && path === '/reservations/actions')
      return ok({
        reservations,
        busy: [],
        packages,
        tables: [],
        settings: {},
        settingsVersion: 's1',
        version: 'r2',
        targetId: (body as { targetId: string }).targetId,
      })
    return undefined
  }
  return { handler, reads, sessions, network }
}

async function openBoard(page: Page, roles: string[] = ['owner'], billingEnabled = true) {
  const backend = boardBackend()
  const api = await mockApi(page, {
    account: { id: 'u-owner', nickname: '阿贝', roles, phoneVerificationStatus: 'verified' },
    billingEnabled,
    handlers: [backend.handler],
  })
  await signIn(page, { id: 'u-owner', nickname: '阿贝', roles })
  await page.goto('/board')
  await expect(page.locator('[data-seat="A1"]')).toBeVisible()
  return { api, backend }
}

const seat = (page: Page, code: string) => page.locator(`[data-seat="${code}"]`)
const writes = (api: MockApi, path: string) => api.writes.filter((write) => write.path === path)

test('平面图标出每个座位的状态与 30 分钟内的预约，侧栏按规则排好', async ({ page }) => {
  // 底图是从小程序目录打包进来的：由后端嵌入、和页面同源，在生产 CSP 下要能显示
  await page.addInitScript(() => {
    const violations: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = violations
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(`${event.violatedDirective} ${event.blockedURI}`),
    )
  })
  await openBoard(page)
  const plan = page.locator('.board-plan-image')
  await expect(plan).toHaveAttribute('src', /^\/assets\/plan-[\w-]+\.jpg$/)
  await expect.poll(() => plan.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])

  const states = Object.fromEntries(
    await page
      .locator('[data-seat]')
      .evaluateAll((els) => els.map((el) => [el.getAttribute('data-seat'), el.getAttribute('data-state')])),
  )
  expect(states).toMatchObject({
    A1: 'running',
    A2: 'expiring',
    A3: 'overdue',
    A4: 'paused',
    A5: 'stopped',
    A6: 'running',
    B1: 'free',
    B2: 'off',
    B3: 'companion',
    B5: 'expiring',
    D1: 'overdue',
    E1: 'free',
  })
  expect(Object.keys(states)).toHaveLength(21)
  await expect(seat(page, 'A1')).toContainText(/剩4[45]分/)
  // A3 超时 4.5 分钟：按整分钟向下取整（和计价一致）写 4 分，测试跑过半分钟可能到 5
  await expect(seat(page, 'A3')).toContainText(/超[45]分/)
  await expect(seat(page, 'A4')).toContainText('暂停')
  await expect(seat(page, 'A5')).toContainText('待结账')
  await expect(seat(page, 'A6')).toContainText('自由')
  await expect(seat(page, 'B2')).toContainText('停用')
  await expect(page.locator('.board-legend')).toContainText('陪客中 1')
  // 有人用的座位点开详情，空闲的点了开台，停用的点了只提示（标成不可用）
  await expect(page.getByRole('button', { name: /^A3，已超时，已超时 [45] 分钟/ })).toBeVisible()
  expect(await seat(page, 'B1').evaluate((el) => el.tagName)).toBe('BUTTON')
  expect(await seat(page, 'B2').evaluate((el) => el.tagName)).toBe('BUTTON')
  // 30 分钟内的预约标在座位上（E1 10 分钟后、B1 20 分钟后），45 分钟后的 C2 不标
  await expect(seat(page, 'E1')).toContainText('约')
  await expect(seat(page, 'B1')).toContainText('约')
  await expect(seat(page, 'C2')).not.toContainText('约')
  await expect(page.locator('.board-legend')).toContainText('已超时 2')

  // 快到点与超时：超时最久的在前；暂停中（A4）、已停止计时（A5）不提醒
  const reminders = page.locator('[data-reminder]')
  await expect(reminders).toHaveCount(4)
  expect(await reminders.evaluateAll((els) => els.map((el) => el.getAttribute('data-reminder')))).toEqual([
    'D1',
    'A3',
    'A2',
    'B5',
  ])
  // D1 超时 14.5 分钟：按整分钟向下取整写 14 分，测试跑过半分钟可能到 15
  await expect(reminders.nth(0)).toContainText(/超时 1[45] 分/)
  await expect(reminders.nth(2)).toContainText(/剩 [56] 分/)
  await expect(reminders.nth(2)).toContainText('李同学')

  // 侧栏卡片的标题都是 6 级标题（标题带个数时 Semi 不再套标题样式，自己包）
  for (const title of ['呼叫店员', '待确认入座', '快到点与超时', '即将到店 · 60 分钟内'])
    await expect(page.locator('.board-side').getByRole('heading', { name: title, level: 6 })).toBeVisible()
  // 待确认入座只列待确认的（过期的不列）；即将到店按开始时间排，只到 60 分钟内；都是列表（ul/li），不是手拼的 div
  await expect(page.locator('[data-admission]')).toHaveCount(1)
  expect(await page.locator('[data-admission="a-new"]').evaluate((el) => el.tagName)).toBe('LI')
  await expect(page.locator('.board-side ul.semi-list-items [data-reservation]')).toHaveCount(3)
  await expect(page.locator('[data-admission="a-new"]')).toContainText('C1 · 小林')
  await expect(page.locator('[data-admission="a-new"]')).toContainText(/\d{2}:\d{2} 申请，\d{2}:\d{2} 前不确认自动失效/)
  const arrivals = page.locator('[data-reservation]')
  expect(await arrivals.evaluateAll((els) => els.map((el) => el.getAttribute('data-reservation')))).toEqual([
    'r-e1',
    'r-b1',
    'r-c2',
  ])
  await expect(arrivals.nth(0)).toContainText('王阿姨 · 尚无账户')
  await expect(arrivals.nth(2).getByRole('button', { name: '确认预约' })).toBeVisible()
  // 待确认的顾客人到了也能直接开台（2026-10-27 起）
  await expect(arrivals.nth(2).getByRole('button', { name: '到店开台' })).toBeVisible()
  // 侧栏第一格是呼叫店员（这里没有顾客呼叫；呼叫的列出与处理见 service-calls.spec.ts）
  await expect(page.locator('.board-side > *').first()).toHaveClass(/service-calls-panel/)
  await expect(page.locator('.service-calls-panel')).toContainText('暂时没有顾客呼叫')
})

test('按座会话：暂停带计时版本，停止计时并去结账先停再建单，跳到结账页', async ({ page }) => {
  const { api } = await openBoard(page)

  await seat(page, 'A1').click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.getByText('会话 · A1')).toBeVisible()
  // 焦点进了抽屉，抽屉有读屏名（Semi 的 SideSheet 不管焦点、也不给 dialog 起名）
  await expect(page.getByRole('dialog', { name: '会话 · A1' })).toBeFocused()
  await expect(sheet).toContainText('小王（138****1234）')
  await expect(sheet).toContainText('套餐「畅玩 2 小时」· 共 120 分钟')
  await expect(sheet).toContainText('¥88.00（待结账订单）')
  await sheet.getByRole('button', { name: '暂停' }).click()
  await expect(page.getByText('A1 已暂停')).toBeVisible()
  expect(writes(api, '/loyalty/actions').at(-1)).toMatchObject({
    body: { action: 'pause', targetId: 's-A1', expectedVersion: 'v-A1' },
    idempotencyKey: expect.any(String),
  })
  // 重读后详情跟着变：暂停中只给「继续」
  await expect(sheet.getByRole('button', { name: '继续' })).toBeVisible()
  await expect(seat(page, 'A1')).toHaveAttribute('data-state', 'paused')

  // 续时按套餐：先确认加收的金额
  await sheet.getByRole('button', { name: /续时 30 分钟/ }).click()
  await expect(page.locator('.semi-modal')).toContainText('追加 30 分钟，加收 ¥20.00')
  await page.locator('.semi-modal button', { hasText: '取消' }).click()

  // Tab 走不到抽屉后面的页面（页面主体 inert）；关掉后焦点回到点的那个座位
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.getElementById('root')?.contains(document.activeElement))).toBe(false)
  }
  await page.locator('.semi-sidesheet-close').click()
  await expect(sheet).toHaveCount(0)
  await expect(seat(page, 'A1')).toBeFocused()
  // Esc 也能关，焦点同样回来
  await seat(page, 'A1').click()
  await expect(page.getByRole('dialog', { name: '会话 · A1' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(seat(page, 'A1')).toBeFocused()

  // 关闭动画期间内容照旧（不先变空白）：盯着抽屉，直到它整个移走
  await seat(page, 'A3').click()
  await expect(sheet.getByText('会话 · A3')).toBeVisible()
  await page.evaluate(() => {
    const flags = window as unknown as { blankWhileClosing?: boolean }
    flags.blankWhileClosing = false
    new MutationObserver(() => {
      const open = document.querySelector('.semi-sidesheet')
      if (!open) return
      const title = open.querySelector('.semi-sidesheet-title')?.textContent?.trim()
      const body = open.querySelector('.semi-sidesheet-body')?.textContent?.trim()
      if (!title || !body) flags.blankWhileClosing = true
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await page.locator('.semi-sidesheet-close').click()
  await expect(sheet).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { blankWhileClosing?: boolean }).blankWhileClosing)).toBe(
    false,
  )
  await seat(page, 'A3').click()
  await expect(sheet.getByText('会话 · A3')).toBeVisible()
  await expect(sheet.locator('[data-timing]')).toHaveText(/已超时 [45] 分钟/)
  await sheet.getByRole('button', { name: '停止计时并去结账' }).click()
  await page.locator('.semi-modal button', { hasText: '停止并去结账' }).click()
  await expect(page).toHaveURL(/\/checkout\/o-s-A3$/)
  const stop = writes(api, '/loyalty/actions').at(-1)
  expect(stop?.body).toEqual({ action: 'stop', targetId: 's-A3', expectedVersion: 'v-A3' })
  expect(writes(api, '/sales-orders')).toEqual([
    expect.objectContaining({ method: 'POST', body: { venueSessionId: 's-A3' }, idempotencyKey: expect.any(String) }),
  ])
  // 落到网页结账页：按座会话的套餐单，明细只读
  await expect(page.getByRole('heading', { name: /^结账 · 订单/ })).toBeVisible()
  await expect(page.getByText(pkg.name).first()).toBeVisible()
})

test('整桌会话：暂停改状态，按分钟续时，去结账直接建单；已停止的按座会话只建单', async ({ page }) => {
  const { api } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')

  await seat(page, 'A2').click()
  await expect(sheet).toContainText('李同学（139****5678）')
  await expect(sheet).toContainText('整桌计时 · 共 120 分钟')
  await sheet.getByRole('button', { name: '暂停' }).click()
  await expect(page.getByText('A2 已暂停')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({ method: 'PATCH', body: { status: 'paused' } })
  await sheet.getByRole('button', { name: '继续' }).click()
  await expect(page.getByText('A2 已继续计时')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)?.body).toEqual({ status: 'active' })

  // 续时发追加的分钟数和看到的时长（不发「读到的 + N」），带幂等键；草稿跟着改了价就报新应收
  await sheet.getByLabel('续时分钟').fill('30')
  await sheet.getByRole('button', { name: '续时', exact: true }).click()
  await expect(page.getByText('A2 已续时 30 分钟')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({
    body: { extendMinutes: 30, expectedDurationMinutes: 120 },
    idempotencyKey: expect.any(String),
  })
  await expect(page.getByText('待结账订单已按新时长改为 ¥108.00')).toBeVisible()
  await expect(sheet).toContainText('整桌计时 · 共 150 分钟')

  // 已停止计时的按座会话（待结账）：不再停止，直接建单
  await page.locator('.semi-sidesheet-close').click()
  await seat(page, 'A5').click()
  await expect(sheet.locator('[data-timing]')).toHaveText('计时已停止，待结账')
  await expect(sheet.getByRole('button', { name: '暂停' })).toHaveCount(0)
  await sheet.getByRole('button', { name: '去结账' }).click()
  await expect(page).toHaveURL(/\/checkout\/o-s-A5$/)
  expect(writes(api, '/loyalty/actions')).toHaveLength(0)
  expect(writes(api, '/sales-orders').map((write) => write.body)).toEqual([{ venueSessionId: 's-A5' }])
})

test('整桌会话停止计时：先确认、带幂等键；停了以后平面图写待结账，只剩换桌、撤销和去结账，去结账直接建单', async ({
  page,
}) => {
  const { api } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A2').click()
  await sheet.getByRole('button', { name: '停止计时' }).click()
  const confirm = page.locator('.semi-modal', { hasText: '座位保留到结账' })
  await expect(confirm).toContainText('计时费按停止这一刻算、不再变；之后不能再暂停、继续或续时。')
  await confirm.getByRole('button', { name: '停止计时' }).click()
  await expect(page.getByText('A2 已停止计时，待结账')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({
    method: 'PATCH',
    body: { stop: true },
    idempotencyKey: expect.any(String),
  })

  await expect(seat(page, 'A2')).toHaveAttribute('data-state', 'stopped')
  await expect(sheet.locator('[data-timing]')).toHaveText('计时已停止，待结账')
  await expect(sheet).toContainText('计时已停止，座位保留到结账；不能再暂停、继续或续时。')
  for (const name of ['暂停', '继续', '停止计时', '标记陪客'])
    await expect(sheet.getByRole('button', { name, exact: true })).toHaveCount(0)
  await expect(sheet.getByLabel('续时分钟')).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: '撤销未结账开台' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: '确认换桌' })).toBeVisible()

  await sheet.getByRole('button', { name: '去结账' }).click()
  await expect(page).toHaveURL(/\/checkout\/o-s-A2$/)
  expect(writes(api, '/sales-orders').map((write) => write.body)).toEqual([{ venueSessionId: 's-A2' }])
})

test('整桌续时按开台时的续时方案给「续 N 分钟」：先确认再追加；对不上套餐的只能自己填', async ({ page }) => {
  const { api } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A2').click()
  await expect(sheet).toContainText('按开台时的续时方案：每 30 分钟 ¥15.00。')
  await expect(sheet.getByRole('button', { name: /^续 / })).toHaveText(['续 30 分钟', '续 1 小时', '续 1 小时 30 分'])
  await sheet.getByRole('button', { name: '续 1 小时', exact: true }).click()
  const confirm = page.locator('.semi-modal', { hasText: '追加 1 小时？' })
  await expect(confirm).toContainText('按开台时的续时方案（每 30 分钟 ¥15.00）记进待结账订单')
  await confirm.getByRole('button', { name: '确认续时' }).click()
  await expect(page.getByText('A2 已续时 1 小时')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({
    body: { extendMinutes: 60, expectedDurationMinutes: 120 },
    idempotencyKey: expect.any(String),
  })

  await page.locator('.semi-sidesheet-close').click()
  await seat(page, 'B5').click()
  await expect(sheet.getByRole('button', { name: /^续 / })).toHaveCount(0)
  await expect(sheet).toContainText('这一台的时长对不上有续时方案的套餐：续多久自己填，结账时要填计时费。')
  await expect(sheet.getByLabel('续时分钟')).toBeVisible()
})

test('整桌续时后草稿没跟着改价（明细被员工改过）：弹窗说明，点一下去结账页核对', async ({ page }) => {
  await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'D1').click()
  await sheet.getByLabel('续时分钟').fill('15')
  await sheet.getByRole('button', { name: '续时', exact: true }).click()
  const review = page.locator('.semi-modal', { hasText: '请核对待结账订单' })
  await expect(review).toContainText('没有按新时长自动改价（现在应收 ¥66.00）')
  await review.locator('button', { hasText: '去结账页核对' }).click()
  await expect(page).toHaveURL(/\/checkout\/o-s-D1$/)
})

test('陪客会话：平面图写「陪客中」，详情里没有暂停、继续', async ({ page }) => {
  await openBoard(page)
  await expect(seat(page, 'B3')).toHaveAttribute('data-state', 'companion')
  await seat(page, 'B3').click()
  const sheet = page.locator('.semi-sidesheet')
  await expect(sheet.locator('.semi-tag', { hasText: '陪客中' })).toBeVisible()
  await expect(sheet).toContainText('陪客不计时，不能暂停或继续。')
  await expect(sheet.getByRole('button', { name: '暂停' })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: '继续' })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: '去结账' })).toBeVisible()
})

// 续时的响应丢了（其实已经续上）：看板重读后时长已变，员工再点一次续时，不能续成两次。
// 网页先把上一次那一条原样（原请求体、原幂等键）重发，后端重放出成功，就说明上次已生效、这次不提交。
test('结果未知后重读再点续时：先原样重发上一次，已生效就提醒、不再续一次', async ({ page }) => {
  const { api, backend } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'B5').click()
  await expect(sheet).toContainText('整桌计时 · 共 120 分钟')
  backend.network.loseNextReply = true
  await sheet.getByLabel('续时分钟').fill('30')
  await sheet.getByRole('button', { name: '续时', exact: true }).click()
  await expect(sheet.locator('.semi-banner-danger')).toBeVisible()
  // 失败后重读：其实已经续上了
  await expect(sheet).toContainText('整桌计时 · 共 150 分钟')

  await sheet.getByLabel('续时分钟').fill('30')
  await sheet.getByRole('button', { name: '续时', exact: true }).click()
  const notice = sheet.locator('.semi-banner-warning')
  await expect(notice).toContainText('上一次没收到结果的那次操作其实已经生效，这一次没有提交')
  const sent = writes(api, '/venue-sessions/s-B5')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(sent[1].body).toEqual({ extendMinutes: 30, expectedDurationMinutes: 120 })
  expect(backend.sessions.find((s) => s.id === 's-B5')?.durationMinutes).toBe(150)
  await expect(sheet).toContainText('整桌计时 · 共 150 分钟')
})

/** 下拉框里的一项（Semi 的候选是 role=option，不能选的 aria-disabled）。按整段文字找，「A2」不会找到「A2 · 当前所在」。 */
const option = (page: Page, text: string) =>
  page.locator('.semi-select-option').filter({ hasText: new RegExp(`^${text}$`) })

test('整桌会话换桌：不能选的灰着写明原因，目标桌有预约先提醒、被拒显示原话；换过去后抽屉关上、平面图跟着变', async ({
  page,
}, testInfo) => {
  const { api } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A2').click()
  await expect(sheet.getByText('会话 · A2')).toBeVisible()
  // 不再写「仍在小程序桌位页」
  await expect(sheet).not.toContainText('小程序桌位页')
  const picker = sheet.getByRole('combobox', { name: '换桌' })
  await expect(picker).toHaveAccessibleDescription(/只能选空闲、启用的桌/)
  await expect(sheet.getByRole('button', { name: '确认换桌' })).toBeDisabled()

  await picker.click()
  for (const text of ['A2 · 当前所在', 'B2 · 停用', 'A1 · 使用中', 'A3 · 已超时', 'A4 · 暂停', 'B3 · 陪客中'])
    await expect(option(page, text)).toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'D1 · 整桌 · 已超时')).toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'B4')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'D2 · 整桌')).not.toHaveAttribute('aria-disabled', 'true')
  await page.screenshot({ path: testInfo.outputPath('换桌-候选.png') })

  // 目标桌今天还有预约：先提醒；后端拒绝时原话写在这一段里
  await option(page, 'E1').click()
  const warning = sheet.locator('.semi-banner-warning')
  await expect(warning).toContainText('E1 今天还有预约')
  await expect(warning).toContainText('王阿姨（已确认）')
  await sheet.getByRole('button', { name: '确认换桌' }).click()
  await expect(sheet.locator('.semi-banner-danger')).toContainText('目标桌在这个时间段已有预约')
  await page.screenshot({ path: testInfo.outputPath('换桌-被预约.png') })
  expect(writes(api, '/venue-sessions/s-A2')).toEqual([
    expect.objectContaining({ method: 'PATCH', body: { serviceTableId: 't-E1' }, idempotencyKey: expect.any(String) }),
  ])
  await expect(seat(page, 'A2')).toHaveAttribute('data-state', 'expiring')

  await picker.click()
  await option(page, 'B4').click()
  await expect(warning).toHaveCount(0)
  await sheet.getByRole('button', { name: '确认换桌' }).click()
  await expect(page.locator('.semi-toast').getByText('A2 已换到 B4')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({
    method: 'PATCH',
    body: { serviceTableId: 't-B4' },
    idempotencyKey: expect.any(String),
  })
  // 看板以重读为准：A2 空出来，B4 接着倒数
  await expect(seat(page, 'A2')).toHaveAttribute('data-state', 'free')
  await expect(seat(page, 'B4')).toHaveAttribute('data-state', 'expiring')
  await seat(page, 'B4').click()
  await expect(sheet).toContainText('李同学（139****5678）')
})

test('按座会话换座（店员）：带计时版本和座号，双人桌分座；按座的没有陪客和撤销', async ({ page }) => {
  const { api } = await openBoard(page, ['clerk'])
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A1').click()
  await expect(sheet.getByText('会话 · A1')).toBeVisible()
  // 同小程序：按座会话没有陪客、撤销开台，说明为什么
  await expect(sheet.getByRole('button', { name: '标记陪客' })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: '撤销未结账开台' })).toHaveCount(0)
  await expect(sheet).toContainText('按座计时没有陪客，也不能当误开撤销')

  const picker = sheet.getByRole('combobox', { name: '换座' })
  await expect(picker).toHaveAccessibleDescription(/计时和套餐照旧/)
  await picker.click()
  await expect(option(page, 'A1 · 当前座位')).toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'D1 · 1 号座 · 已超时')).toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'D1 · 2 号座 · 已超时')).toHaveAttribute('aria-disabled', 'true')
  await expect(option(page, 'D2 · 1 号座')).not.toHaveAttribute('aria-disabled', 'true')
  await option(page, 'D2 · 2 号座').click()
  await sheet.getByRole('button', { name: '确认换座' }).click()
  await expect(page.locator('.semi-toast').getByText('A1 已换到 D2 · 2 号座')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(writes(api, '/loyalty/actions').at(-1)).toMatchObject({
    body: { action: 'move', targetId: 's-A1', expectedVersion: 'v-A1', serviceTableId: 't-D2', seatNumber: 2 },
    idempotencyKey: expect.any(String),
  })
  await expect(seat(page, 'A1')).toHaveAttribute('data-state', 'free')
  await expect(seat(page, 'D2')).toHaveAttribute('data-state', 'running')
  await seat(page, 'D2').click()
  await expect(sheet).toContainText('小王（138****1234）')
})

test('整桌会话标记陪客先确认（写清后果，改不回）、带幂等键，结果未知以重读为准；撤销误开先确认（危险样式、写清后果），撤销后座位空出', async ({
  page,
}, testInfo) => {
  const { api, backend } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'B5').click()
  await expect(sheet.getByText('会话 · B5')).toBeVisible()
  await expect(sheet).toContainText('标错了只能撤销开台后重开')
  await page.screenshot({ path: testInfo.outputPath('整桌会话-不常用操作.png') })

  // 陪客标了就改不回：先确认，写清后果；确认按钮写具体动作、危险样式，打开时焦点在「取消」上；取消什么也不发
  await sheet.getByRole('button', { name: '标记陪客' }).click()
  const companion = page.locator('.semi-modal', { hasText: '标记为陪客后' })
  await expect(companion).toContainText('B5 标记为陪客后')
  await expect(companion).toContainText('不计时，不收计时费')
  await expect(companion).toContainText('不能再暂停或继续')
  await expect(companion).toContainText('改不回普通计时。标错了只能撤销开台后重开')
  await expect(companion.getByRole('button', { name: '标记为陪客' })).toHaveClass(/semi-button-danger/)
  await expect(companion.getByRole('button', { name: '取消' })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('标记陪客-确认.png') })
  await companion.getByRole('button', { name: '取消' }).click()
  await expect(companion).toHaveCount(0)
  expect(writes(api, '/venue-sessions/s-B5')).toEqual([])

  // 标上了但回包丢了：显示没收到结果，重读后看到的已是陪客（以接口为准，不在前端推）
  backend.network.loseNextReply = true
  await sheet.getByRole('button', { name: '标记陪客' }).click()
  await companion.getByRole('button', { name: '标记为陪客' }).click()
  await expect(sheet.locator('.semi-banner-danger')).toBeVisible()
  await expect(sheet.locator('.semi-tag', { hasText: '陪客中' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: '已标记陪客' })).toBeDisabled()
  await expect(sheet.getByRole('button', { name: '暂停' })).toHaveCount(0)
  expect(writes(api, '/venue-sessions/s-B5')).toEqual([
    expect.objectContaining({ method: 'PATCH', body: { status: 'companion' }, idempotencyKey: expect.any(String) }),
  ])

  // 撤销：先确认，确认按钮是危险样式，写清后果；取消什么也不发
  await sheet.getByRole('button', { name: '撤销未结账开台' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '撤销开台' })
  await expect(dialog).toContainText('B5 这一台撤销后')
  await expect(dialog).toContainText('计时作废，不收计时费')
  await expect(dialog).toContainText('待结账订单（如有）一并作废，订单显示「已撤销」')
  await expect(dialog).toContainText('撤销不能恢复')
  await expect(dialog.getByRole('button', { name: '确认撤销' })).toHaveClass(/semi-button-danger/)
  // 打开时焦点在「取消」上（Semi 弹窗的默认），误按回车不会撤销
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('撤销开台-确认.png') })
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes(api, '/venue-sessions/s-B5').filter((write) => write.method === 'DELETE')).toHaveLength(0)

  await sheet.getByRole('button', { name: '撤销未结账开台' }).click()
  await dialog.getByRole('button', { name: '确认撤销' }).click()
  await expect(page.locator('.semi-toast').getByText('B5 已撤销开台')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(writes(api, '/venue-sessions/s-B5').at(-1)).toMatchObject({ method: 'DELETE', path: '/venue-sessions/s-B5' })
  await expect(seat(page, 'B5')).toHaveAttribute('data-state', 'free')
})

// 换桌请求没到后端就断了（502，什么也没改）：重读后会话还在原处，员工再点一次，网页用同一个幂等键原样重发，只换一次。
test('换桌结果未知：再点同一按钮原样重发（同一个幂等键），只换一次', async ({ page }) => {
  const { api, backend } = await openBoard(page)
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A6').click()
  await sheet.getByRole('combobox', { name: '换桌' }).click()
  await option(page, 'B6').click()
  backend.network.dropNextPatch = true
  await sheet.getByRole('button', { name: '确认换桌' }).click()
  await expect(sheet.locator('.semi-banner-danger')).toBeVisible()
  await expect(seat(page, 'A6')).toHaveAttribute('data-state', 'running')
  await expect(seat(page, 'B6')).toHaveAttribute('data-state', 'free')

  await sheet.getByRole('button', { name: '确认换桌' }).click()
  await expect(page.locator('.semi-toast').getByText('A6 已换到 B6')).toBeVisible()
  const sent = writes(api, '/venue-sessions/s-A6')
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(sent[1].body).toEqual({ serviceTableId: 't-B6' })
  await expect(seat(page, 'B6')).toHaveAttribute('data-state', 'running')
  await expect(seat(page, 'A6')).toHaveAttribute('data-state', 'free')
})

test('确认扫码入座，确认预约，没关联账户的预约到店选上账户再开台', async ({ page }) => {
  const { api, backend } = await openBoard(page, ['clerk'])
  // 店员也能看到「现场」
  await expect(page.locator('.semi-navigation-item-text', { hasText: '现场' })).toBeVisible()

  await page.locator('[data-admission="a-new"]').getByRole('button', { name: '确认开台' }).click()
  await expect(page.locator('.semi-modal')).toContainText('畅玩 2 小时 · 120 分钟 · ¥88.00')
  await page.locator('.semi-modal button', { hasText: '确认开台' }).click()
  await expect(page.getByText('C1 已开台，开始计时')).toBeVisible()
  expect(writes(api, '/loyalty/actions').at(-1)).toMatchObject({
    body: { action: 'confirm', targetId: 'a-new' },
    idempotencyKey: expect.any(String),
  })

  await page.locator('[data-reservation="r-c2"]').getByRole('button', { name: '确认预约' }).click()
  await expect(page.getByText('预约已确认')).toBeVisible()
  expect(writes(api, '/reservations/actions').at(-1)?.body).toEqual({ action: 'confirm', targetId: 'r-c2' })

  // 有账户的预约：确认后开台。确认框写后端实际会用的现行套餐，预约之后改过价的另行说明
  await page.locator('[data-reservation="r-b1"]').getByRole('button', { name: '到店开台' }).click()
  await expect(page.locator('.semi-modal')).toContainText(
    '按现行套餐「畅玩 2 小时」开台计时（120 分钟，¥88.00），生成套餐的待结账订单。',
  )
  await expect(page.locator('.semi-modal')).toContainText('预约时是「畅玩 2 小时」120 分钟、¥78.00，套餐之后改过')
  await page.locator('.semi-modal button', { hasText: '到店开台' }).click()
  await expect(page.getByText('B1 已到店开台，开始计时')).toBeVisible()
  expect(writes(api, '/reservations/actions').at(-1)?.body).toEqual({ action: 'seat', targetId: 'r-b1' })

  // 没关联账户的预约：选上到店顾客的账户再开台（不选就当散客开台，见「预约」页的用例）
  await page.locator('[data-reservation="r-e1"]').getByRole('button', { name: '到店开台' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '没关联账户的预约' })
  await expect(dialog.locator('button', { hasText: '当散客开台' })).toBeEnabled()
  // 打开时焦点在顾客选择框上（不是「取消」）
  await expect(page.getByRole('combobox', { name: '到店顾客的账户（可不选）' })).toBeFocused()
  await expect(dialog).toContainText('按现行套餐「畅玩 2 小时」开台计时（120 分钟，¥88.00）')
  await expect(dialog).not.toContainText('预约时是')
  await dialog.locator('.semi-select').click()
  await page.keyboard.type('王阿')
  await page.locator('.semi-select-option', { hasText: '王阿姨' }).click()
  await expect(dialog.locator('.semi-select')).toContainText('王阿姨（133****3333）')
  // 后端拒绝（座位刚被占）：弹窗不关，原因写在弹窗里，选好的顾客还在
  backend.network.failNextSeat = true
  await dialog.locator('button', { hasText: '关联账户并开台' }).click()
  await expect(dialog.getByText('该桌位正在使用中')).toBeVisible()
  await expect(dialog.locator('.semi-select')).toContainText('王阿姨（133****3333）')
  await dialog.locator('button', { hasText: '关联账户并开台' }).click()
  await expect(page.getByText('E1 已到店开台，开始计时')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(writes(api, '/reservations/actions').at(-1)?.body).toEqual({
    action: 'seat',
    targetId: 'r-e1',
    accountId: 'u-aunt',
  })
})

test('系统内收费关着：不显示价格和结账，用完点「结束」放座；确认入座时可以改团购记录', async ({ page }) => {
  const { api } = await openBoard(page, ['clerk'], false)
  // 侧栏没有订单
  await expect(page.locator('.semi-navigation-item-text', { hasText: '现场' })).toBeVisible()
  await expect(page.locator('.semi-navigation-item-text', { hasText: '订单与退款' })).toHaveCount(0)

  // 待确认入座：套餐只写时长，带上顾客记下的团购
  const row = page.locator('[data-admission="a-new"]')
  await expect(row).toContainText('畅玩 2 小时 · 120 分钟')
  await expect(row).not.toContainText('¥')
  await expect(row).toContainText('团购：美团 · 券码 1234 5678 9012')
  await row.getByRole('button', { name: '确认开台' }).click()
  const modal = page.locator('.semi-modal', { hasText: '确认后开始计时' })
  await expect(modal).toContainText('顾客的团购请在美团开店宝验券')
  await expect(modal).not.toContainText('¥')
  await expect(modal.getByRole('radio', { name: '美团' })).toBeChecked()
  const code = modal.getByLabel('券码')
  await expect(code).toHaveValue('123456789012')
  // 券码填错：说明落在框下，确认按钮不能点
  await code.fill('1234-5678')
  await expect(modal.getByText('券码只能是字母和数字')).toBeVisible()
  await expect(modal.locator('button', { hasText: '确认开台' })).toBeDisabled()
  // 改成大众点评，券码照手机上分段抄，提交时去掉空格
  await modal.locator('.semi-radio', { hasText: '大众点评' }).click()
  await code.fill('9876 5432')
  await modal.locator('button', { hasText: '确认开台' }).click()
  await expect(page.getByText('C1 已开台，开始计时')).toBeVisible()
  expect(writes(api, '/loyalty/actions').at(-1)?.body).toEqual({
    action: 'confirm',
    targetId: 'a-new',
    coupon: { platform: 'dianping', code: '98765432' },
  })

  // 按座会话：没有应收和去结账，只有「结束」；结束带计时版本，抽屉关上、座位空出
  const sheet = page.locator('.semi-sidesheet')
  await seat(page, 'A1').click()
  await expect(sheet.getByText('会话 · A1')).toBeVisible()
  await expect(sheet).not.toContainText('¥')
  await expect(sheet.getByRole('button', { name: /去结账/ })).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: /停止计时/ })).toHaveCount(0)
  await sheet.getByRole('button', { name: '结束', exact: true }).click()
  const confirm = page.locator('.semi-modal', { hasText: '结束计时，座位立刻空出来' })
  await expect(confirm.getByRole('button', { name: '结束并放座' })).toHaveClass(/semi-button-danger/)
  await confirm.getByRole('button', { name: '结束并放座' }).click()
  await expect(page.getByText('A1 已结束，座位已空出')).toBeVisible()
  await expect(sheet).toHaveCount(0)
  expect(writes(api, '/loyalty/actions').at(-1)).toMatchObject({
    body: { action: 'end', targetId: 's-A1', expectedVersion: 'v-A1' },
    idempotencyKey: expect.any(String),
  })
  await expect(seat(page, 'A1')).toHaveAttribute('data-state', 'free')

  // 整桌会话：PATCH end，带幂等键
  await seat(page, 'A2').click()
  await expect(sheet).toContainText('整桌计时 · 共 120 分钟')
  await sheet.getByRole('button', { name: '结束', exact: true }).click()
  await page.locator('.semi-modal').getByRole('button', { name: '结束并放座' }).click()
  await expect(page.getByText('A2 已结束，座位已空出')).toBeVisible()
  expect(writes(api, '/venue-sessions/s-A2').at(-1)).toMatchObject({
    method: 'PATCH',
    body: { end: true },
    idempotencyKey: expect.any(String),
  })
  await expect(seat(page, 'A2')).toHaveAttribute('data-state', 'free')
  expect(writes(api, '/sales-orders')).toHaveLength(0)

  // 开台：时长按钮照样按已发布的套餐列，不标价
  await seat(page, 'B4').click()
  const open = page.locator('.semi-sidesheet', { hasText: '确认开台' })
  await expect(open.getByText('开台 · B4')).toBeVisible()
  await expect(open.getByRole('group', { name: '计时' }).locator('.semi-radio')).toHaveText([
    '1 小时',
    '2 小时',
    '3 小时',
    /^到打烊/,
    '自由计时没有结束时间',
  ])
  await expect(open).not.toContainText('¥')
})

/** 门店时区（中国标准时间）的日期与「时:分」。 */
function storeParts(ms: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` }
}
/** 门店某天「时:分」那一刻的 ISO 时间。 */
const storeIso = (day: string, clock: string) => new Date(`${day}T${clock}:00+08:00`).toISOString()

const openSheet = (page: Page) => page.locator('.semi-sidesheet', { hasText: '确认开台' })
const pickTiming = (page: Page, text: string) => openSheet(page).locator('.semi-radio', { hasText: text }).click()
/** 开台面板里找顾客的下拉框（面板里另有「其他时长」下拉框）。 */
const customerSelect = (page: Page) =>
  openSheet(page).getByRole('group', { name: '顾客', exact: true }).locator('.semi-select')
/** 在开台面板里找顾客：候选项是昵称加打码手机号两行，选中后框里写「昵称（手机号）」。 */
const pickCustomer = async (page: Page, keyword: string, nickname: string, selected: string) => {
  await customerSelect(page).click()
  await page.keyboard.type(keyword)
  await page.locator('.semi-select-option', { hasText: nickname }).click()
  await expect(customerSelect(page)).toContainText(selected)
}
const otherSelect = (page: Page) => openSheet(page).getByRole('combobox', { name: '其他时长' })
/** 「其他时长」里选一个。Semi 受控下拉框收起动画放完才通知选择：等框里写出选的时长再往下，不然这次选择会丢。 */
const pickOther = async (page: Page, text: string) => {
  await otherSelect(page).click()
  await option(page, text).click()
  await expect(otherSelect(page)).toContainText(text)
}

test('点空座位开台：时长按已发布套餐列、默认第二个，提交那一刻开始；其他时长；选顾客、自由计时、回填当天更早的时间', async ({
  page,
}) => {
  const { api } = await openBoard(page)
  const sheet = openSheet(page)

  await seat(page, 'B4').click()
  await expect(sheet.getByText('开台 · B4')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '开台 · B4' })).toBeFocused()
  await expect(sheet).toContainText('B4（B 区）')
  // 时长按钮是已发布计时套餐的时长、标价（同小程序开台弹层）；到打烊的「全天不限时」就是「到打烊」，不另列
  const timing = sheet.getByRole('group', { name: '计时' })
  await expect(timing.locator('.semi-radio')).toHaveText([
    '1 小时¥48.00',
    '2 小时¥88.00',
    '3 小时¥128.00',
    /^到打烊/,
    '自由计时没有结束时间',
  ])
  await expect(sheet.getByRole('radio', { name: '2 小时' })).toBeChecked()
  await expect(sheet.locator('[data-open-summary]')).toHaveText('散客 · 2 小时 · 现在开始')
  await expect(sheet).toContainText('店长、老板可回填今天更早的开始时间')

  // 其他时长：30 分钟一档到 8 小时，按钮上已有的 1、2、3 小时不重复列；选了它单选组一个都不勾
  await otherSelect(page).click()
  await expect(page.locator('.semi-select-option')).toHaveText([
    '30 分钟',
    '1 小时 30 分',
    '2 小时 30 分',
    '3 小时 30 分',
    '4 小时',
    '4 小时 30 分',
    '5 小时',
    '5 小时 30 分',
    '6 小时',
    '6 小时 30 分',
    '7 小时',
    '7 小时 30 分',
    '8 小时',
  ])
  await option(page, '2 小时 30 分').click()
  await expect(otherSelect(page)).toContainText('2 小时 30 分')
  await expect(timing.getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(sheet.locator('[data-open-summary]')).toHaveText('散客 · 2 小时 30 分 · 现在开始')
  // 再点时长按钮：下拉框回到没选的样子
  await pickTiming(page, '3 小时')
  await expect(sheet.getByRole('radio', { name: '3 小时' })).toBeChecked()
  await expect(otherSelect(page)).toContainText('其他时长')
  await expect(sheet.locator('[data-open-summary]')).toHaveText('散客 · 3 小时 · 现在开始')
  // 每一组的标题、说明都接在组上（单选组、下拉框自己不带可见标题）
  await expect(sheet.getByRole('group', { name: '计时' })).toHaveAccessibleDescription(
    '这里只管计时。实际收多少钱，结账时按商品或套餐算。',
  )

  // 开始时间没动：不带开始时间，由服务器在收到请求时开始计（既不是打开面板的那一刻，也不看电脑时钟）
  await sheet.getByRole('button', { name: '确认开台' }).click()
  await expect(page.locator('.semi-toast').getByText('B4 已开台，开始计时')).toBeVisible()
  await expect(sheet).toBeHidden()
  // 开完台焦点回到点的那个座位
  await expect(seat(page, 'B4')).toBeFocused()
  const first = writes(api, '/venue-sessions')
  expect(first).toHaveLength(1)
  // 「现在」开台不带开始时间：服务器收到时开始计，不看这台电脑的时钟（电脑比服务器快时会被当成未来时间拒绝）
  expect(first[0].body).toEqual({
    serviceTableId: 't-B4',
    timingMode: 'timed',
    durationMinutes: 180,
  })
  // 契约里开台不收幂等键
  expect(first[0].idempotencyKey).toBeUndefined()
  // 看板随实时事件重读：这张桌成了使用中，再点开的是会话详情
  await expect(seat(page, 'B4')).toHaveAttribute('data-state', 'running')

  await seat(page, 'B6').click()
  await expect(sheet.getByText('开台 · B6')).toBeVisible()
  await pickCustomer(page, '小王', '小王', '小王（138****1234）')
  await pickTiming(page, '自由计时')
  await sheet.locator('.semi-radio', { hasText: '回填更早的时间' }).click()
  // 店长、老板可回填当天：20 分钟前（刚过零点就取今天 0 点）
  const now = Date.now()
  const today = storeParts(now).day
  const earlier = storeParts(now - 20 * 60_000)
  const clock = earlier.day === today ? earlier.clock : '00:00'
  const time = sheet.getByLabel('回填的开始时间')
  await time.fill(clock)
  await expect(sheet.locator('[data-open-summary]')).toHaveText(`小王（138****1234） · 自由计时 · ${clock} 开始`)
  await sheet.getByRole('button', { name: '确认开台' }).click()
  await expect(page.locator('.semi-toast').getByText('B6 已开台，开始计时')).toBeVisible()
  expect(writes(api, '/venue-sessions').at(-1)?.body).toEqual({
    serviceTableId: 't-B6',
    accountId: 'u-wang',
    startedAt: storeIso(today, clock),
    timingMode: 'free',
  })
  await expect(seat(page, 'B6')).toHaveAttribute('data-state', 'running')
})

test('座位被预约：后端拒绝的原话显示在面板上，选好的顾客、时长都保留', async ({ page }, testInfo) => {
  const { api } = await openBoard(page)
  const sheet = openSheet(page)
  await seat(page, 'E1').click()
  // 先提醒这张桌今天还有预约
  await expect(sheet.locator('.semi-banner-warning')).toContainText('这张桌今天还有预约')
  await expect(sheet.locator('.semi-banner-warning')).toContainText('王阿姨（已确认）')
  await pickCustomer(page, '王阿', '王阿姨', '王阿姨（133****3333）')
  await pickOther(page, '2 小时 30 分')
  await sheet.getByRole('button', { name: '确认开台' }).click()
  await expect(sheet.locator('.semi-banner-danger')).toContainText('该桌在这个时间段已有预约，请先处理预约或更换桌位')
  expect(writes(api, '/venue-sessions')).toEqual([
    expect.objectContaining({ body: expect.objectContaining({ timingMode: 'timed', durationMinutes: 150 }) }),
  ])
  // 面板还开着，输入原样保留，可以改了再试
  await expect(sheet.getByText('开台 · E1')).toBeVisible()
  await expect(customerSelect(page)).toContainText('王阿姨（133****3333）')
  await expect(otherSelect(page)).toContainText('2 小时 30 分')
  await expect(sheet.locator('[data-open-summary]')).toHaveText('王阿姨（133****3333） · 2 小时 30 分 · 现在开始')
  await expect(seat(page, 'E1')).toHaveAttribute('data-state', 'free')
  await page.screenshot({ path: testInfo.outputPath('开台-被预约.png') })

  // 改回散客：清掉选中的顾客
  await customerSelect(page).hover()
  await customerSelect(page).locator('.semi-select-clear').click()
  await expect(sheet.locator('[data-open-summary]')).toHaveText('散客 · 2 小时 30 分 · 现在开始')
  await sheet.getByRole('button', { name: '取消' }).click()
  await expect(sheet).toBeHidden()
})

test('店员：停用的座位不开台只提示，使用中的仍开详情；回填只能 60 分钟内，默认填上此刻', async ({ page }) => {
  const { api } = await openBoard(page, ['clerk'])
  await seat(page, 'B2').click()
  await expect(page.locator('.semi-toast').getByText('B2 已停用，不能开台')).toBeVisible()
  await expect(page.getByText('开台 · B2')).toHaveCount(0)

  await seat(page, 'A2').click()
  const detail = page.locator('.semi-sidesheet')
  await expect(detail.getByText('会话 · A2')).toBeVisible()
  await expect(detail.getByRole('button', { name: '确认开台' })).toHaveCount(0)
  await detail.locator('.semi-sidesheet-close').click()

  await seat(page, 'B7').click()
  const sheet = openSheet(page)
  await expect(sheet).toContainText('店员可回填最近 60 分钟内的开始时间，不能晚于现在。')
  await sheet.locator('.semi-radio', { hasText: '回填更早的时间' }).click()
  const time = sheet.getByLabel('回填的开始时间')
  await expect(time).toHaveValue(/^\d{2}:\d{2}$/)
  const clock = await time.inputValue()
  const day = storeParts(Date.now()).day
  await sheet.getByRole('button', { name: '确认开台' }).click()
  await expect(page.locator('.semi-toast').getByText('B7 已开台，开始计时')).toBeVisible()
  // 时长没动：默认的第二个时长按钮（2 小时）
  expect(writes(api, '/venue-sessions')).toEqual([
    expect.objectContaining({
      body: { serviceTableId: 't-B7', startedAt: storeIso(day, clock), timingMode: 'timed', durationMinutes: 120 },
    }),
  ])
})

test('实时断开时看板标出「实时 · 已断开」，并每 10 秒重读一次', async ({ page }) => {
  test.setTimeout(60_000)
  const { api, backend } = await openBoard(page)
  const status = page.locator('.board-status')
  await expect(status).toContainText('实时 · 已连接')
  // 之后的重连交给真后端：拿着模拟的令牌握手会被拒，连接一直断着
  await page.routeWebSocket('**/api/v2/event-streams', (ws) => ws.connectToServer())
  await api.sockets[0].close()
  await expect(status).toContainText(/实时 · (已断开|正在连接)/)
  await expect(status).toContainText('每 10 秒重读')
  const before = backend.reads.tables
  await expect.poll(() => backend.reads.tables, { timeout: 15_000 }).toBeGreaterThan(before)
  expect(api.sockets).toHaveLength(1)
})

/** 版式问题：整页横向溢出、座位框出了底图、侧栏的字被截断或伸出屏幕。 */
function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const vw = window.innerWidth
    if (document.documentElement.scrollWidth > vw + 1) out.push(`整页横向溢出 ${document.documentElement.scrollWidth}`)
    const plan = document.querySelector('.board-plan')!.getBoundingClientRect()
    for (const el of document.querySelectorAll('[data-seat]')) {
      const r = el.getBoundingClientRect()
      if (r.left < plan.left - 1 || r.right > plan.right + 1 || r.top < plan.top - 1 || r.bottom > plan.bottom + 1)
        out.push(`座位出了底图：${el.getAttribute('data-seat')}`)
    }
    // 侧栏里的标签（「超时 15 分」、预约状态）不能被长称呼挤成省略号
    for (const el of document.querySelectorAll('.board-side .semi-tag-content')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`文字被截断：${el.textContent}`)
    }
    for (const el of document.querySelectorAll('.board-side button, .board-side .semi-tag')) {
      const r = el.getBoundingClientRect()
      if (r.width && r.right > vw + 1) out.push(`超出屏幕右边：${(el.textContent || '').slice(0, 10)}`)
    }
    return out
  })
}

for (const viewport of [
  { name: '电脑', width: 1440, height: 900 },
  { name: '平板', width: 1024, height: 768 },
] as const) {
  test(`${viewport.name} ${viewport.width}：不溢出，座位框在图内，全屏藏起侧栏`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openBoard(page)
    await expect(page.locator('[data-reminder]')).toHaveCount(4)
    await page.waitForTimeout(200)
    expect(await layoutProblems(page)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`现场-${viewport.name}.png`), fullPage: true })

    await page.getByRole('button', { name: '全屏' }).click()
    await expect(page.locator('.semi-layout-sider')).toBeHidden()
    await expect(page.locator('.admin-header')).toBeHidden()
    await page.waitForTimeout(300)
    expect(await layoutProblems(page)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`现场-${viewport.name}-全屏.png`), fullPage: true })
    await seat(page, 'A3').click()
    await expect(page.locator('.semi-sidesheet').getByText('会话 · A3')).toBeVisible()
    await page.waitForTimeout(300)
    // 换座那一行（下拉框加确认按钮）不把抽屉撑出横向滚动
    expect(
      await page
        .locator('.semi-sidesheet-body')
        .evaluate((body) => [body.scrollWidth, body.clientWidth])
        .then(([scroll, client]) => scroll <= client + 1),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`现场-${viewport.name}-会话详情.png`) })
    await page.locator('.semi-sidesheet-close').click()
    // 开台面板：计时选项排成网格、回填的时间选择器都在侧栏里，不横向溢出
    await seat(page, 'D2').click()
    const sheet = openSheet(page)
    await expect(sheet.getByText('开台 · D2')).toBeVisible()
    await sheet.locator('.semi-radio', { hasText: '回填更早的时间' }).click()
    await expect(sheet.getByLabel('回填的开始时间')).toBeVisible()
    await page.waitForTimeout(300)
    expect(
      await sheet
        .locator('.semi-sidesheet-body')
        .evaluate((body) => [body.scrollWidth, body.clientWidth])
        .then(([scroll, client]) => scroll <= client + 1),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`现场-${viewport.name}-开台.png`) })
    await sheet.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: '退出全屏' }).click()
    await expect(page.locator('.semi-layout-sider')).toBeVisible()
  })
}
