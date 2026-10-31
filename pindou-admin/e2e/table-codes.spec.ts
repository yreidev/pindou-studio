import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 桌码：按区域列出桌位；单张生成预览；批量逐张生成，单张失败不影响其余并标出来；停用的桌不出码；
// 打印时只留桌码版面（侧栏、顶栏、操作区都隐藏），可以只打印一张。店员也能用。

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const areas = [
  { id: 'area-c', name: 'C 区' },
  { id: 'area-a', name: 'A 区' },
  { id: 'area-b', name: 'B 区' },
]
const table = (id: string, floorAreaId: string, number: number, extra: Record<string, unknown> = {}) => ({
  id,
  code: id.toUpperCase(),
  zone: id[0].toUpperCase(),
  floorAreaId,
  number,
  seatCount: 1,
  wholeTable: false,
  enabled: true,
  occupancy: 'idle',
  ...extra,
})
const tables = [
  table('c1', 'area-c', 1),
  table('b3', 'area-b', 3),
  table('b1', 'area-b', 1),
  table('b2', 'area-b', 2, { enabled: false }),
  table('a1', 'area-a', 1, { seatCount: 2, wholeTable: true }),
]

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as { __prints: number; print: () => void }
    target.__prints = 0
    target.print = () => {
      target.__prints++
    }
  })
}
const printCount = (page: Page) => page.evaluate(() => (window as unknown as { __prints: number }).__prints)

test('店员批量生成桌码：逐张请求、失败标出并可重试、停用的桌不出码，打印只留桌码', async ({ page }) => {
  const requested: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  let b3Fails = true
  const handler: MockHandler = async ({ method, path, search }) => {
    if (method === 'GET' && path === '/service-tables') return { status: 200, body: tables }
    if (method === 'GET' && path === '/floor-areas') return { status: 200, body: areas }
    if (method === 'GET' && path === '/loyalty/table-code') {
      const id = search.get('tableId') ?? ''
      requested.push(id)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 80))
      inFlight--
      if (id === 'b2') return { status: 404, body: { code: 'not_found', message: 'not_found' } }
      if (id === 'b3' && b3Fails)
        return {
          status: 503,
          body: { code: 'wechat_unavailable', message: '微信返回 errcode 45009：调用太频繁', requestId: 'r' },
        }
      return { status: 200, body: { imageDataUrl: png } }
    }
    return undefined
  }
  await stubPrint(page)
  await mockApi(page, {
    account: { id: 'u-li', nickname: '小李', roles: ['clerk'], phoneVerificationStatus: 'verified' },
    handlers: [handler],
  })
  await signIn(page, { id: 'u-li', nickname: '小李', roles: ['clerk'] })
  await page.goto('/table-codes')
  // 默认是网页桌码（见下面的用例），这里测小程序码
  await page.getByText('小程序码', { exact: true }).click()

  // 按区域分组、区内按桌号排；停用的桌没有勾选框和生成按钮
  await expect(page.getByRole('heading', { name: '桌码', exact: true })).toBeVisible()
  const zoneTitles = page.locator('.semi-card-header-wrapper-title')
  // 小程序码指向的版本在「系统设置」里改，这里只写出指向哪个版本（店员没有链接）
  await expect(zoneTitles).toHaveText(['批量生成与打印', 'A 区', 'B 区', 'C 区'])
  await expect(page.getByText('指向体验版（老板在系统设置里改）')).toBeVisible()
  const row = (code: string) => page.locator('.semi-table-row', { hasText: new RegExp(`^${code}`) })
  await expect(row('A1')).toContainText('2 座 · 整桌')
  await expect(row('B2')).toContainText('已停用')
  await expect(row('B2')).toContainText('停用的桌不出码')
  await expect(row('B2').getByRole('button')).toHaveCount(0)
  await expect(row('B2').getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByText('已选 4 张（启用 4 张，共 5 张）')).toBeVisible()

  // 单张生成并预览
  await row('A1').getByRole('button', { name: '生成' }).click()
  await expect(row('A1').getByRole('img', { name: 'A1 桌码' })).toBeVisible()
  await row('A1').getByText('预览').click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('桌码 · A1')).toBeVisible()
  await expect(dialog.getByText('Example示例工坊·拼豆·手作研究室')).toBeVisible()
  await expect(dialog.getByRole('img', { name: 'A1 桌码' })).toBeVisible()
  await page.locator('.semi-modal button', { hasText: '关闭' }).click()
  await expect(dialog).toHaveCount(0)

  // 取消勾选一张，批量数量跟着变；再勾回来（Semi 的勾选框真正的 input 藏在样式框下面，点外框）
  const pickC1 = page.locator('.semi-checkbox', { has: page.getByRole('checkbox', { name: '选择 C1' }) })
  await pickC1.click()
  await expect(page.getByRole('checkbox', { name: '选择 C1' })).not.toBeChecked()
  await expect(page.getByText('已选 3 张（启用 4 张，共 5 张）')).toBeVisible()
  await expect(page.getByRole('button', { name: '生成所选桌码（2 张）' })).toBeVisible()
  await pickC1.click()
  await expect(page.getByRole('checkbox', { name: '选择 C1' })).toBeChecked()

  // 批量：只请求还没生成的启用桌，一张完了才下一张；B3 失败不影响 C1
  await page.getByRole('button', { name: '生成所选桌码（3 张）' }).click()
  await expect(page.getByRole('status')).toContainText('生成完成：成功 2 张，失败 1 张')
  expect(requested).toEqual(['a1', 'b1', 'b3', 'c1'])
  expect(maxInFlight).toBe(1)
  await expect(row('B3')).toContainText('失败：微信返回 errcode 45009：调用太频繁')
  await expect(row('C1').getByRole('img', { name: 'C1 桌码' })).toBeVisible()
  await expect(page.getByText('所选的桌里还有 1 张没有生成成功的桌码')).toBeVisible()

  // 打印所选：只有生成成功的三张，版式每页 4 张
  await page.getByRole('button', { name: '打印所选（3 张）' }).click()
  expect(await printCount(page)).toBe(1)
  await page.emulateMedia({ media: 'print' })
  const sheets = page.getByTestId('table-code-sheets')
  await expect(sheets).toBeVisible()
  await expect(sheets).toHaveClass(/table-code-per-page-4/)
  await expect(sheets.locator('.table-code-label')).toHaveText(['A1', 'B1', 'C1'])
  await expect(sheets.locator('.table-code-brand').first()).toHaveText('Example示例工坊·拼豆·手作研究室')
  await expect(page.locator('.semi-layout-sider')).toBeHidden()
  await expect(page.locator('.admin-header')).toBeHidden()
  await expect(page.getByText('批量生成与打印')).toBeHidden()
  await expect(page.getByRole('heading', { name: '桌码', exact: true })).toBeHidden()
  await page.emulateMedia({ media: 'screen' })
  await expect(sheets).toBeHidden()

  // 失败的重试成功，打印数量跟着变
  b3Fails = false
  await row('B3').getByRole('button', { name: '重试' }).click()
  await expect(row('B3').getByRole('img', { name: 'B3 桌码' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打印所选（4 张）' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '所选桌码都已生成' })).toBeDisabled()
  expect(requested).not.toContain('b2')

  // 每页 1 张，或者在预览里只打印一张
  await page.getByText('每页 1 张', { exact: true }).click()
  await expect(page.getByRole('radio', { name: '每页 1 张' })).toBeChecked()
  await row('B1').getByText('预览').click()
  await page.locator('.semi-modal button', { hasText: '只打印这一张' }).click()
  expect(await printCount(page)).toBe(2)
  await page.emulateMedia({ media: 'print' })
  await expect(sheets.locator('.table-code-label')).toHaveText(['B1'])
  await expect(sheets).toHaveClass(/table-code-per-page-1/)
  // 打印对话框关掉后回到「打印所选」
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await expect(sheets.locator('.table-code-label')).toHaveText(['A1', 'B1', 'B3', 'C1'])
})

test('微信未配置：每张都失败并写明原因，没有可打印的桌码', async ({ page }) => {
  await stubPrint(page)
  await mockApi(page, {
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/service-tables'
          ? { status: 200, body: tables.slice(0, 2) }
          : method === 'GET' && path === '/floor-areas'
            ? { status: 200, body: areas }
            : method === 'GET' && path === '/loyalty/table-code'
              ? { status: 503, body: { code: 'wechat_unavailable', message: '尚未配置微信小程序码服务' } }
              : undefined,
    ],
  })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/table-codes')
  await page.getByText('小程序码', { exact: true }).click()
  await page.getByRole('button', { name: '生成所选桌码（2 张）' }).click()
  await expect(page.getByRole('status')).toContainText('生成完成：成功 0 张，失败 2 张')
  await expect(page.getByText('失败：尚未配置微信小程序码服务')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '打印所选（0 张）' })).toBeDisabled()
})

test('网页桌码在浏览器里生成：不请求微信，切换种类各存各的，打印同一套版面', async ({ page }) => {
  let wechatRequests = 0
  const handler: MockHandler = async ({ method, path }) => {
    if (method === 'GET' && path === '/service-tables') return { status: 200, body: tables }
    if (method === 'GET' && path === '/floor-areas') return { status: 200, body: areas }
    if (method === 'GET' && path === '/loyalty/table-code') {
      wechatRequests++
      return { status: 200, body: { imageDataUrl: png } }
    }
    return undefined
  }
  await stubPrint(page)
  await mockApi(page, { handlers: [handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/table-codes')

  // 默认就是网页桌码：页面写明地址
  await expect(page.getByRole('radio', { name: '网页桌码' })).toBeChecked()
  await expect(page.getByText('https://pindou.example.invalid/t?tableId=…', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '生成所选桌码（4 张）' }).click()
  await expect(page.getByRole('status')).toContainText('生成完成：成功 4 张')
  expect(wechatRequests).toBe(0)
  const image = page.getByRole('img', { name: 'A1 桌码' })
  await expect(image).toHaveAttribute('src', /^data:image\/svg\+xml;charset=utf-8,%3Csvg/)

  // 换成小程序码：那一种还没生成；切回来网页桌码还在
  await page.getByText('小程序码', { exact: true }).click()
  await expect(page.getByRole('button', { name: '生成所选桌码（4 张）' })).toBeVisible()
  await expect(page.getByRole('img', { name: 'A1 桌码' })).toHaveCount(0)
  await page.getByText('网页桌码', { exact: true }).click()
  await expect(page.getByRole('img', { name: 'A1 桌码' })).toBeVisible()

  await page.getByRole('button', { name: '打印所选（4 张）' }).click()
  expect(await printCount(page)).toBe(1)
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByTestId('table-code-sheets').locator('.table-code-label')).toHaveText(['A1', 'B1', 'B3', 'C1'])
  expect(wechatRequests).toBe(0)
})

test('老板改小程序码指向的版本（系统设置）：默认只读，看完提醒、写原因、勾确认才能提交；微信拒绝时不保存', async ({
  page,
}) => {
  let settings = {
    envVersion: 'trial',
    customerWebsite: 'https://pindou.example.invalid',
    updatedAt: null as string | null,
  }
  let rejectRelease = true
  const saved: unknown[] = []
  const handler: MockHandler = ({ method, path, body }) => {
    if (method === 'GET' && path === '/service-tables') return { status: 200, body: tables }
    if (method === 'GET' && path === '/floor-areas') return { status: 200, body: areas }
    if (method === 'GET' && path === '/system/code-settings') return { status: 200, body: settings }
    if (method === 'PATCH' && path === '/system/code-settings') {
      saved.push(body)
      if (rejectRelease)
        return {
          status: 409,
          body: {
            code: 'code_check_failed',
            message: '没有保存：用正式版试生成小程序码，微信拒绝了（errcode 41030，invalid page）',
          },
        }
      settings = { ...settings, envVersion: 'release', updatedAt: new Date().toISOString() }
      return { status: 200, body: settings }
    }
    return undefined
  }
  await mockApi(page, { handlers: [handler] })
  await signIn(page, { id: 'u-owner' })
  // 从桌码页的链接进系统设置的「小程序码版本」
  await page.goto('/table-codes')
  await page.getByText('小程序码', { exact: true }).click()
  await page.getByRole('link', { name: '系统设置' }).click()
  await expect(page).toHaveURL(/\/system-settings\?tab=code$/)
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()

  const card = page.locator('.semi-card').filter({ hasText: '小程序码指向的版本' })
  await expect(card).toContainText('体验版')
  await expect(card).toContainText('没改过（默认体验版）')
  await card.getByRole('button', { name: '修改…' }).click()

  const dialog = page.getByRole('dialog', { name: '修改小程序码指向的版本' })
  await expect(dialog).toContainText('不要随便改')
  await expect(dialog).toContainText('员工用微信扫码打不开批准页，就登录不了网页后台')
  const confirm = dialog.getByRole('button', { name: /确认改成/ })
  await expect(confirm).toBeDisabled()
  await expect(dialog).toContainText('还差：先选一个和现在不同的版本')
  await dialog.getByText('正式版', { exact: true }).click()
  await expect(dialog).toContainText('还差：写明为什么改')
  await dialog.getByRole('textbox', { name: '修改原因' }).fill('小程序正式版已审核发布')
  await expect(dialog).toContainText('还差：勾选确认已了解后果')
  await expect(confirm).toBeDisabled()
  await dialog.locator('.semi-checkbox', { hasText: '我已看完上面的提醒' }).click()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(confirm).toBeEnabled()

  // 微信拒绝：对话框留着、原因照实写出，设置不变
  await confirm.click()
  await expect(dialog).toContainText('微信拒绝了（errcode 41030，invalid page）')
  expect(saved).toEqual([{ envVersion: 'release', expectedEnvVersion: 'trial', reason: '小程序正式版已审核发布' }])

  rejectRelease = false
  await confirm.click()
  await expect(dialog).toBeHidden()
  await expect(card).toContainText('正式版')
  await expect(card).not.toContainText('没改过')
})

test('店员只能看小程序码指向的版本，不能改', async ({ page }) => {
  await mockApi(page, {
    account: { id: 'u-li', nickname: '小李', roles: ['clerk'], phoneVerificationStatus: 'verified' },
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/service-tables'
          ? { status: 200, body: tables }
          : method === 'GET' && path === '/floor-areas'
            ? { status: 200, body: areas }
            : undefined,
    ],
  })
  await signIn(page, { id: 'u-li', nickname: '小李', roles: ['clerk'] })
  await page.goto('/system-settings?tab=code')
  const card = page.locator('.semi-card').filter({ hasText: '小程序码指向的版本' })
  await expect(card).toContainText('体验版')
  await expect(card).toContainText('只有老板可以修改')
  await expect(card.getByRole('button', { name: '修改…' })).toHaveCount(0)
})
