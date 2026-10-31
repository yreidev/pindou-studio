import { expect, test, type Page } from '@playwright/test'
import { accountListResult } from './account-list'
import { mockApi, signIn, type MockApi, type MockHandler } from './mock-api'

// 「预约」页：同小程序员工「预约」页——按门店日期、状态看还要处理的预约，处理完的服务端分页；确认、取消与爽约（当场问原因）、
// 到店开台（和看板同一套：现行套餐确认框；没关联账户的可以选账户，也可以当散客开台）、详情抽屉；代客登记（顾客或称呼、套餐、日期时段、座位，
// 已约的不能选、现场计时中的只提示、歇业日只提示）。写操作带幂等键，结果未知后再点先原样重发上一次。
// 接口照 docs/api.yaml 模拟，时间按此刻现算。

type Json = Record<string, unknown>

const customers = [
  { id: 'u-wang', nickname: '小王', phoneMasked: '138****1234' },
  { id: 'u-li', nickname: '李同学', phoneMasked: '139****5678' },
  { id: 'u-aunt', nickname: '王阿姨', phoneMasked: '133****3333' },
]

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

const codes = ['A1', 'A2', 'A3', 'D1']
const tables = codes.map((code, index) => ({
  id: `t-${code}`,
  code,
  zone: code[0],
  number: index + 1,
  seatCount: code === 'D1' ? 2 : 1,
  wholeTable: code === 'D1',
  occupiedSeats: [],
  floorAreaId: `area-${code[0]}`,
  floorAreaName: `${code[0]} 区`,
}))

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
const storeIso = (day: string, clock: string) => new Date(`${day}T${clock}:00+08:00`).toISOString()

/** 模拟后端：还要处理的与处理完的预约；写操作改到状态上（下一次读就是新的），按幂等键重放上次的结果。 */
function reservationsBackend() {
  const now = Date.now()
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
  const tomorrow = storeParts(now + 86_400_000).day
  const entry = (
    id: string,
    code: string,
    start: string,
    displayStatus: string,
    extra: Json = {},
    seatNumber = 1,
  ): Json => {
    const accountId = extra.accountId as string | undefined
    const person = customers.find((c) => c.id === accountId)
    return {
      reservation: {
        id,
        serviceTableId: `t-${code}`,
        seatNumber,
        packageId: pkg.id,
        packageName: pkg.name,
        durationMinutes: 120,
        amountCents: 8800,
        startAt: start,
        status: displayStatus === 'expired' ? 'confirmed' : displayStatus,
        createdBy: 'u-owner',
        createdAt: at(-600),
        ...extra,
      },
      displayStatus,
      endAt: new Date(Date.parse(start) + 120 * 60_000).toISOString(),
      tableNumber: codes.indexOf(code) + 1,
      ...(person
        ? { customerName: person.nickname, phoneMasked: person.phoneMasked }
        : { customerName: String(extra.guestName ?? '') }),
    }
  }
  const open: Json[] = [
    entry('r-guest', 'A2', at(10), 'confirmed', { guestName: '王阿姨' }),
    entry('r-wang', 'A1', at(20), 'confirmed', { accountId: 'u-wang', note: '两位，带小孩' }),
    entry('r-li', 'A3', at(45), 'pending', { accountId: 'u-li', createdBy: 'u-li' }),
    entry('r-late', 'A3', at(-100), 'expired', { accountId: 'u-wang' }),
    entry('r-far', 'A1', at(2 * 24 * 60), 'confirmed', { accountId: 'u-li' }),
  ]
  const ended: Json[] = Array.from({ length: 25 }, (_, i) =>
    entry(`r-old-${i + 1}`, 'A1', at(-(i + 1) * 24 * 60), i % 2 ? 'cancelled' : 'seated', {
      accountId: 'u-wang',
      ...(i % 2 ? { reason: '顾客来电改期' } : {}),
    }),
  )
  // 明天 15:00–17:00 A1 被别人约了；A2 现场在计时、明天 09:40 才空出（只提示，不挡）
  const busy: Json[] = [
    {
      serviceTableId: 't-A1',
      seatNumber: 1,
      startAt: storeIso(tomorrow, '15:00'),
      endAt: storeIso(tomorrow, '17:00'),
      kind: 'reservation',
    },
    { serviceTableId: 't-A2', seatNumber: 1, startAt: at(-30), endAt: storeIso(tomorrow, '09:40'), kind: 'session' },
  ]
  const settings = {
    enabled: true,
    openMinute: 540,
    closeMinute: 1320,
    slotMinutes: 30,
    advanceDays: 7,
    leadMinutes: 30,
    graceMinutes: 30,
    closedDates: [tomorrow],
    closedWeekdays: [],
    noShowLimit: 0,
    noShowWindowDays: 30,
  }
  const view = (targetId?: string) => ({
    reservations: open,
    busy,
    packages: [pkg],
    tables,
    settings,
    settingsVersion: 's1',
    closedDays: [tomorrow],
    version: `r${open.length}`,
    ...(targetId ? { targetId } : {}),
  })
  const replies = new Map<string, Json>()
  // loseNextReply：下一次写请求生效了但回包丢了（员工看到 502）
  const network = { loseNextReply: false }
  const reads = { open: 0, ended: [] as string[] }

  const handler: MockHandler = ({ method, path, search, body, idempotencyKey }) => {
    const ok = (value: unknown) => ({ status: 200, body: value })
    if (method === 'GET' && path === '/reservations/staff') {
      if (search.get('scope') === 'open') {
        reads.open++
        return ok(view())
      }
      if (search.get('scope') === 'ended') {
        reads.ended.push(search.toString())
        const size = Number(search.get('pageSize'))
        if (!size) return { status: 400, body: { code: 'invalid_request', message: '要带 pageSize', requestId: 'm' } }
        // date：门店日期，只要到店时间在那一天的（同后端，按中国标准时间）
        const day = search.get('date')
        const rows = day
          ? ended.filter((e) => storeParts(Date.parse(String((e.reservation as Json).startAt))).day === day)
          : ended
        const pages = Math.max(1, Math.ceil(rows.length / size))
        const page = Math.min(Math.max(1, Number(search.get('page')) || 1), pages)
        return {
          status: 200,
          body: { ...view(), reservations: rows.slice((page - 1) * size, page * size) },
          headers: { 'X-Total-Count': String(rows.length), 'X-Page': String(page) },
        }
      }
    }
    if (method === 'GET' && path === '/accounts') return accountListResult(customers, search)
    if (method === 'POST' && path === '/reservations/actions') {
      const input = body as Json
      const replayed = idempotencyKey ? replies.get(idempotencyKey) : undefined
      if (replayed) return ok(replayed)
      const index = open.findIndex((e) => (e.reservation as Json).id === input.targetId)
      const target = open[index]
      const settle = (status: string, extra: Json = {}) => {
        open.splice(index, 1)
        target.displayStatus = status
        Object.assign(target.reservation as Json, { status, decidedAt: new Date().toISOString(), ...extra })
        ended.unshift(target)
      }
      switch (input.action) {
        case 'confirm':
          target.displayStatus = 'confirmed'
          ;(target.reservation as Json).status = 'confirmed'
          break
        case 'cancel':
          settle('cancelled', input.reason ? { reason: input.reason } : {})
          break
        case 'no_show':
          settle('no_show', input.reason ? { reason: input.reason } : {})
          break
        case 'seat':
          settle('seated', input.accountId ? { accountId: input.accountId } : {})
          break
        case 'register': {
          const unit = tables.find((t) => t.id === input.serviceTableId)!
          open.push(
            entry(
              `r-new-${open.length}`,
              unit.code,
              String(input.startAt),
              'confirmed',
              {
                ...(input.accountId ? { accountId: input.accountId } : { guestName: input.guestName }),
                ...(input.note ? { note: input.note } : {}),
              },
              Number(input.seatNumber),
            ),
          )
          break
        }
        default:
          return { status: 400, body: { code: 'invalid_request', message: '不认识的动作', requestId: 'm' } }
      }
      const result = view(String(input.targetId ?? 'r-new'))
      if (idempotencyKey) replies.set(idempotencyKey, result)
      if (network.loseNextReply) {
        network.loseNextReply = false
        return { status: 502, body: {} }
      }
      return ok(result)
    }
    return undefined
  }
  return { handler, open, ended, network, reads, tomorrow }
}

async function openPage(page: Page, roles: string[] = ['owner'], path = '/reservations') {
  const backend = reservationsBackend()
  const api = await mockApi(page, {
    account: { id: 'u-owner', nickname: '阿贝', roles, phoneVerificationStatus: 'verified' },
    handlers: [backend.handler],
  })
  await signIn(page, { id: 'u-owner', nickname: '阿贝', roles })
  await page.goto(path)
  await expect(page.getByRole('heading', { name: '预约', exact: true })).toBeVisible()
  return { api, backend }
}

const row = (page: Page, id: string) => page.locator(`tr[data-reservation="${id}"]`)
const writes = (api: MockApi) => api.writes.filter((write) => write.path === '/reservations/actions')
const view = (page: Page, name: RegExp) => page.locator('.reservation-views .semi-radio', { hasText: name })

test('列表按状态与门店日期筛，个数跟着变；店员也能用，只有老板看到营业与预约设置入口', async ({ page }) => {
  const { backend } = await openPage(page, ['clerk'])
  // 侧栏有「预约」，店员看不到「系统设置」和设置入口
  await expect(page.locator('.semi-navigation-item-text', { hasText: /^预约$/ })).toBeVisible()
  await expect(page.locator('.semi-navigation-item-text', { hasText: '系统设置' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '营业与预约设置' })).toHaveCount(0)

  // 全部待处理：按到店时间从早到晚
  const ids = () =>
    page
      .locator('.reservation-list tbody tr[data-reservation]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-reservation')))
  await expect.poll(ids).toEqual(['r-late', 'r-guest', 'r-wang', 'r-li', 'r-far'])
  await expect(view(page, /全部待处理 5/)).toBeVisible()
  await expect(view(page, /待确认 1/)).toBeVisible()
  await expect(view(page, /待到店 3/)).toBeVisible()
  await expect(view(page, /过时未处理 1/)).toBeVisible()

  await expect(row(page, 'r-wang')).toContainText('A1')
  await expect(row(page, 'r-wang')).toContainText('小王（138****1234）')
  await expect(row(page, 'r-wang')).toContainText('两位，带小孩')
  await expect(row(page, 'r-guest')).toContainText('王阿姨 · 尚无账户')
  await expect(row(page, 'r-late')).toContainText('座位已释放')
  // 待确认的有「确认预约」，顾客人到了也能直接「到店开台」（2026-10-27 起）；已确认的有「到店开台」；
  // 还没到开始时间的不能标记爽约
  await expect(row(page, 'r-li').getByRole('button', { name: '确认预约' })).toBeVisible()
  await expect(row(page, 'r-li').getByRole('button', { name: '到店开台' })).toBeVisible()
  await expect(row(page, 'r-li').getByRole('button', { name: '标记爽约' })).toHaveCount(0)
  await expect(row(page, 'r-late').getByRole('button', { name: '标记爽约' })).toBeVisible()
  await expect(row(page, 'r-late').getByRole('button', { name: '到店开台' })).toHaveCount(0)

  // 只看待确认
  await view(page, /待确认/).click()
  await expect.poll(ids).toEqual(['r-li'])
  await expect(page).toHaveURL(/view=pending/)

  // 按门店日期：选 r-far 那天
  await view(page, /全部待处理/).click()
  const farDay = storeParts(Date.parse(String((backend.open.at(-1)!.reservation as Json).startAt))).day
  const dateGroup = page.getByRole('group', { name: '到店日期' })
  await dateGroup.getByPlaceholder('全部日期').fill(farDay)
  await expect.poll(ids).toEqual(['r-far'])
  await expect(view(page, /全部待处理 1/)).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`date=${farDay}`))
  // 回到今天
  await dateGroup.getByRole('button', { name: '只看今天' }).click()
  await expect(page).toHaveURL(new RegExp(`date=${storeParts(Date.now()).day}`))
})

test('确认、到店开台（有账户写现行套餐、没关联账户的当散客开台）、取消与爽约当场问原因', async ({ page }) => {
  const { api } = await openPage(page, ['clerk'])

  // 待确认的直接开台：确认框说明不再发「预约成功」；这里点取消，什么都不发
  const before = writes(api).length
  await row(page, 'r-li').getByRole('button', { name: '到店开台' }).click()
  const pendingSeat = page.locator('.semi-modal', { hasText: '这条预约还没确认' })
  await expect(pendingSeat).toContainText('开台就算到店了，不再给顾客发「预约成功」通知。')
  await pendingSeat.locator('button', { hasText: '取消' }).click()
  await expect(pendingSeat).toHaveCount(0)
  expect(writes(api)).toHaveLength(before)

  await row(page, 'r-li').getByRole('button', { name: '确认预约' }).click()
  await expect(page.getByText('预约已确认')).toBeVisible()
  expect(writes(api).at(-1)).toMatchObject({
    body: { action: 'confirm', targetId: 'r-li' },
    idempotencyKey: expect.any(String),
  })
  await expect(row(page, 'r-li').getByRole('button', { name: '到店开台' })).toBeVisible()

  // 有账户的预约：确认框写后端实际会用的现行套餐
  await row(page, 'r-wang').getByRole('button', { name: '到店开台' }).click()
  const confirm = page.locator('.semi-modal', { hasText: '按现行套餐' })
  await expect(confirm).toContainText('按现行套餐「畅玩 2 小时」开台计时（120 分钟，¥88.00），生成套餐的待结账订单。')
  await confirm.locator('button', { hasText: '到店开台' }).click()
  await expect(page.getByText('A1 已到店开台，开始计时')).toBeVisible()
  expect(writes(api).at(-1)?.body).toEqual({ action: 'seat', targetId: 'r-wang' })
  await expect(row(page, 'r-wang')).toHaveCount(0)

  // 没关联账户的预约：可以不选账户，当散客开台（选账户再开台见看板的用例）
  await row(page, 'r-guest').getByRole('button', { name: '到店开台' }).click()
  const bind = page.locator('.semi-modal', { hasText: '没关联账户的预约' })
  await expect(page.getByRole('combobox', { name: '到店顾客的账户（可不选）' })).toBeFocused()
  await expect(bind).toContainText('不选就当散客开台')
  await bind.locator('button', { hasText: '当散客开台' }).click()
  await expect(page.getByText('A2 已到店开台，开始计时')).toBeVisible()
  expect(writes(api).at(-1)?.body).toEqual({ action: 'seat', targetId: 'r-guest' })

  // 取消：当场问原因，原因跟着这一次操作走
  await row(page, 'r-far').getByRole('button', { name: '取消预约' }).click()
  const cancel = page.locator('.semi-modal', { hasText: '取消后座位释放' })
  await expect(cancel.getByLabel('原因')).toBeFocused()
  await cancel.getByLabel('原因').fill('顾客来电改期')
  await cancel.locator('button', { hasText: '取消预约' }).click()
  await expect(page.getByText('预约已取消')).toBeVisible()
  expect(writes(api).at(-1)?.body).toEqual({ action: 'cancel', targetId: 'r-far', reason: '顾客来电改期' })
  await expect(cancel).toHaveCount(0)

  // 爽约：原因可不填，不填就不发
  await row(page, 'r-late').getByRole('button', { name: '标记爽约' }).click()
  const noShow = page.locator('.semi-modal', { hasText: '记为未到店' })
  await expect(noShow.getByLabel('原因')).toHaveValue('')
  await noShow.locator('button', { hasText: '标记爽约' }).click()
  await expect(page.getByText('已标记爽约')).toBeVisible()
  expect(writes(api).at(-1)?.body).toEqual({ action: 'no_show', targetId: 'r-late' })

  // 处理完的在「已结束」里，服务端分页
  await view(page, /已结束/).click()
  await expect(row(page, 'r-late')).toContainText('未到店')
  await expect(row(page, 'r-far')).toContainText('处理原因：顾客来电改期')
})

test('已结束服务端分页；点一行看详情，详情里也能操作', async ({ page }) => {
  const { backend } = await openPage(page, ['owner'], '/reservations?view=ended')
  await expect(page.getByText('全部日期，已到店、已取消和爽约的共 25 条')).toBeVisible()
  await expect(page.locator('.reservation-list tbody tr[data-reservation]')).toHaveCount(20)
  expect(backend.reads.ended.at(-1)).toBe('scope=ended&page=1&pageSize=20')
  await page.locator('.semi-page-item', { hasText: /^2$/ }).click()
  await expect(page.locator('.reservation-list tbody tr[data-reservation]')).toHaveCount(5)
  await expect(page).toHaveURL(/page=2/)
  expect(backend.reads.ended.at(-1)).toBe('scope=ended&page=2&pageSize=20')

  // 老板有「营业与预约设置」入口（系统设置的一个标签页）
  await expect(page.getByRole('button', { name: '营业与预约设置' })).toBeVisible()

  // 详情：点一行打开抽屉，焦点进抽屉，写全预约时记下的内容
  await view(page, /全部待处理/).click()
  await row(page, 'r-wang').locator('td').first().click()
  const sheet = page.getByRole('dialog', { name: '预约详情' })
  await expect(sheet).toBeFocused()
  await expect(sheet).toContainText('员工代客登记')
  await expect(sheet).toContainText('两位，带小孩')
  await expect(sheet).toContainText('畅玩 2 小时 · 120 分钟（预约时）')
  await sheet.getByRole('button', { name: '取消预约' }).click()
  const cancel = page.locator('.semi-modal', { hasText: '取消后座位释放' })
  await cancel.locator('button', { hasText: '取消预约' }).click()
  await expect(page.getByText('预约已取消')).toBeVisible()
  // 处理完了：抽屉跟着变成已取消，不再给操作
  await expect(sheet.locator('.semi-tag', { hasText: '已取消' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: '取消预约' })).toHaveCount(0)
  // 弹窗关完（焦点不再被弹窗留住）再按 Esc 关抽屉
  await expect(cancel).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // 顾客自助提交的写「顾客在小程序自助预约」
  await row(page, 'r-li').getByRole('button', { name: '详情' }).click()
  await expect(page.getByRole('dialog', { name: '预约详情' })).toContainText('顾客在小程序自助预约')
})

// 已结束的也能按门店日期看：日期带给后端筛（哪一天由后端按中国标准时间判断），记在网址里，和还要处理的共用；
// 换日期回到第 1 页，个数和说明跟着这一天走。
test('已结束按门店日期筛：日期带给后端、记在网址里，换日期回到第 1 页', async ({ page }, testInfo) => {
  const { backend } = await openPage(page, ['clerk'], '/reservations?view=ended&page=2')
  const rows = page.locator('.reservation-list tbody tr[data-reservation]')
  await expect(rows).toHaveCount(5)
  expect(backend.reads.ended.at(-1)).toBe('scope=ended&page=2&pageSize=20')

  // 昨天：只有 r-old-1（一天前开始的那条）
  const yesterday = storeParts(Date.now() - 86_400_000).day
  const dateGroup = page.getByRole('group', { name: '到店日期' })
  await dateGroup.getByPlaceholder('全部日期').fill(yesterday)
  await expect(rows).toHaveCount(1)
  await expect(row(page, 'r-old-1')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`date=${yesterday}`))
  await expect(page).not.toHaveURL(/page=/)
  expect(backend.reads.ended.at(-1)).toBe(`scope=ended&page=1&pageSize=20&date=${yesterday}`)
  await expect(view(page, /已结束 1/)).toBeVisible()
  await expect(page.locator('.reservation-list')).toContainText('昨天，已到店、已取消和爽约的共 1 条')
  await page.screenshot({ path: testInfo.outputPath('已结束-按日期.png') })

  // 没有已结束预约的那天：写明这一天没有
  const later = storeParts(Date.now() + 30 * 86_400_000).day
  await dateGroup.getByPlaceholder('全部日期').fill(later)
  await expect(rows).toHaveCount(0)
  await expect(page.locator('.reservation-list')).toContainText(`${later.slice(5)}`)
  await expect(page.locator('.reservation-list')).toContainText('没有已结束的预约。')
  expect(backend.reads.ended.at(-1)).toBe(`scope=ended&page=1&pageSize=20&date=${later}`)

  // 切到还要处理的，日期留着（同一个网址参数）
  await view(page, /全部待处理/).click()
  await expect(page).toHaveURL(new RegExp(`date=${later}`))
  await expect(page).not.toHaveURL(/view=/)
})

test('代客登记：选顾客或填称呼、套餐、日期时段、座位、团购；已约的不能选，现场计时与歇业日只提示', async ({ page }) => {
  const { api, backend } = await openPage(page)
  await page.getByRole('tab', { name: '代客登记' }).click()
  await expect(page).toHaveURL(/tab=register/)
  const form = page.locator('.reservation-register')

  // 没填顾客、没选时间座位就提交：错误落在对应的组上，不发请求
  await form.getByRole('button', { name: '登记预约' }).click()
  await expect(form.getByText('请选择顾客账户或填写称呼')).toBeVisible()
  await expect(form.getByText('请选择到店时间')).toBeVisible()
  expect(writes(api)).toHaveLength(0)

  await form.getByLabel('或填写称呼').fill('张阿姨')
  // 只有一个套餐时直接选上
  await expect(form.getByRole('radio', { name: /畅玩 2 小时/ })).toBeChecked()
  // 明天：歇业日只提示
  await form.getByPlaceholder('选择到店日期').fill(backend.tomorrow)
  await expect(form.getByText('这天是歇业日，顾客不能自助预约；代客登记照常可以')).toBeVisible()
  await form.locator('.semi-radio', { hasText: /^15:00$/ }).click()
  // A1 那段被别人约了不能选；A2 现场计时到 09:40，15:00 不压到
  await expect(form.getByRole('radio', { name: 'A1' })).toBeDisabled()
  await expect(form.getByRole('radio', { name: 'A2' })).toBeEnabled()
  await form.locator('.semi-radio', { hasText: 'D1 整桌' }).click()

  // 改成早上 09:00：A2 现场在计时，只提示到几点空出
  await form.locator('.semi-radio', { hasText: /^09:00$/ }).click()
  await expect(form.getByRole('radio', { name: 'A1' })).toBeEnabled()
  await expect(form.locator('.semi-radio', { hasText: 'A2' })).toContainText('使用中至 09:40')
  await form.locator('.semi-radio', { hasText: 'A2' }).click()
  await expect(form.getByText('这个座位现场正在使用，到 09:40 才空出')).toBeVisible()
  // 团购记录选填：选了美团才有券码框；券码照手机上分段抄，提交时去掉空格
  await expect(form.getByLabel('券码')).toHaveCount(0)
  await form.locator('.semi-radio', { hasText: '美团' }).click()
  await form.getByLabel('券码').fill('1234 5678 90AB!')
  await expect(form.getByText('券码只能是字母和数字')).toBeVisible()
  await form.getByLabel('券码').fill('1234 5678 90AB')
  await form.getByLabel('备注').fill(' 两位 ')

  // 填了东西去别的页面先确认
  await page.locator('.semi-navigation-item-text', { hasText: '订单与退款' }).click()
  const leave = page.locator('.semi-modal', { hasText: '放弃未保存的输入？' })
  await leave.locator('button', { hasText: '继续填写' }).click()
  await expect(page).toHaveURL(/\/reservations/)
  // 切去列表看一眼再回来，输入还在
  await page.getByRole('tab', { name: '预约列表' }).click()
  await page.getByRole('tab', { name: '代客登记' }).click()
  await expect(form.getByLabel('或填写称呼')).toHaveValue('张阿姨')

  await form.getByRole('button', { name: '登记预约' }).click()
  await expect(page.getByText('预约已登记')).toBeVisible()
  expect(writes(api).at(-1)).toMatchObject({
    body: {
      action: 'register',
      guestName: '张阿姨',
      serviceTableId: 't-A2',
      seatNumber: 1,
      packageId: 'p-2h',
      startAt: new Date(storeIso(backend.tomorrow, '09:00')).toISOString(),
      note: '两位',
      coupon: { platform: 'meituan', code: '1234567890AB' },
    },
    idempotencyKey: expect.any(String),
  })
  // 登记好回到列表、看那一天，新登记的在里面；表单清空
  await expect(page).toHaveURL(new RegExp(`date=${backend.tomorrow}`))
  await expect(page.locator('.reservation-list')).toContainText('张阿姨 · 尚无账户')
  await page.getByRole('tab', { name: '代客登记' }).click()
  await expect(form.getByLabel('或填写称呼')).toHaveValue('')

  // 选了顾客账户：称呼框停用
  await form.locator('.semi-select').click()
  await page.keyboard.type('小王')
  await page.locator('.semi-select-option', { hasText: '小王' }).click()
  await expect(form.getByLabel('或填写称呼')).toBeDisabled()
})

test('结果未知后改了原因再点：先原样重发上一次，已生效就提醒「上次已生效」，不再提交', async ({ page }) => {
  const { api, backend } = await openPage(page)
  backend.network.loseNextReply = true
  await row(page, 'r-far').getByRole('button', { name: '取消预约' }).click()
  const cancel = page.locator('.semi-modal', { hasText: '取消后座位释放' })
  await cancel.getByLabel('原因').fill('改期')
  await cancel.locator('button', { hasText: '取消预约' }).click()
  await expect(cancel.locator('.semi-banner-danger')).toBeVisible()
  await expect(cancel.getByLabel('原因')).toHaveValue('改期')

  await cancel.getByLabel('原因').fill('顾客来电改期')
  await cancel.locator('button', { hasText: '取消预约' }).click()
  await expect(cancel.locator('.semi-banner-warning')).toContainText(
    '上一次没收到结果的那次操作其实已经生效，这一次没有提交',
  )
  const sent = writes(api)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(sent[1].body).toEqual({ action: 'cancel', targetId: 'r-far', reason: '改期' })
})

test('实时：别处改了预约，事件到达后列表重读', async ({ page }) => {
  const { api, backend } = await openPage(page)
  await expect(row(page, 'r-li')).toBeVisible()
  await expect.poll(() => api.sockets.length).toBeGreaterThan(0)
  const before = backend.reads.open
  backend.open.splice(
    backend.open.findIndex((e) => (e.reservation as Json).id === 'r-li'),
    1,
  )
  api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'resource.updated', resource: 'reservations' }))
  await expect(row(page, 'r-li')).toHaveCount(0)
  expect(backend.reads.open).toBeGreaterThan(before)
})
