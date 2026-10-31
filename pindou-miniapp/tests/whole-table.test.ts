import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { WholeTableSession } from '../src/services/whole-table'
import { load } from './helpers/load'
import { billingMock } from './helpers/billing'

// 「本次手作」页的整桌计时：员工从桌位开台、绑定了顾客账户的会话，顾客要看得到、叫得了店员
// （2026-10-06 业主用自己的账号开 A1 台时发现页面上什么都没有）。计时数字、状态与能不能叫都由后端算好。

const session = (patch: Partial<WholeTableSession> = {}): WholeTableSession => ({
  id: 's1',
  serviceTableId: 't1',
  tableCode: 'A1',
  startedAt: '2026-10-06T06:00:00Z',
  timingMode: 'timed',
  durationMinutes: 60,
  displayStatus: 'running',
  elapsedSeconds: 600,
  endsAt: '2026-10-06T07:00:00Z',
  remainingSeconds: 3000,
  overdueSeconds: 0,
  timingStatus: 'running',
  canCallStaff: true,
  ...patch,
})

test('顾客读本人整桌计时：GET /venue-sessions/me，报错只用白名单文案', async () => {
  const calls: any[] = []
  let reply: { statusCode: number; data: unknown } = { statusCode: 200, data: [session()] }
  const taro = {
    getStorageSync: () => ({ accessToken: 'test-token' }),
    request: async (args: any) => {
      calls.push(args)
      return reply
    },
  }
  const service = await load<typeof import('../src/services/whole-table')>('services/whole-table.ts', {
    '@tarojs/taro': { default: taro },
  })
  assert.deepEqual(await service.wholeTableSessions(), [session()])
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].url.replace(/^.*\/api\/v2/, ''), '/venue-sessions/me')
  reply = { statusCode: 500, data: { code: 'persistence_rejected', message: 'violates venue_sessions_status' } }
  await assert.rejects(
    service.wholeTableSessions(),
    (e: any) => e.name === 'CustomerError' && e.message === '服务暂时不可用，请稍后重试',
  )
  assert.equal(service.wholeTableTitle(session()), 'A1 桌 · 定时 60 分钟')
  assert.equal(service.wholeTableTitle(session({ timingMode: 'free', durationMinutes: undefined })), 'A1 桌 · 自由计时')
})

// 只渲染页面这一层，外加计时卡片（TimingCard，没有 hook）：呼叫店员（CallStaff）不展开，按它的 props 核对给哪次计时叫。
const expandCards = (tree: any): any =>
  Array.isArray(tree)
    ? tree.map(expandCards)
    : tree && typeof tree === 'object'
      ? typeof tree.type === 'function' && tree.type.name === 'TimingCard'
        ? expandCards(tree.type(tree.props))
        : tree.props?.children === undefined
          ? tree
          : { ...tree, props: { ...tree.props, children: expandCards(tree.props.children) } }
      : tree
async function renderPage(sessions: WholeTableSession[], admissions: unknown[] = []) {
  const slots: any[] = []
  let cursor = 0
  const react: any = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (v: any) => (slots[i] = typeof v === 'function' ? v(slots[i]) : v)]
    },
    useEffect() {},
  }
  react.useRef = (initial: any) => react.useState(() => ({ current: initial }))[0]
  const experience = { data: { tables: [], member: { version: 'v1', admissions, rules: [] } } }
  const byKey: Record<string, unknown> = {
    experience,
    'service-calls': { data: [], updatedAt: 1, refresh: async () => {} },
    'venue-sessions': { data: sessions },
  }
  const { default: Page } = await load('pages/customer/experience/index.tsx', {
    '../../hooks/billing': billingMock(),
    react,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '@tarojs/taro': { default: {}, useRouter: () => ({ params: {} }) },
    '../../components/button': { Button: 'Button' },
    '../../components/customer': {
      Screen: 'Screen',
      AuthBoundary: 'Auth',
      Failure: 'Failure',
      RefreshNotice: 'Notice',
      Skeleton: 'Skeleton',
      SectionEmpty: 'SectionEmpty',
    },
    '../../hooks/query': { useCustomerQuery: (key: string[]) => byKey[key[0]] },
    '../../services/membership': { loyalty: {} },
    '../../services/table-code': { scanTableCode: async () => '', tableIdFromLaunch: () => '' },
    './index.scss': {},
  })
  cursor = 0
  return expandCards(Page())
}
const nodes = (tree: any): any[] =>
  Array.isArray(tree)
    ? tree.flatMap(nodes)
    : tree && typeof tree === 'object'
      ? [tree, ...nodes(tree.props?.children)]
      : []
const text = (tree: any): string =>
  Array.isArray(tree)
    ? tree.map(text).join('')
    : tree && typeof tree === 'object'
      ? text(tree.props?.children)
      : tree == null || typeof tree === 'boolean'
        ? ''
        : String(tree)
const callButtons = (tree: any) =>
  nodes(tree).filter((n) => typeof n.type === 'function' && n.type.name === 'CallStaff')

test('整桌计时列成卡片：桌号、开始时间、已用与剩余，计时中可以呼叫店员', async () => {
  const tree = await renderPage([session()])
  const page = text(tree)
  assert.ok(page.includes('A1 桌 · 定时 60 分钟'), page)
  assert.ok(page.includes('入座14:00'), '开始时间按门店时区')
  assert.ok(page.includes('已拼10 分钟'), page)
  assert.ok(page.includes('还剩0:50'), page)
  assert.ok(page.includes('计时中'))
  assert.ok(!page.includes('扫描桌码'), '有计时时不再显示扫码入口')
  const buttons = callButtons(tree)
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props.sessionId, 's1', '按这次整桌计时的会话编号呼叫')
})

test('暂停中、停止计时等结账也能叫；陪客只显示不能叫；超时写明超了多久', async () => {
  for (const [patch, state, callable] of [
    [{ displayStatus: 'paused' }, '已暂停', true],
    [{ displayStatus: 'stopped' }, '计时已停止，等待结账', true],
    [{ displayStatus: 'companion', canCallStaff: false }, '陪客', false],
  ] as const) {
    const tree = await renderPage([session(patch)])
    assert.ok(text(tree).includes(state), state)
    assert.equal(callButtons(tree).length, callable ? 1 : 0, state)
  }
  const overdue = text(
    await renderPage([
      session({ elapsedSeconds: 4500, remainingSeconds: 0, overdueSeconds: 900, timingStatus: 'overdue' }),
    ]),
  )
  assert.ok(overdue.includes('已超时 15 分钟，请联系员工续时或结账'), overdue)
  assert.ok(overdue.includes('已超时+15 分'), overdue)
})

test('自由计时只显示已用；后端说不能叫就不显示呼叫按钮', async () => {
  const tree = await renderPage([
    session({
      timingMode: 'free',
      durationMinutes: undefined,
      endsAt: undefined,
      remainingSeconds: undefined,
      overdueSeconds: undefined,
      timingStatus: undefined,
      elapsedSeconds: 1500,
    }),
  ])
  const page = text(tree)
  assert.ok(page.includes('A1 桌 · 自由计时'), page)
  assert.ok(page.includes('已拼0:25'), page)
  assert.ok(page.includes('已拼25 分钟'), page)
  assert.ok(!page.includes('还剩'), page)
  assert.equal(callButtons(await renderPage([session({ canCallStaff: false })])).length, 0)
})

test('没有任何计时时显示入座说明，提到店员开台的也会显示在这里', async () => {
  const tree = await renderPage([])
  const page = text(tree)
  assert.ok(page.includes('扫描桌码'), page)
  assert.ok(page.includes('请店员开台的，开台后计时也会显示在这里'), page)
  assert.equal(callButtons(tree).length, 0)
})
