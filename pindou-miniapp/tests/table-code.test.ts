import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

// 扫桌码从「本次手作」页里抽出来，因为首页那张主卡也要用它：顾客到店的第一个动作
// 不该是「点主卡 → 进一个只有一个按钮的页 → 再点按钮 → 才开相机」。
// 抽出来之后这段逻辑就能单独验 —— 在页面里时它被相机挡着，测不到。
const loadService = (scanCode: () => Promise<unknown>) =>
  load<typeof import('../src/services/table-code')>('services/table-code.ts', {
    '@tarojs/taro': { default: { scanCode } },
  })

const service = await loadService(async () => ({}))

test('a table code is recognised from every shape the shop hands out', () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  // 门店贴的二维码（小程序页面链接）
  assert.equal(service.tableIdFrom(`https://x/pages/customer/experience/index?tableId=${uuid}`), uuid)
  // 桌上印的自定义码
  assert.equal(service.tableIdFrom(`examplebrand-table:${uuid}`), uuid)
  // 小程序码的 scene 是 32 位无连字符，要补回来才能和后端的 ID 对上
  assert.equal(service.tableIdFrom('scene=aaaaaaaabbbb4ccc8dddeeeeeeeeeeee'), uuid)
  // 别家的码：认不出来就说认不出来，不能瞎猜一个 ID 出去
  assert.equal(service.tableIdFrom('https://example.com/promo?id=123'), '')
  assert.equal(service.tableIdFrom(''), '')
})

test('the table comes from every way a page can be opened', () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  // 站内跳转
  assert.equal(service.tableIdFromLaunch({ tableId: uuid }), uuid)
  // 微信扫小程序码
  assert.equal(service.tableIdFromLaunch({ scene: 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee' }), uuid)
  assert.equal(service.tableIdFromLaunch({ scene: 'envcheck' }), '')
  // 微信扫桌上的网页桌码（扫普通链接二维码打开小程序）：地址编码后放在 q 里，框架解过码时也认
  const link = `https://pindou.example.invalid/t?tableId=${uuid}`
  assert.equal(service.tableIdFromLaunch({ q: encodeURIComponent(link), scancode_time: '1760000000' }), uuid)
  assert.equal(service.tableIdFromLaunch({ q: link }), uuid)
  // 别的链接、坏掉的编码：认不出就是没有，不瞎猜
  assert.equal(service.tableIdFromLaunch({ q: encodeURIComponent('https://example.com/promo?id=123') }), '')
  assert.equal(service.tableIdFromLaunch({ q: '%E0%A4%A' }), '')
  assert.equal(service.tableIdFromLaunch({}), '')
})

test('scanning returns the table, and a cancelled scan is not an error', async () => {
  const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const ok = await loadService(async () => ({ path: `pages/customer/experience/index?tableId=${uuid}` }))
  assert.equal(await ok.scanTableCode(), uuid)

  // result 而不是 path 的情况（自定义码）
  const raw = await loadService(async () => ({ result: `examplebrand-table:${uuid}` }))
  assert.equal(await raw.scanTableCode(), uuid)

  // 用户按了取消：返回空串，调用方什么都不做。这不是错误，不该弹提示。
  const cancelled = await loadService(async () => {
    throw { errMsg: 'scanCode:fail cancel' }
  })
  assert.equal(await cancelled.scanTableCode(), '')

  // 扫到不认识的码：要抛，调用方得告诉顾客扫错了
  const foreign = await loadService(async () => ({ result: 'https://example.com/promo' }))
  await assert.rejects(() => foreign.scanTableCode(), /请扫描门店桌码/)

  // 相机打不开是真的错误，不能被当成取消吞掉
  const broken = await loadService(async () => {
    throw { errMsg: 'scanCode:fail auth deny' }
  })
  await assert.rejects(() => broken.scanTableCode())
})
