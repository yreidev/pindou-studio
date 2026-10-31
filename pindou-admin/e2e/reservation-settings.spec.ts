import { expect, test } from '@playwright/test'
import { mockApi, signIn, type MockApi, type MockHandler } from './mock-api'

// 系统设置 › 营业与预约（原预约设置页）：改动后才出现保存与放弃、字段校验落在对应的框、保存前确认、版本冲突后重读再确认、
// 离开时有未保存的改动要确认；只有老板能改。门店电话、微信号可选，给小程序的顾客看。
// 歇业日期、每周休息日：新设的歇业日上已有预约时保存前列出哪天几个；爽约 N 次后暂停自助预约（0 不限制）。
// 提前几小时提醒：没设置过时接口不返回、按 2 小时显示，保存时写明（0 不提醒）。

type Settings = {
  enabled: boolean
  openMinute: number
  closeMinute: number
  slotMinutes: number
  advanceDays: number
  leadMinutes: number
  graceMinutes: number
  contactPhone?: string
  contactWechat?: string
  address?: string
  latitude?: number
  longitude?: number
  closedDates: string[]
  closedWeekdays: number[]
  noShowLimit: number
  noShowWindowDays: number
  remindHours?: number
}

const defaults: Settings = {
  enabled: true,
  openMinute: 540,
  closeMinute: 1320,
  slotMinutes: 30,
  advanceDays: 7,
  leadMinutes: 30,
  graceMinutes: 30,
  closedDates: [],
  closedWeekdays: [],
  noShowLimit: 0,
  noShowWindowDays: 30,
}

/** 门店（东八区）今天往后第 offset 天的日期，YYYY-MM-DD。 */
const storeDay = (offset: number) => new Date(Date.now() + 8 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10)
/** 1 周一 … 7 周日。 */
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7
const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
const dayLabel = (day: string) => `${day.slice(5)} ${weekdayNames[weekdayOf(day)]}`

/** 员工视图里还要处理的一条预约：门店日期 day 的 14:00 开始。 */
const openEntry = (id: string, day: string, status: 'pending' | 'confirmed') => ({
  reservation: {
    id,
    serviceTableId: '00000000-0000-0000-0000-0000000000b1',
    seatNumber: 1,
    packageId: '00000000-0000-0000-0000-0000000000p1',
    packageName: '三小时',
    durationMinutes: 180,
    amountCents: 10000,
    startAt: `${day}T06:00:00Z`,
    status,
    createdBy: 'u-owner',
    createdAt: `${day}T00:00:00Z`,
  },
  displayStatus: status,
  endAt: `${day}T09:00:00Z`,
  tableNumber: 1,
  customerName: '顾客',
  phoneMasked: '138****8000',
})

/** 模拟后端：保存时比对设置版本，不符回 409。 */
function settingsBackend(reservations: unknown[] = []) {
  const state = { settings: { ...defaults } as Settings, version: 1 }
  const view = () => ({
    reservations,
    busy: [],
    packages: [],
    tables: [],
    settings: state.settings,
    settingsVersion: `s-v${state.version}`,
    version: 'r-v1',
  })
  const handler: MockHandler = ({ method, path, search, body }) => {
    // 只读还要处理的预约（scope=open）；不带 scope 的整份读取只留给旧版小程序
    if (method === 'GET' && path === '/reservations/staff')
      return search.get('scope') === 'open'
        ? { status: 200, body: view() }
        : { status: 400, body: { code: 'invalid_request', message: '网页后台应带 scope=open', requestId: 'mock' } }
    if (method === 'POST' && path === '/reservations/actions') {
      const input = body as { action: string; settings: Settings; expectedVersion: string }
      if (input.expectedVersion !== `s-v${state.version}`)
        return {
          status: 409,
          body: { code: 'reservation_conflict', message: '预约设置已变化，请重新读取后确认', requestId: 'r1' },
        }
      state.settings = input.settings
      state.version++
      return { status: 200, body: view() }
    }
    return undefined
  }
  /** 别人（小程序或另一台电脑）改了设置。 */
  const changeElsewhere = (patch: Partial<Settings>) => {
    state.settings = { ...state.settings, ...patch }
    state.version++
  }
  return { state, handler, changeElsewhere }
}

const notify = (api: MockApi) =>
  api.sockets[api.sockets.length - 1].send(JSON.stringify({ type: 'resource.updated', resource: 'reservations' }))

test('老板改预约设置：改动后才出现保存与放弃，校验定位到字段，确认后保存', async ({ page }) => {
  const backend = settingsBackend()
  // 生产 CSP 下页面没有报错
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
  await expect(page.getByLabel('每天开始接待')).toHaveValue('09:00')
  await expect(page.getByLabel('每天最晚结束')).toHaveValue('22:00')
  await expect(page.getByLabel('时段粒度')).toHaveValue('30')
  await expect(page.getByLabel('最多提前')).toHaveValue('7')
  await expect(page.getByLabel('最短提前')).toHaveValue('30')
  await expect(page.getByLabel('迟到宽限')).toHaveValue('30')
  await expect(page.getByRole('switch', { name: '开放顾客自助预约' })).toBeChecked()
  await expect(page.getByRole('switch', { name: '开放顾客自助预约' })).toHaveAccessibleDescription(
    /关闭后顾客不能在小程序自助预约/,
  )
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '放弃修改' })).toHaveCount(0)

  // 分钟数、天数、次数是数字输入框（spinbutton）：方向键按 1 步进，读屏念得出能填的范围；时间仍是文本框（要能填 24:00）
  const grace = page.getByRole('spinbutton', { name: '迟到宽限' })
  await expect(grace).toHaveAttribute('aria-valuemin', '5')
  await expect(grace).toHaveAttribute('aria-valuemax', '240')
  await expect(page.getByRole('textbox', { name: '每天最晚结束' })).toHaveValue('22:00')
  await grace.press('ArrowUp')
  await expect(grace).toHaveValue('31')
  await expect(page.getByText('有 1 项改动未保存')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(grace).toHaveValue('30')

  // 改一项就出现保存与放弃；放弃回到原值
  await page.getByLabel('迟到宽限').fill('15')
  await expect(page.getByText('有 1 项改动未保存')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.getByLabel('迟到宽限')).toHaveValue('30')
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
  // 改回原值也不算改动
  await page.getByLabel('每天开始接待').fill('9:00')
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)

  // 校验：错误落在对应的字段下面，不发请求
  await page.getByLabel('每天开始接待').fill('09:10')
  await page.getByLabel('时段粒度').fill('3')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('填 5–240 之间的整数分钟')).toBeVisible()
  // 说明和错误都接在输入框上：读屏聚焦时念出原因
  await expect(page.getByLabel('时段粒度')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByLabel('时段粒度')).toHaveAccessibleDescription(
    '可选开始时间的间隔，例如 30 分钟：09:00、09:30…… 填 5–240 之间的整数分钟',
  )
  await page.getByLabel('时段粒度').fill('30')
  await expect(page.getByText('开始接待须落在 30 分钟一档的时间上（从 00:00 起算），例如 09:00')).toBeVisible()
  await page.getByLabel('每天最晚结束').fill('09:30')
  await expect(page.getByText('最晚结束要比开始接待至少晚 1 小时')).toBeVisible()
  await page.getByLabel('最多提前').fill('91')
  await expect(page.getByText('填 1–90 之间的整数天')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  // 全部改对，再关掉自助预约
  await page.getByLabel('每天开始接待').fill('10:00')
  await page.getByLabel('每天最晚结束').fill('24:00')
  await page.getByLabel('最多提前').fill('14')
  await page.getByLabel('迟到宽限').fill('15')
  await page.getByRole('switch', { name: '开放顾客自助预约' }).click()
  await expect(page.getByText('最晚结束要比开始接待至少晚 1 小时')).toHaveCount(0)
  await page.getByRole('button', { name: '保存设置' }).click()

  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText('顾客自助预约：开放 → 关闭')).toBeVisible()
  await expect(dialog.getByText('每天开始接待：09:00 → 10:00')).toBeVisible()
  await expect(dialog.getByText('每天最晚结束：22:00 → 24:00')).toBeVisible()
  await expect(dialog.getByText('最多提前：7 天 → 14 天')).toBeVisible()
  await expect(dialog.getByText('迟到宽限：30 分钟 → 15 分钟')).toBeVisible()
  await expect(dialog.getByText(/时段粒度/)).toHaveCount(0)
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()

  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/reservations/actions',
      body: {
        action: 'save_settings',
        settings: {
          enabled: false,
          openMinute: 600,
          closeMinute: 1440,
          slotMinutes: 30,
          advanceDays: 14,
          leadMinutes: 30,
          graceMinutes: 15,
          closedDates: [],
          closedWeekdays: [],
          noShowLimit: 0,
          noShowWindowDays: 30,
          remindHours: 2,
        },
        expectedVersion: 's-v1',
      },
      idempotencyKey: expect.any(String),
    },
  ])
  // 保存后表单就是新的设置，没有未保存的改动
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
  await expect(page.getByLabel('每天开始接待')).toHaveValue('10:00')
  await expect(page.getByLabel('每天最晚结束')).toHaveValue('24:00')
  await expect(page.getByRole('switch', { name: '开放顾客自助预约' })).not.toBeChecked()
  expect(problems).toEqual([])
})

test('别人同时改了设置：没改动时跟上最新；有改动时提示，冲突后重读只保留我的改动再确认', async ({ page }) => {
  const backend = settingsBackend()
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')
  await expect(page.getByText('实时 · 已连接')).toBeVisible()
  await expect(page.getByLabel('最短提前')).toHaveValue('30')

  // 没有改动：别人改了最短提前，表单直接跟上
  backend.changeElsewhere({ leadMinutes: 60 })
  notify(api)
  await expect(page.getByLabel('最短提前')).toHaveValue('60')

  // 我改开始接待；这时别人又改了迟到宽限：提示，但不动我正在编辑的表单
  await page.getByLabel('每天开始接待').fill('10:00')
  backend.changeElsewhere({ graceMinutes: 20 })
  notify(api)
  await expect(page.getByText(/营业与预约设置刚被修改过/)).toBeVisible()
  await expect(page.getByLabel('迟到宽限')).toHaveValue('30')

  // 照旧保存：后端版本不符回 409，提示重读，不自动重提
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('预约设置已变化，请重新读取后确认')).toBeVisible()
  expect(api.writes).toHaveLength(1)
  expect(api.writes[0].body).toMatchObject({ expectedVersion: 's-v2' })
  await expect(page.getByLabel('每天开始接待')).toHaveValue('10:00')

  // 重新读取：别人改的迟到宽限跟最新，我改的开始接待保留
  await page.getByRole('button', { name: '重新读取' }).click()
  await expect(page.getByLabel('迟到宽限')).toHaveValue('20')
  await expect(page.getByLabel('每天开始接待')).toHaveValue('10:00')
  await expect(page.getByText('预约设置已变化，请重新读取后确认')).toHaveCount(0)
  await expect(page.getByText('有 1 项改动未保存')).toBeVisible()

  await page.getByRole('button', { name: '保存设置' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText('每天开始接待：09:00 → 10:00')).toBeVisible()
  await expect(dialog.getByText(/迟到宽限/)).toHaveCount(0)
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes).toHaveLength(2)
  expect(api.writes[1].body).toEqual({
    action: 'save_settings',
    settings: { ...defaults, remindHours: 2, openMinute: 600, leadMinutes: 60, graceMinutes: 20 },
    expectedVersion: 's-v3',
  })
  expect(api.writes[1].idempotencyKey).not.toBe(api.writes[0].idempotencyKey)
})

test('老板填门店电话与微信号：格式不对落在对应的框，去掉首尾空白保存，清空后不再提交', async ({ page }) => {
  const backend = settingsBackend()
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.getByRole('heading', { name: '门店联系方式' })).toBeVisible()
  await expect(page.getByText(/预约超过每人 2 个的提示、爽约暂停的说明、包间说明和预约须知/)).toBeVisible()
  await expect(page.getByLabel('门店电话')).toHaveValue('')
  await expect(page.getByLabel('门店微信号')).toHaveValue('')

  // 格式不对：错误落在对应的框下面，不发请求
  await page.getByLabel('门店电话').fill('0571-abc')
  await page.getByLabel('门店微信号').fill('examplebrand pindou')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('只能填数字、空格、+、-、括号，最多 20 个字符')).toBeVisible()
  await expect(page.getByText('最多 40 个字符，不能有空格')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  await page.getByLabel('门店电话').fill(' 0571-8888 6666 ')
  await page.getByLabel('门店微信号').fill('examplebrand_pindou')
  await page.getByRole('button', { name: '保存设置' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText('门店电话：未填 → 0571-8888 6666')).toBeVisible()
  await expect(dialog.getByText('门店微信号：未填 → examplebrand_pindou')).toBeVisible()
  await expect(dialog.getByText('保存后顾客在小程序里看到的就是新的联系方式。')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes[0].body).toEqual({
    action: 'save_settings',
    settings: { ...defaults, remindHours: 2, contactPhone: '0571-8888 6666', contactWechat: 'examplebrand_pindou' },
    expectedVersion: 's-v1',
  })
  await expect(page.getByLabel('门店电话')).toHaveValue('0571-8888 6666')
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)

  // 清空电话：整份设置不再带 contactPhone
  await page.getByLabel('门店电话').fill('')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(dialog.getByText('门店电话：0571-8888 6666 → 未填')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect.poll(() => api.writes.length).toBe(2)
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
  await expect(page.getByLabel('门店电话')).toHaveValue('')
  expect(api.writes[1].body).toEqual({
    action: 'save_settings',
    settings: { ...defaults, remindHours: 2, contactWechat: 'examplebrand_pindou' },
    expectedVersion: 's-v2',
  })
})

test('老板填门店地址和经纬度：坐标拾取器的「纬度,经度」整段粘进纬度框一次填好，经纬度要一起填', async ({ page }) => {
  const backend = settingsBackend()
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.getByRole('link', { name: '腾讯地图坐标拾取器' })).toHaveAttribute(
    'href',
    'https://lbs.qq.com/getPoint/',
  )
  await page.getByLabel('门店地址').fill(' 天津市和平区南京路 1 号 ')
  await page.getByLabel('门店纬度').fill('39.118')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('经纬度要一起填；都不填表示首页不给导航')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  await page.getByLabel('门店纬度').fill('39.118123，117.199456')
  await expect(page.getByLabel('门店纬度')).toHaveValue('39.118123')
  await expect(page.getByLabel('门店经度')).toHaveValue('117.199456')
  await page.getByRole('button', { name: '保存设置' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText('门店地址：未填 → 天津市和平区南京路 1 号')).toBeVisible()
  await expect(dialog.getByText('门店纬度：未填 → 39.118123')).toBeVisible()
  await expect(dialog.getByText('保存后顾客在小程序里看到的就是新的联系方式。')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes[0].body).toEqual({
    action: 'save_settings',
    settings: {
      ...defaults,
      remindHours: 2,
      address: '天津市和平区南京路 1 号',
      latitude: 39.118123,
      longitude: 117.199456,
    },
    expectedVersion: 's-v1',
  })
})

test('老板设歇业日：加日期、勾每周休息日，新设的歇业日上已有预约时保存前列出哪天几个', async ({ page }) => {
  const soon = storeDay(2)
  const later = storeDay(4)
  const other = storeDay(5)
  // soon 上 2 个、later 上 1 个还要到店的预约；other 不歇业
  const backend = settingsBackend([
    openEntry('r1', soon, 'pending'),
    openEntry('r2', soon, 'confirmed'),
    openEntry('r3', later, 'confirmed'),
    openEntry('r4', other, 'confirmed'),
  ])
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.getByRole('heading', { name: '歇业日' })).toBeVisible()
  await expect(page.getByText('还没有设歇业日期')).toBeVisible()
  const add = page.getByRole('button', { name: '加入歇业日' })
  const picker = page.getByPlaceholder('选择歇业日期')
  await expect(add).toBeDisabled()
  // 日期选择器自己起不了中文名（触发框写死 Choose date）：选择器、按钮、已设的日期是一组，组上有标题和说明
  const closedGroup = page.getByRole('group', { name: '歇业日期' })
  await expect(closedGroup).toHaveAccessibleDescription(/选一天点「加入歇业日」/)
  await expect(closedGroup.getByPlaceholder('选择歇业日期')).toBeVisible()
  await expect(closedGroup.getByRole('button', { name: '加入歇业日' })).toBeVisible()
  // 每周休息日：多选组（role=list）用标题作名字
  await expect(page.getByRole('list', { name: '每周休息日' })).toHaveAccessibleDescription(/每周固定不接待的日子/)

  // 过去的日子选不了
  await picker.fill(storeDay(-1))
  await expect(add).toBeDisabled()
  await picker.fill(soon)
  await expect(add).toBeEnabled()
  await add.click()
  const tags = page.locator('.closed-dates .semi-tag')
  await expect(tags).toHaveText([`${soon.slice(0, 5)}${dayLabel(soon)}`])
  await expect(picker).toHaveValue('')
  await expect(page.getByText(`新设的歇业日上已有 2 个预约：${dayLabel(soon)} 2 个。`)).toBeVisible()

  // 每周休息日：勾上 later 那天是周几
  // Semi 的勾选框由外层的显示块接点击，点它而不是里面的 input
  const weekday = page.getByRole('checkbox', { name: weekdayNames[weekdayOf(later)] })
  await page.locator('.semi-checkbox', { has: weekday }).click()
  await expect(weekday).toBeChecked()
  const notice = `新设的歇业日上已有 3 个预约：${dayLabel(soon)} 2 个、${dayLabel(later)} 1 个。保存后这些预约不会自动取消，请联系顾客改期或取消。`
  await expect(page.getByText(notice)).toBeVisible()

  // 爽约限制：校验落在对应的框
  await page.getByLabel('爽约几次后暂停').fill('21')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('填 0–20 之间的整数，0 表示不限制')).toBeVisible()
  expect(api.writes).toHaveLength(0)
  await page.getByLabel('爽约几次后暂停').fill('2')
  await page.getByLabel('统计最近').fill('60')

  await page.getByRole('button', { name: '保存设置' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText(`歇业日期：无 → ${dayLabel(soon)}`)).toBeVisible()
  await expect(dialog.getByText(`每周休息日：无 → ${weekdayNames[weekdayOf(later)]}`)).toBeVisible()
  await expect(dialog.getByText('爽约暂停：不限制 → 爽约 2 次后暂停自助预约')).toBeVisible()
  await expect(dialog.getByText('爽约统计：最近 30 天 → 最近 60 天')).toBeVisible()
  await expect(dialog.getByText(notice)).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes).toEqual([
    {
      method: 'POST',
      path: '/reservations/actions',
      body: {
        action: 'save_settings',
        settings: {
          ...defaults,
          closedDates: [soon],
          closedWeekdays: [weekdayOf(later)],
          noShowLimit: 2,
          noShowWindowDays: 60,
          remindHours: 2,
        },
        expectedVersion: 's-v1',
      },
      idempotencyKey: expect.any(String),
    },
  ])
  // 保存后已经歇业的日子不再提醒；表单是新的设置
  await expect(page.getByText(/新设的歇业日上已有/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
  await expect(weekday).toBeChecked()

  // 去掉一个歇业日期就是一项改动；放弃回到已保存的
  await tags.first().locator('.semi-tag-close').click()
  await expect(page.getByText('还没有设歇业日期')).toBeVisible()
  await expect(page.getByText('有 1 项改动未保存')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(tags).toHaveText([`${soon.slice(0, 5)}${dayLabel(soon)}`])
})

test('有未保存的改动时离开要确认', async ({ page }) => {
  const backend = settingsBackend()
  await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')
  await page.getByLabel('迟到宽限').fill('15')

  const nav = page.locator('.admin-nav')
  await nav.getByText('首页', { exact: true }).click()
  const dialog = page.locator('.semi-modal', { hasText: '离开营业与预约？' })
  await expect(dialog.getByText('还有 1 项改动没有保存，离开后会丢失。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '放弃改动并离开' })).toHaveClass(/semi-button-danger/)
  await dialog.locator('button', { hasText: '留下继续编辑' }).click()
  await expect(page).toHaveURL(/\/system-settings\?tab=reservations$/)
  await expect(page.getByLabel('迟到宽限')).toHaveValue('15')

  await nav.getByText('首页', { exact: true }).click()
  await page.locator('.semi-modal button', { hasText: '放弃改动并离开' }).click()
  await expect(page.getByRole('heading', { name: '你好，阿贝' })).toBeVisible()
})

test('老板改微信提醒：没设置过显示 2 小时，超过 24 报错，填 0 不提醒', async ({ page }) => {
  const backend = settingsBackend()
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.getByLabel('提前几小时提醒')).toHaveValue('2')
  await page.getByLabel('提前几小时提醒').fill('25')
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('填 0–24 之间的整数小时，0 表示不提醒')).toBeVisible()
  expect(api.writes).toHaveLength(0)
  await page.getByLabel('提前几小时提醒').fill('0')
  await page.getByRole('button', { name: '保存设置' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '确认保存营业与预约设置' })
  await expect(dialog.getByText('微信提醒：开始前 2 小时提醒 → 不提醒')).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '确认保存' }).click()
  await expect(page.getByText('营业与预约设置已保存')).toBeVisible()
  expect(api.writes[0].body).toEqual({
    action: 'save_settings',
    settings: { ...defaults, remindHours: 0 },
    expectedVersion: 's-v1',
  })
  await expect(page.getByLabel('提前几小时提醒')).toHaveValue('0')
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
})

test('不是老板：导航里没有系统设置，直接打开只能看不能改', async ({ page }) => {
  const backend = settingsBackend()
  await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    handlers: [backend.handler],
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长', roles: ['manager'] })
  await page.goto('/system-settings?tab=reservations')

  await expect(page.locator('.admin-nav').getByText('员工权限')).toBeVisible()
  await expect(page.locator('.admin-nav').getByText('系统设置')).toHaveCount(0)
  await expect(page.getByText('只有老板可以修改系统设置。')).toBeVisible()
  await expect(page.getByText('只有老板可以修改营业与预约设置。')).toBeVisible()
  await expect(page.getByText('09:00')).toBeVisible()
  await expect(page.getByText('门店电话')).toBeVisible()
  // 电话、微信、地址、纬度、经度都没填
  await expect(page.getByText('未填')).toHaveCount(5)
  await expect(page.getByText('歇业日期')).toBeVisible()
  await expect(page.getByText('不限制')).toBeVisible()
  await expect(page.getByText('开始前 2 小时提醒')).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(0)
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0)
})
