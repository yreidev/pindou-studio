import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 扫码登录电脑：员工扫电脑屏幕上的码，看清设备后批准。二维码谁都能拍到，
// 真正的门是批准那一下，所以扫到的必须是电脑登录码、设备要说成人话。

async function setup({ scan }: { scan?: () => any } = {}) {
  const calls: any[] = []
  const service = await load<typeof import('../src/services/web-login')>('services/web-login.ts', {
    '@tarojs/taro': {
      default: {
        scanCode: async (options) => {
          calls.push(['scan', options])
          return scan!()
        },
        showToast: (options) => calls.push(['toast', options.title]),
      },
    },
    './navigation': { navigateApp: async (...args) => calls.push(['navigate', ...args]) },
    './staff': {
      request: async (...args) => {
        calls.push(['request', ...args])
        return { revoked: 2 }
      },
    },
  })
  return { service, calls }
}

const id = '6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b'

test('只认电脑登录码，桌码和别家的二维码一律不认', async () => {
  const { service } = await setup()
  assert.equal(service.parseWebLoginQr(`pindou-web-login:${id}`), id)
  assert.equal(service.parseWebLoginQr(`  pindou-web-login:${id}\n`), id)
  for (const text of [
    '',
    id,
    `examplebrand-table:${id}`,
    'pindou-web-login:',
    'pindou-web-login:../../auth',
    `pindou-web-login:${id}?x=1`,
    `https://admin.example.invalid/login?id=${id}`,
  ])
    assert.equal(service.parseWebLoginQr(text), '', text)
})

test('设备说成人话，认不出来时如实说未知', async () => {
  const { service } = await setup()
  const cases = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0',
      'Windows 电脑 · Edge 浏览器',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      'Windows 电脑 · Chrome 浏览器',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      'Mac 电脑 · Safari 浏览器',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      'iPad · Safari 浏览器',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0', 'Linux 电脑 · Firefox 浏览器'],
    ['curl/8.10', '未知设备'],
    ['', '未知设备'],
  ]
  for (const [ua, expected] of cases) assert.equal(service.describeDevice(ua), expected)
})

test('扫码只用相机、不限码的类型（限了真机认不出小程序码）；取消不提示，扫错了说清楚', async () => {
  let result: any = { result: `pindou-web-login:${id}` }
  const { service, calls } = await setup({ scan: () => (typeof result === 'function' ? result() : result) })
  assert.equal(await service.scanWebLogin(), id)
  assert.deepEqual(calls[0], ['scan', { onlyFromCamera: true }])

  result = () => {
    throw { errMsg: 'scanCode:fail cancel' }
  }
  assert.equal(await service.scanWebLogin(), '')

  result = { result: `examplebrand-table:${id}` }
  await assert.rejects(service.scanWebLogin(), /不是电脑后台的登录码/)
})

test('工作台扫码：扫到就进确认页，扫错轻提示，取消什么都不做', async () => {
  let result: any = { result: `pindou-web-login:${id}` }
  const { service, calls } = await setup({ scan: () => (typeof result === 'function' ? result() : result) })
  await service.openWebLoginByScan()
  assert.deepEqual(calls.at(-1), ['navigate', `/pages/staff/web-login/index?id=${id}`, true])

  result = { result: 'https://example.com' }
  await service.openWebLoginByScan()
  assert.equal(calls.at(-1)[0], 'toast')
  assert.match(calls.at(-1)[1], /不是电脑后台的登录码/)

  result = () => {
    throw { errMsg: 'scanCode:fail cancel' }
  }
  const before = calls.length
  await service.openWebLoginByScan()
  assert.deepEqual(calls.slice(before), [['scan', { onlyFromCamera: true }]])
})

test('查看、批准、拒绝、全部退出走 docs/api.yaml 里的接口', async () => {
  const { service, calls } = await setup()
  await service.webLogin.view(id)
  await service.webLogin.decide(id, true)
  await service.webLogin.decide(id, false)
  await service.webLogin.revokeAll()
  assert.deepEqual(
    calls.map((call) => call.slice(1)),
    [
      [`/auth/web-login-challenges/${id}`],
      [`/auth/web-login-challenges/${id}/decision`, 'POST', { approve: true }],
      [`/auth/web-login-challenges/${id}/decision`, 'POST', { approve: false }],
      ['/auth/web-sessions', 'DELETE'],
    ],
  )
})

// 网页后台登录码是小程序码：微信扫一扫打开批准页，挑战编号（去掉连字符）在 scene 里，可能被编码过；
// 在小程序里用「扫码」扫到它时，编号在结果的 path 里。
test('电脑登录码的 scene 换回挑战编号；别的 scene 不认', async () => {
  const { service } = await setup()
  const scene = id.replaceAll('-', '')
  assert.equal(service.webLoginIdFromScene(scene), id)
  assert.equal(service.webLoginIdFromScene(scene.toUpperCase()), id)
  assert.equal(service.webLoginIdFromScene(encodeURIComponent(scene)), id)
  assert.equal(service.webLoginIdFromScene(`scene=${scene}`), id)
  for (const value of [undefined, '', id, scene.slice(1), `${scene}0`, 'tableId=abc', '%E0%A4%A']) {
    assert.equal(service.webLoginIdFromScene(value), '', String(value))
  }
})

test('在小程序里扫到电脑登录的小程序码，也能认出挑战', async () => {
  const scene = id.replaceAll('-', '')
  const { service } = await setup({ scan: () => ({ result: '', path: `pages/staff/web-login/index?scene=${scene}` }) })
  assert.equal(await service.scanWebLogin(), id)
  const table = await setup({
    scan: () => ({ result: '', path: `pages/customer/experience/index?scene=${'a'.repeat(32)}` }),
  })
  await assert.rejects(table.service.scanWebLogin(), /不是电脑后台的登录码/)
})
