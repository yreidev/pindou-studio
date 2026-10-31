import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes, settle } from './helpers/tree'

// 电脑登录页：二维码谁都能拍到，真正的门是「允许登录」。只有等待确认、还没过期的请求才给这个按钮，
// 而且按钮前先把设备、网络地址、发起时间摆出来。

function hooks() {
  const slots: any[] = []
  let cursor = 0
  const api = {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [slots[i], (next: any) => (slots[i] = typeof next === 'function' ? next(slots[i]) : next)]
    },
    useRef: (initial: any) => api.useState(() => ({ current: initial }))[0],
    useEffect() {},
  }
  return {
    api,
    render(fn: () => unknown) {
      cursor = 0
      return fn()
    },
  }
}
const button = (tree: unknown, text: string) => nodes(tree, (n) => n.type === 'Button' && label(n) === text)[0]

const id = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b'
const request = (overrides = {}) => ({
  id,
  status: 'pending',
  createdAt: '2026-10-04T06:00:00Z',
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0',
  ip: '10.0.0.8',
  ...overrides,
})

async function page({
  params = { id } as Record<string, string>,
  data = request() as any,
  confirm = true,
}: { params?: Record<string, string>; data?: any; confirm?: boolean } = {}) {
  const calls: any[] = []
  const h = hooks()
  const service = await load('services/web-login.ts', {
    '@tarojs/taro': { default: {} },
    './navigation': { navigateApp() {} },
    './staff': { request() {} },
  })
  const { default: WebLogin } = await load('pages/staff/web-login/index.tsx', {
    react: h.api,
    '@tarojs/components': { View: 'View', Text: 'Text' },
    '@tarojs/taro': {
      default: {
        showModal: async (options) => {
          calls.push(['confirm', options.title])
          return { confirm }
        },
      },
      useRouter: () => ({ params }),
    },
    '../../../components/button': { Button: 'Button' },
    '../../../components/staff': {
      StaffScreen: 'Screen',
      useStaffData: () => ({ data, loading: false, error: null, refresh: () => calls.push(['refresh']) }),
    },
    '../../../services/format': await load('services/format.ts', {}),
    '../../../services/staff': { staffMessage: (e) => e.message },
    '../../../services/web-login': {
      ...service,
      scanWebLogin: async () => '',
      webLogin: {
        decide: async (...args) => calls.push(['decide', ...args]),
        revokeAll: async () => {
          calls.push(['revokeAll'])
          return { revoked: 2 }
        },
      },
    },
  })
  return { render: () => h.render(WebLogin), calls }
}

test('等待确认的请求：先摆出设备和网络地址，再给允许与拒绝', async () => {
  const p = await page()
  let tree = p.render()
  const text = label(tree)
  assert.match(text, /Windows 电脑 · Edge 浏览器/)
  assert.match(text, /10\.0\.0\.8/)
  assert.match(text, /等待你确认/)
  button(tree, '允许登录').props.onClick()
  await settle()
  assert.deepEqual(p.calls.slice(0, 2), [['decide', id, true], ['refresh']])
  tree = p.render()
  assert.match(label(tree), /已允许，电脑上会自动进入后台/)

  const reject = await page()
  button(reject.render(), '拒绝').props.onClick()
  await settle()
  assert.deepEqual(reject.calls[0], ['decide', id, false])
})

test('过期、已拒绝、已登录的请求都不给允许按钮', async () => {
  for (const [data, pattern] of [
    [request({ expiresAt: new Date(Date.now() - 1000).toISOString() }), /二维码已过期/],
    [request({ status: 'expired' }), /二维码已过期/],
    [request({ status: 'rejected' }), /已拒绝/],
    [request({ status: 'used' }), /这台电脑已经登录/],
  ] as [ReturnType<typeof request>, RegExp][]) {
    const tree = (await page({ data })).render()
    assert.equal(button(tree, '允许登录'), undefined, data.status)
    assert.match(label(tree), pattern)
    assert.ok(button(tree, '再扫一个'))
  }
})

test('没带编号进来时给扫码按钮；退出本人所有电脑登录要先确认，取消就不发请求', async () => {
  const cancelled = await page({ params: {}, data: null, confirm: false })
  let tree = cancelled.render()
  assert.equal((tree as any).props.title, '连电脑')
  assert.ok(button(tree, '扫登录码'))
  assert.equal(button(tree, '允许登录'), undefined)
  button(tree, '全部退出').props.onClick()
  await settle()
  assert.deepEqual(cancelled.calls, [['confirm', '全部退出']])

  const confirmed = await page({ params: {}, data: null, confirm: true })
  button(confirmed.render(), '全部退出').props.onClick()
  await settle()
  assert.deepEqual(confirmed.calls, [['confirm', '全部退出'], ['revokeAll']])
  tree = confirmed.render()
  assert.match(label(tree), /已退出 2 个电脑登录/)
})
