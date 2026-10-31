import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 首页与「图纸」页的纯函数（services/storefront.ts）：一屏分档、今天还能约的格子、正在店里的状态、今天的预约。
// 余座、营业状态、算不算上新都是后端给的，这里验的是怎么挑说法、怎么排版。

const brand = await load('brand.ts')
const reservations = await load('services/reservations.ts', {
  './customer': { CustomerError: class extends Error {} },
  './staff': { request: async () => ({}) },
  './format': await load('services/format.ts'),
})
const storefront = await load('services/storefront.ts', {
  '@tarojs/taro': { default: {} },
  './api-base': { apiBase: 'https://shop.test/api/v2/' },
  './reservations': reservations,
  '../brand': brand,
})

const blocks = (over: Record<string, unknown> = {}) => ({
  staff: false,
  status: 'start',
  announcement: true,
  slots: true,
  featured: 3,
  store: true,
  greeting: true,
  ...over,
})

// 可用高度 = 窗口高（底部栏页）减去状态栏和 60 高的品牌头。数字照画布「F 一屏版」的几台手机。
test('一屏分档：矮屏放一行上新，常见屏放三张大图，高屏登录了再加问候', () => {
  const se = 618 - 20 - 60 // iPhone SE：538
  const iphone14 = 761 - 47 - 60 // 654
  assert.deepEqual(storefront.homeLayout(se, blocks()), { featured: 'row', greeting: false, fits: true })
  assert.deepEqual(storefront.homeLayout(iphone14, blocks()), { featured: 'large', greeting: false, fits: true })
  assert.deepEqual(storefront.homeLayout(700, blocks()), { featured: 'large', greeting: true, fits: true })
  assert.equal(storefront.homeLayout(700, blocks({ greeting: false })).greeting, false, '没登录不问候')
  // 正在店里、今天有预约：状态卡更高，不再放今天还能约，SE 上放得下三张小图
  assert.deepEqual(storefront.homeLayout(se, blocks({ status: 'visit' })), {
    featured: 'small',
    greeting: false,
    fits: true,
  })
  // 员工多一行工作台入口：SE 上放不下上新就不放
  assert.deepEqual(storefront.homeLayout(se, blocks({ staff: true })), {
    featured: 'none',
    greeting: false,
    fits: true,
  })
  // 没有图纸不留位置，空出来的地方放问候
  assert.deepEqual(storefront.homeLayout(iphone14, blocks({ featured: 0 })), {
    featured: 'none',
    greeting: true,
    fits: true,
  })
  // 连固定的块都放不下（横屏、很小的窗口）：照常滚动，上新用小图
  assert.deepEqual(storefront.homeLayout(300, blocks()), { featured: 'small', greeting: false, fits: false })
})

test('块高和样式里写的一致：分档靠的就是这张表', async () => {
  const fs = await import('node:fs')
  const { src } = await import('./helpers/load')
  const scss = fs.readFileSync(`${src}pages/index/index.scss`, 'utf8')
  const height = (selector: string) => {
    const rule = scss.split('\n').find((line) => line.startsWith(selector + ' {'))
    return Number(rule?.match(/(?:^|[ ;{])height: (\d+)PX/)?.[1])
  }
  const h = storefront.homeBlockHeights
  assert.equal(height('.screen .home-staff-entry'), h.staff)
  assert.equal(height('.screen .home-start'), h.start)
  assert.equal(height('.home-card'), h.card)
  assert.equal(height('.home-actions'), h.actions)
  assert.equal(height('.screen .home-notice'), h.announcement)
  assert.equal(height('.home-slots'), h.slots)
  assert.equal(height('.home-store'), h.store)
  assert.equal(height('.home-greeting'), h.greeting)
  assert.equal(height('.home-featured-row'), h.row)
  assert.equal(height('.home-featured-small'), h.small)
  assert.equal(height('.home-featured-large'), h.large)
  assert.match(
    scss,
    new RegExp(`\\.home-main \\{[^}]*gap: ${storefront.homeGap}PX; padding: ${storefront.homePadding / 2}PX`),
  )
})

test('今天还能约：按门店时间写几点，约满写「已满」，18 点起叫夜校', () => {
  const day = reservations.storeDate(0, new Date('2026-10-20T02:00:00Z'))
  const start = (hour: number) => reservations.storeInstant(day, hour * 60).toISOString()
  const cells = storefront.slotCells([
    { startAt: start(14), remaining: 3 },
    { startAt: start(17), remaining: 0 },
    { startAt: start(18), remaining: 2 },
  ])
  assert.deepEqual(
    cells.map((cell) => [cell.time, cell.note, cell.full, cell.night]),
    [
      ['14:00', '余 3 座', false, false],
      ['17:00', '已满', true, false],
      ['18:00', brand.nightSchoolName, false, true],
    ],
  )
  assert.equal(cells[2].label, `18:00 开始，还能约 2 个座位，${brand.nightSchoolName}`)
  assert.equal(
    storefront.noSlotsLine({ date: '', status: 'day_off', opensAt: '', closesAt: '' }),
    '今天店休，看看别的日子',
  )
  assert.equal(
    storefront.openingLine({ date: '', status: 'open', opensAt: '10:00', closesAt: '22:00' }),
    '营业中 · 10:00–22:00',
  )
  assert.equal(
    storefront.openingLine({ date: '', status: 'closed', opensAt: '10:00', closesAt: '22:00' }),
    '休息中 · 10:00–22:00 营业',
  )
  assert.equal(storefront.announcementTitle(' 周三店休\n周四照常 '), '周三店休')
  assert.equal(
    storefront.imageUrl('/pattern-images/p/thumb?v=1'),
    'https://shop.test/api/v2/pattern-images/p/thumb?v=1',
  )
})

const tables = [{ id: 't-c1', number: 7, code: 'C1', seatCount: 2, occupiedSeats: [] }]
const admission = (over: Record<string, unknown> = {}) => ({
  displayStatus: 'confirmed',
  admission: { id: 'a', accountId: 'u', serviceTableId: 't-c1', seatNumber: 2, package: {}, status: 'confirmed' },
  ...over,
})

test('正在店里：计时中的优先，其次是整桌计时、等员工确认的申请；陪客不能叫店员', () => {
  const running = admission({
    session: {
      id: 's1',
      serviceTableId: 't-c1',
      seatNumber: 2,
      status: 'active',
      startedAt: '2026-10-20T05:20:00Z',
      timingMode: 'timed',
    },
    elapsedSeconds: 42 * 60 + 30,
    remainingSeconds: 77 * 60 + 10,
    overdueSeconds: 0,
  })
  const pending = admission({ displayStatus: 'pending' })
  assert.deepEqual(storefront.visitOf([pending, running], tables, []), {
    table: 'C1 桌 · 2 号座',
    pending: false,
    startedAt: '2026-10-20T05:20:00Z',
    free: false,
    minutes: 42,
    remaining: 78,
    overdue: 0,
    state: '计时中',
    callSessionId: 's1',
  })
  const companion = admission({
    session: {
      id: 's2',
      serviceTableId: 't-c1',
      status: 'companion',
      startedAt: '2026-10-20T05:20:00Z',
      timingMode: 'free',
    },
    elapsedSeconds: 600,
  })
  const visit = storefront.visitOf([companion], tables, [])
  assert.equal(visit.state, '陪客')
  assert.equal(visit.callSessionId, null)
  assert.equal(visit.remaining, null)
  const whole = {
    id: 'v1',
    serviceTableId: 't-d1',
    tableCode: 'D1',
    startedAt: '2026-10-20T05:00:00Z',
    timingMode: 'free',
    displayStatus: 'stopped',
    elapsedSeconds: 3600,
    canCallStaff: true,
  }
  assert.deepEqual(
    (({ table, state, callSessionId, free }) => ({ table, state, callSessionId, free }))(
      storefront.visitOf([pending], tables, [whole]),
    ),
    { table: 'D1 桌', state: '计时已停止', callSessionId: 'v1', free: true },
  )
  const waiting = storefront.visitOf([pending], tables, [])
  assert.equal(waiting.pending, true)
  assert.equal(waiting.state, '等员工确认')
  assert.equal(storefront.visitOf([admission({ displayStatus: 'expired' })], tables, []), null)
})

test('今天的预约按门店日期挑最早一条还没结束的；倒数写到分钟', () => {
  const now = new Date('2026-10-20T03:00:00Z') // 门店 11:00
  const entry = (startAt: string, minutes: number, displayStatus = 'confirmed') => ({
    reservation: { id: startAt, startAt },
    displayStatus,
    endAt: new Date(Date.parse(startAt) + minutes * 60000).toISOString(),
  })
  const list = [
    entry('2026-10-20T08:00:00Z', 120), // 16:00
    entry('2026-10-20T06:00:00Z', 120), // 14:00
    entry('2026-10-20T01:00:00Z', 60), // 9:00，已经结束
    entry('2026-10-20T05:00:00Z', 60, 'cancelled'),
    entry('2026-10-20T17:00:00Z', 60), // 门店 10-21 01:00，不是今天
  ]
  assert.equal(storefront.todaysReservation(list, now)?.reservation.startAt, '2026-10-20T06:00:00Z')
  assert.equal(storefront.todaysReservation([], now), null)
  assert.equal(storefront.untilLabel('2026-10-20T04:20:00Z', now.getTime()), '还有 1 小时 20 分钟')
  assert.equal(storefront.untilLabel('2026-10-20T05:00:00Z', now.getTime()), '还有 2 小时')
  assert.equal(storefront.untilLabel('2026-10-20T03:08:00Z', now.getTime()), '还有 8 分钟')
  assert.equal(storefront.untilLabel('2026-10-20T02:50:00Z', now.getTime()), '已到开始时间')
  assert.equal(storefront.greeting(new Date('2026-10-20T07:00:00Z')), '下午好')
  assert.equal(storefront.greeting(new Date('2026-10-19T23:30:00Z')), '早上好')
})

test('图纸页的筛选：全部、本周上新、有图纸的启用分类', () => {
  const pattern = (id: string, categoryId: string | null, isNew = false) => ({ id, categoryId, isNew })
  const library = {
    categories: [
      { id: 'c-new', name: '新手', enabled: true },
      { id: 'c-fruit', name: '水果', enabled: true },
      { id: 'c-off', name: '花草', enabled: false },
    ],
    patterns: [pattern('p1', 'c-fruit', true), pattern('p2', null), pattern('p3', 'c-off')],
  }
  assert.deepEqual(
    storefront.patternFilters(library).map((filter) => filter.label),
    ['全部', '本周上新', '水果'],
  )
  assert.deepEqual(
    storefront.filterPatterns(library.patterns, 'new').map((item) => item.id),
    ['p1'],
  )
  assert.deepEqual(
    storefront.filterPatterns(library.patterns, 'c-fruit').map((item) => item.id),
    ['p1'],
  )
  assert.equal(storefront.filterPatterns(library.patterns, 'all').length, 3)
  assert.equal(storefront.categoryName(library, library.patterns[0]), '水果')
  assert.equal(storefront.categoryName(library, library.patterns[2]), '', '停用的分类顾客看不到')
  assert.deepEqual(
    storefront.patternFilters({ categories: [], patterns: [pattern('p', null)] }).map((filter) => filter.key),
    ['all'],
  )
})
