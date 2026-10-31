import { expect, test } from '@playwright/test'
import { mockApi, signIn } from './mock-api'

test('扫码登录后进入首页：实时连接、角色变化、断线重连、退出', async ({ page }) => {
  const api = await mockApi(page)

  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/)
  const qr = page.locator('.login-qr')
  await expect(qr).toHaveAttribute('data-qr-text', 'pindou-web-login:c1')
  await expect(qr.locator('svg')).toBeVisible()
  await expect(page.getByText('点「连电脑」里的「扫登录码」，扫上面的二维码')).toBeVisible()

  // 第二次轮询时批准
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: '你好，阿贝' })).toBeVisible()
  // 快捷入口是 Card.Meta 排的卡片（图标、标题、说明）；版本两行（网页后台自己的、后端的），提交号用 Semi 的代码样式。
  // 这里的页面是 pnpm build 现编的，没给提交号，网页后台那行写 dev
  await expect(page.locator('.shortcut-card .semi-card-meta-wrapper-title', { hasText: '现场' })).toBeVisible()
  await expect(page.locator('.shortcut-card .semi-card-meta-avatar').first()).toBeVisible()
  const commit = (row: string) => page.locator('.semi-descriptions tr', { hasText: row }).locator('code')
  await expect(commit('网页后台版本')).toHaveText(/^([0-9a-f]{7}|dev)$/)
  await expect(commit('后端版本')).toHaveText(/^([0-9a-f]{7}|unknown)$/)
  await expect(page.locator('.semi-descriptions tr', { hasText: '小程序正式版（最近使用）' })).toContainText('尚未收到')
  await expect(page.locator('.admin-header').getByText('老板')).toBeVisible()
  await expect(page.getByText('实时 · 已连接')).toBeVisible()
  expect(api.sockets).toHaveLength(1)
  expect(api.challenges).toBe(1)

  // 别处把人从老板改成店长：收到任命变动事件，本人资料重读，顶栏跟着变
  api.account = { ...api.account, roles: ['manager'] }
  api.sockets[0].send(JSON.stringify({ type: 'resource.updated', resource: 'staff-role-assignments' }))
  await expect(page.locator('.admin-header').getByText('店长')).toBeVisible()
  await expect(page.locator('.admin-header').getByText('老板')).toHaveCount(0)

  // 服务端断开：先显示断线并给出手动刷新，随后先确认会话、再自动重连
  const readsBefore = api.accountReads
  await api.sockets[0].close()
  await expect(page.getByText('实时 · 已断开，正在重连')).toBeVisible()
  await expect(page.getByRole('button', { name: '立即刷新' })).toBeVisible()
  await expect(page.getByText('实时 · 已连接')).toBeVisible({ timeout: 5_000 })
  expect(api.sockets).toHaveLength(2)
  expect(api.accountReads).toBeGreaterThan(readsBefore)

  // 退出：通知服务端注销本会话，清掉本地会话，回登录页（之后不再批准新的二维码）
  api.approveOnClaim = 0
  await page.locator('.account-trigger').click()
  await page.getByText('退出登录').click()
  await expect(page).toHaveURL(/\/login/)
  expect(api.logouts).toBe(1)
  expect(await page.evaluate(() => window.localStorage.getItem('pindou-admin.session'))).toBeNull()
})

test('首页显示最近使用的小程序正式版和门店时间，收到上报后刷新，读取失败不冒充尚未收到', async ({ page }) => {
  let release: { version: string; reportedAt: string } | null = {
    version: '0.0.38',
    reportedAt: '2026-10-31T03:00:00Z',
  }
  let failed = false
  const api = await mockApi(page, {
    approveOnClaim: 1,
    handlers: [
      ({ method, path }) =>
        method === 'GET' && path === '/system/miniapp-version'
          ? failed
            ? { status: 503, body: { code: 'persistence_failed', message: '数据暂时读不出来，请重试' } }
            : { status: 200, body: { release } }
          : undefined,
    ],
  })
  await page.goto('/')
  const row = page.locator('.semi-descriptions tr', { hasText: '小程序正式版（最近使用）' })
  await expect(row).toContainText('0.0.38')
  await expect(row).toContainText('2026-10-31 11:00 上报')
  await expect(page.getByText('小程序版本来自员工手机上报，手机可能尚未更新。')).toBeVisible()
  release = { version: '0.0.39', reportedAt: '2026-10-31T04:00:00Z' }
  api.sockets[0].send(JSON.stringify({ type: 'resource.updated', resource: 'miniapp-version' }))
  await expect(row).toContainText('0.0.39')
  await expect(row).toContainText('2026-10-31 12:00 上报')
  failed = true
  api.sockets[0].send(JSON.stringify({ type: 'resource.updated', resource: 'miniapp-version' }))
  await expect(row).toContainText('读取失败')
  await expect(row).not.toContainText('尚未收到')
})

test('换得到小程序码时显示它，提示用微信扫一扫；换不到就退回普通二维码', async ({ page }) => {
  await mockApi(page, { miniProgramCode: true, approveOnClaim: 0 })
  await page.goto('/login')
  const qr = page.locator('.login-qr')
  await expect(qr).toHaveAttribute('data-code', 'mini-program')
  await expect(qr.getByRole('img', { name: '登录小程序码：用微信扫一扫' })).toBeVisible()
  await expect(qr.locator('svg')).toHaveCount(0)
  await expect(page.getByText('用手机微信「扫一扫」扫上面的小程序码')).toBeVisible()

  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await mockApi(page, { miniProgramCode: false, approveOnClaim: 0 })
  await page.reload()
  await expect(qr).toHaveAttribute('data-code', 'qr')
  await expect(qr.locator('svg')).toBeVisible()
  await expect(page.getByText('点「连电脑」里的「扫登录码」，扫上面的二维码')).toBeVisible()
})

// 2026-10-05 业主反馈：步骤说明在电脑上就被截断（步骤标题是单行省略），手机上更看不全。
test('登录页的步骤说明在电脑和手机宽度下都完整显示，没有被截断的文字', async ({ page }) => {
  for (const miniProgramCode of [true, false]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await mockApi(page, { miniProgramCode, approveOnClaim: 0 })
    for (const size of [
      { width: 1280, height: 800 },
      { width: 375, height: 740 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/login')
      await expect(page.locator('.login-qr')).toHaveAttribute('data-code', miniProgramCode ? 'mini-program' : 'qr')
      // 内容比显示区宽就是被截断了（省略号或被裁掉）
      const clipped = await page
        .locator('.login-body *')
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (node) =>
                node.children.length === 0 && node.textContent?.trim() && node.scrollWidth > node.clientWidth + 1,
            )
            .map((node) => node.textContent),
        )
      expect(clipped, `${size.width}px，${miniProgramCode ? '小程序码' : '普通二维码'}`).toEqual([])
    }
  }
})

test('扫码被拒或失效时自动换一张新二维码', async ({ page }) => {
  const api = await mockApi(page, { closeEveryChallenge: true })
  await page.goto('/login')
  await expect(page.locator('.login-qr')).toHaveAttribute('data-qr-text', /pindou-web-login:c[2-9]/, {
    timeout: 10_000,
  })
  expect(api.challenges).toBeGreaterThanOrEqual(2)
  await expect(page).toHaveURL(/\/login/)
})

test('没有员工身份的账号只看到说明，不连实时', async ({ page }) => {
  const api = await mockApi(page, {
    account: { id: 'u-customer', nickname: '顾客', roles: [], phoneVerificationStatus: 'verified' },
  })
  await signIn(page, { id: 'u-customer', nickname: '顾客', roles: [] })
  await page.goto('/')
  await expect(page.getByText('当前身份没有员工权限')).toBeVisible()
  await expect(page.locator('.admin-nav')).toHaveCount(0)
  expect(api.sockets).toHaveLength(0)
})

test('登录后回到原来要去的地址；登录页不能被拿来跳去外站', async ({ page }) => {
  await mockApi(page, { approveOnClaim: 1 })
  await page.goto('/login?redirect=%2F%5Cevil.example')
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  expect(new URL(page.url()).hostname).toBe('127.0.0.1')
})
