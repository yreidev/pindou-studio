const assert = require('node:assert/strict')
const fs = require('node:fs')
const automator = require(process.env.WECHAT_AUTOMATOR_MODULE || 'miniprogram-automator')
const out = process.env.PINDOU_SCREENSHOT_DIR || '/tmp/pindou-staff-wechat'

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const mini = await automator.connect({ wsEndpoint: process.env.WECHAT_AUTOMATOR_ENDPOINT || 'ws://127.0.0.1:9420' })
  const mocked = ['request', 'login', 'getStorageSync', 'setStorageSync', 'removeStorageSync', 'connectSocket']
  let timer
  try {
    const verify = async () => {
      await mini.mockWxMethod('login', { code: 'isolated-test-login' })
      await mini.mockWxMethod('getStorageSync', {
        accountId: '11111111-1111-4111-8111-111111111111',
        accessToken: 'isolated-wechat-test',
        expiresAt: '2030-01-01T00:00:00Z',
      })
      await mini.mockWxMethod('setStorageSync', () => {})
      await mini.mockWxMethod('removeStorageSync', () => {})
      await mini.mockWxMethod('connectSocket', { errMsg: 'connectSocket:fail isolated test' })
      await mini.mockWxMethod('request', function (options) {
        const app = getApp()
        app.__staffRegression = app.__staffRegression || { requests: [], amount: 100, failSave: true, version: 1 }
        const state = app.__staffRegression
        state.requests.push({ url: options.url, method: options.method, data: options.data })
        const user = {
          id: '11111111-1111-4111-8111-111111111111',
          nickname: '测试店长',
          roles: ['manager'],
          phoneMasked: '138****5678',
          phoneVerificationStatus: 'verified',
        }
        const order = {
          id: '22222222-2222-4222-8222-222222222222',
          version: String(state.version).padStart(64, '0'),
          status: 'draft',
          receivableCents: state.amount,
          paidCents: 0,
          lines: [{ name: '拼豆体验', quantity: 1, unitPriceCents: state.amount }],
        }
        if (options.url.includes('/auth/wechat-sessions'))
          return {
            statusCode: 201,
            data: { accessToken: 'isolated-wechat-test', expiresAt: '2030-01-01T00:00:00Z', user },
          }
        if (options.url.includes('/accounts/')) return { statusCode: 200, data: user }
        if (options.url.includes('/system/backups')) return { statusCode: 403, data: { code: 'forbidden' } }
        if (options.url.includes('/system/audit-events')) return { statusCode: 200, data: [] }
        if (options.url.includes('/sales-orders/')) {
          if (options.method !== 'GET' && options.data.expectedVersion !== order.version)
            return { statusCode: 409, data: { code: 'order_version_conflict' } }
          if (options.method === 'PATCH') {
            if (state.failSave) return { statusCode: 400, data: { message: '保存被拒绝' } }
            state.amount = 200
            order.receivableCents = 200
            order.lines[0].unitPriceCents = 200
            state.version++
            order.version = String(state.version).padStart(64, '0')
          }
          return { statusCode: 200, data: order }
        }
        return { statusCode: 200, data: [] }
      })
      let page = await mini.reLaunch('/pages/staff/operations/index')
      await page.waitFor(500)
      const buttons = await page.$$('.button')
      for (const button of buttons) if ((await button.text()).includes('重新登录')) await button.tap()
      await page.waitFor('.staff-section')
      assert.equal((await page.$$('.staff-section')).length, 2, 'manager should only see exports and audit')
      const calledBackup = await mini.evaluate(() =>
        (getApp().__staffRegression?.requests || []).some((r) => r.url.includes('/system/backups')),
      )
      assert.equal(calledBackup, false)
      await mini.screenshot({ path: `${out}/manager-operations.png` })
      page = await mini.navigateTo('/pages/staff/checkout/index?id=22222222-2222-4222-8222-222222222222')
      await page.waitFor('.staff-section')
      const inputs = await page.$$('input')
      await inputs[3].input('200')
      await page.waitFor(200)
      let actions = await page.$$('.button')
      assert.equal(await actions[1].property('disabled'), true)
      await actions[0].tap()
      await page.waitFor('.field-error')
      const errors = await page.$$('.field-error')
      assert.ok((await errors[0].text()).includes('保存被拒绝'))
      await mini.screenshot({ path: `${out}/checkout-unsaved-error.png` })
      await mini.evaluate(() => {
        getApp().__staffRegression.failSave = false
      })
      actions = await page.$$('.button')
      await actions[0].tap()
      await page.waitFor(300)
      actions = await page.$$('.button')
      assert.equal(await actions[1].property('disabled'), false)
      await mini.screenshot({ path: `${out}/checkout-saved.png` })
      await mini.evaluate(() => {
        getApp().__staffRegression.version++
      })
      await actions[1].tap()
      await page.waitFor('.field-error')
      assert.ok((await (await page.$('.field-error')).text()).includes('订单已被修改'))
      actions = await page.$$('.button')
      assert.equal(await actions[2].property('disabled'), true)
      await mini.screenshot({ path: `${out}/checkout-version-conflict.png` })
      console.log(
        'WeChat simulator: manager permissions, unsaved payment guard, save error, recovery and stale payment passed',
      )
    }
    await Promise.race([
      verify(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WeChat automation did not respond within 25 seconds')), 25000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    for (const method of mocked) await mini.restoreWxMethod(method).catch(() => {})
    await mini
      .evaluate(() => {
        delete getApp().__staffRegression
      })
      .catch(() => {})
    mini.disconnect()
  }
})().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
