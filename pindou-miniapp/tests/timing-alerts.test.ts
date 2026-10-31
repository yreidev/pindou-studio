import assert from 'node:assert/strict'
import { test } from 'vitest'
import { timingAlerts } from '../src/services/timing-alerts'
import type { ServiceTable, VenueSession } from '../src/services/staff'
import { load } from './helpers/load'
import { label, nodes } from './helpers/tree'
import { billingMock } from './helpers/billing'

// 现场页「快到点 / 已超时」：只认后端的 timingStatus，暂停中、已停止计时的不提醒，
// 按剩余时间排（超时最久的在最前），点一行就在现场页弹出这张桌的会话。规则与网页「现场」看板一致。

const now = Date.parse('2026-10-05T06:00:00Z')
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

const table = (code: string, endsIn: number | null, extra: Partial<ServiceTable> = {}): ServiceTable => ({
  id: `t-${code}`,
  code,
  number: Number(code.slice(1)),
  floorAreaId: 'area',
  seatCount: 1,
  enabled: true,
  occupancy: endsIn === null ? 'idle' : 'occupied',
  ...(endsIn === null
    ? {}
    : {
        startedAt: at(endsIn - 120),
        endsAt: at(endsIn),
        remainingSeconds: Math.max(0, Math.round(endsIn * 60)),
        timingStatus: endsIn < 0 ? 'overdue' : endsIn <= 10 ? 'expiring' : 'running',
      }),
  ...extra,
})
const session = (code: string, extra: Partial<VenueSession> = {}): VenueSession => ({
  id: `s-${code}`,
  serviceTableId: `t-${code}`,
  status: 'active',
  startedAt: at(-60),
  timingMode: 'timed',
  durationMinutes: 120,
  ...extra,
})

const tables = [
  table('A1', 45),
  table('A2', 6),
  table('A3', -4.5, { seatBased: true }),
  table('A4', 3),
  table('A5', -2),
  table('B5', 9),
  table('D1', -14.5),
  table('B1', null),
  table('B2', -8, { enabled: false }),
  // 剩余秒数看着快到点，后端没判（还是 running）就不提醒：不在前端自己判
  table('C1', 5, { timingStatus: 'running' }),
  // 自由计时：没有结束时间，后端不给 timingStatus
  table('C2', null, { occupancy: 'occupied' }),
]
const sessions = [
  session('A1'),
  session('A2'),
  session('A3', { admissionId: 'a-3', seatNumber: 1 }),
  session('A4', { status: 'paused' }),
  session('A5', { admissionId: 'a-5', stoppedAt: at(-3) }),
  session('B5'),
  session('D1'),
  session('C1'),
  session('C2', { timingMode: 'free' }),
]

test('只列后端判为快到点、超时的桌，暂停中、已停止计时的不列，超时最久的在最前', () => {
  const alerts = timingAlerts(tables, sessions, now)
  assert.deepEqual(
    alerts.map((alert) => alert.table.code),
    ['D1', 'A3', 'A2', 'B5'],
  )
  assert.deepEqual(
    alerts.map((alert) => alert.text),
    // 超时按整分钟向下取整（和计价一致）：超 14.5 分钟写 14，4.5 分钟写 4
    ['已超时 14 分钟', '已超时 4 分钟', '剩余 6 分钟', '剩余 9 分钟'],
  )
  assert.deepEqual(
    alerts.map((alert) => alert.overdue),
    [true, true, false, false],
  )
})

test('分钟数按 endsAt 倒数：向上取整，剩余不写负数，超时至少 1 分钟', () => {
  const later = timingAlerts(tables, sessions, now + 7 * 60_000)
  assert.equal(later.find((alert) => alert.table.code === 'A2')?.text, '剩余 0 分钟')
  assert.equal(later.find((alert) => alert.table.code === 'B5')?.text, '剩余 2 分钟')
  const justOver = timingAlerts([table('A1', -0.1)], [session('A1')], now)
  assert.equal(justOver[0].text, '已超时 1 分钟')
})

test('同桌多个会话时看和计时摘要开始时间对得上的那个', () => {
  const t = table('D1', -3)
  const paused = session('D1', { id: 'other', status: 'paused', startedAt: at(-200) })
  const running = session('D1', { startedAt: t.startedAt })
  assert.equal(timingAlerts([t], [paused, running], now).length, 1)
  assert.equal(timingAlerts([t], [paused, { ...running, status: 'paused' }], now).length, 0)
})

test('现场页的「等你处理」列出快到点、已超时的桌，点一行弹出这张桌的会话；没有要提醒的桌时不列', async () => {
  const calls: unknown[] = []
  let opened: any = null
  const render = async (overview: unknown) => {
    const slots: any[] = []
    let cursor = 0
    const react = {
      useState(initial: any) {
        const i = cursor++
        if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
        return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
      },
      useRef: (initial: any) => ({ current: initial }),
      useEffect() {},
    }
    const { default: Workbench } = await load('pages/staff/workbench/index.tsx', {
      '../../hooks/billing': billingMock(),
      react,
      '@tarojs/components': { View: 'View', Text: 'Text' },
      '../../../components/button': { Button: 'Button' },
      '../../../hooks/customer': { useCustomer: () => ({ account: { nickname: '员工', roles: ['manager'] } }) },
      '../../../hooks/clock': { useNow: () => now },
      '../../../hooks/query': { usePageVisible: () => true, useRefreshAll: () => async () => {} },
      '../../../hooks/staff-overview': { useStaffOverview: () => ({ data: overview, refresh() {} }) },
      '../../../services/navigation': { navigateApp: (...args: unknown[]) => calls.push(args) },
      '../../../services/staff': { staffMessage: String },
      '../../../components/staff': {
        roleNames: { clerk: '店员', manager: '店长', owner: '老板' },
        StaffScreen: 'Screen',
        useStaffQuery: () => ({ data: [], refresh() {} }),
        useStaffEvents: () => ({ connection: 'connected', refetchInterval: 30000 }),
      },
      '../../../components/staff/admission-row': { AdmissionRow: 'AdmissionRow' },
      '../../../components/staff/table-sheet': { TableSheet: 'TableSheet' },
      './index.scss': {},
    })
    return () => {
      cursor = 0
      const tree = Workbench()
      opened = nodes(tree, (node) => node.type === 'TableSheet')[0] || null
      return tree
    }
  }
  const overview = (list: ServiceTable[], live: VenueSession[]) => ({
    tables: list,
    sessions: live,
    shift: { admissions: [], tables: [] },
    reservations: [],
    orders: [],
  })

  const page = await render(overview(tables, sessions))
  const tree = page()
  const rows = nodes(tree, (node) => node.props.className === 'workbench-row')
  assert.deepEqual(
    rows.map((row) => label(nodes(row, (node) => node.props.className === 'workbench-row-title')[0])),
    ['D1 已超时 14 分钟', 'A3 已超时 4 分钟', 'A2 还剩 6 分钟', 'B5 还剩 9 分钟'],
  )
  assert.equal(rows[0].props.ariaLabel, 'D1，已超时 14 分钟，查看会话')
  assert.deepEqual(
    rows.map(
      (row) => nodes(row, (node) => String(node.props.className).startsWith('workbench-dot'))[0].props.className,
    ),
    [
      'workbench-dot workbench-dot-danger',
      'workbench-dot workbench-dot-danger',
      'workbench-dot workbench-dot-warning',
      'workbench-dot workbench-dot-warning',
    ],
  )
  // 顶上三个数：空闲、使用中、需关注（快到点和超时的 4 张，加停用的 B2）
  assert.deepEqual(nodes(tree, (node) => node.props.className === 'workbench-count-value').map(label), ['1', '9', '5'])
  // 点一行：现场页自己弹出这张桌的会话（扫码入座的按座会话也一样），不跳页
  rows[1].props.onClick()
  page()
  assert.equal(opened?.props.table.id, 't-A3')
  assert.deepEqual(calls, [])
  opened.props.onClose()
  page()
  assert.equal(opened, null)

  // 没有快到点、超时的桌就不列；什么事都没有时说一句
  const quiet = (await render(overview([table('A1', 45)], [])))()
  assert.equal(nodes(quiet, (node) => node.props.className === 'workbench-row').length, 0)
  assert.ok(label(quiet).includes('现在没有要处理的事'))
})
