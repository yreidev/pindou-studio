import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 扫码给电脑（2026-10-06）：员工手机扫到的码经 POST /scan-relays 转给本人开着的网页后台。
// 电脑没开着时后端回 409 computer_offline，手机说「电脑没在线」；电脑登录码、空内容、带换行的不转。

type Sent = { url: string; method: string; data: any; header: Record<string, string> }

async function service(respond: (sent: Sent) => { statusCode: number; data?: unknown }) {
  const sent: Sent[] = []
  const taro = {
    getStorageSync: () => ({ accessToken: 'token-1' }),
    request: async (options: Sent) => {
      sent.push(options)
      return respond(options)
    },
  }
  const relay = await load('services/scan-relay.ts', { '@tarojs/taro': { default: taro } })
  return { ...relay, sent }
}

const scan =
  (result: string, path = '') =>
  async () => ({ result, path })

test('扫到的码原样（去掉首尾空白）发给本人的电脑，不带幂等键', async () => {
  const { scanAndRelay, sent } = await service(() => ({ statusCode: 200, data: { computers: 2 } }))
  assert.deepEqual(await scanAndRelay(scan(' 6901234567892\n')), { kind: 'sent', code: '6901234567892', computers: 2 })
  assert.equal(sent.length, 1)
  assert.match(sent[0].url, /\/scan-relays$/)
  assert.equal(sent[0].method, 'POST')
  assert.deepEqual(sent[0].data, { code: '6901234567892' })
  assert.equal(sent[0].header.Authorization, 'Bearer token-1')
  assert.equal(sent[0].header['Idempotency-Key'], undefined, '转码不改数据，重发无害')
})

test('电脑没在线：说清楚怎么办；网络失败给出原因', async () => {
  const offline = await service(() => ({
    statusCode: 409,
    data: { code: 'computer_offline', message: '电脑没在线', requestId: 'r' },
  }))
  const outcome = await offline.scanAndRelay(scan('91234567890123456789'))
  assert.equal(outcome.kind, 'offline')
  assert.match(outcome.message, /电脑没在线.*扫码登录/)

  const broken = await service(() => {
    throw new Error('timeout')
  })
  const failed = await broken.scanAndRelay(scan('6901234567892'))
  assert.equal(failed.kind, 'error')
  assert.match(failed.message, /网络连接失败/)
})

test('取消扫码不提示；电脑登录码、小程序码、带换行的、太长的不转', async () => {
  const { scanAndRelay, sent } = await service(() => ({ statusCode: 200, data: { computers: 1 } }))
  assert.deepEqual(await scanAndRelay(async () => Promise.reject({ errMsg: 'scanCode:fail cancel' })), {
    kind: 'cancelled',
  })
  const login = await scanAndRelay(scan('pindou-web-login:11111111-1111-4111-8111-111111111111'))
  assert.match(login.kind === 'error' ? login.message : '', /扫码登录电脑/)
  const acode = await scanAndRelay(scan('', 'pages/staff/web-login/index?scene=abc'))
  assert.match(acode.kind === 'error' ? acode.message : '', /登录码/)
  assert.equal((await scanAndRelay(scan('', 'pages/customer/experience/index?scene=abc'))).kind, 'error')
  assert.equal((await scanAndRelay(scan('第一行\n第二行'))).kind, 'error')
  assert.equal((await scanAndRelay(scan('码'.repeat(257)))).kind, 'error')
  assert.equal(sent.length, 0, '这些都不发请求')
  // 网址、中文照样转：电脑上认不出就只提示「手机扫到：…」
  assert.equal((await scanAndRelay(scan('https://example.com/商品?id=1'))).kind, 'sent')
})

test('扫到的是什么：会员码、商品条码、其他', async () => {
  const { relayKind } = await service(() => ({ statusCode: 200 }))
  assert.equal(relayKind('91234567890123456789'), 'member')
  assert.equal(relayKind('6901234567892'), 'barcode')
  assert.equal(relayKind('Ab-12/x'), 'barcode')
  assert.equal(relayKind('https://example.com/商品'), 'other')
})
