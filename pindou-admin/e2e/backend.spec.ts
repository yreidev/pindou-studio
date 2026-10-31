import { expect, test, type ConsoleMessage } from '@playwright/test'

// 不模拟任何接口：页面由 Go 后端嵌入提供，验证生产 CSP 下能正常运行、单页回退、真实建挑战与轮询。

test('后端提供的页面带 CSP，登录页在 CSP 下无报错，真实生成挑战并轮询', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    // 开发后端是假微信、生成不了小程序码：取码回 503，页面退回普通二维码（这正是要测的退路）。
    // 浏览器把这个失败的请求记成一条控制台错误，只放过它这一种
    const expectedFallback =
      /\/web-login-challenges\/[^/]+\/code$/.test(message.location().url) && /\b503\b/.test(message.text())
    if (expectedFallback) return
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  // CSP 拦截不一定进控制台（Chromium 不报、Firefox 报），直接收集 securitypolicyviolation 事件
  await page.addInitScript(() => {
    const violations: string[] = []
    ;(window as unknown as { __csp: string[] }).__csp = violations
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(
        `${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
      ),
    )
  })
  const polled = page.waitForResponse((response) =>
    /\/api\/v2\/auth\/web-login-challenges\/[^/]+\/session$/.test(response.url()),
  )
  const response = await page.goto('/login')
  expect(response?.status()).toBe(200)
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'")
  expect(response?.headers()['cache-control']).toBe('no-cache')

  await expect(page.locator('.login-qr')).toHaveAttribute('data-qr-text', /^pindou-web-login:[0-9a-f-]{36}$/)
  await expect(page.locator('.login-qr svg')).toBeVisible()
  expect((await polled).status()).toBe(202)

  // 换一个登录码：真后端发新挑战
  const before = await page.locator('.login-qr').getAttribute('data-qr-text')
  await page.getByRole('button', { name: '换一个登录码' }).click()
  await expect(page.locator('.login-qr')).not.toHaveAttribute('data-qr-text', before ?? '')

  expect(problems).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
})

test('深层地址由后端回退到单页应用：还没搬过来的地址显示「没有这个页面」，回首页时要求登录', async ({ page }) => {
  const response = await page.goto('/sales-orders/abc?status=paid')
  expect(response?.status()).toBe(200)
  expect(response?.headers()['content-type']).toContain('text/html')
  await expect(page.getByText('没有这个页面')).toBeVisible()
  await expect(page.locator('a button')).toHaveCount(0)
  await page.getByRole('button', { name: '回到首页' }).click()
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/)
})

test('打包资源长期缓存，接口路径不被页面吞掉', async ({ request }) => {
  const html = await (await request.get('/')).text()
  const asset = html.match(/\/assets\/[^"]+\.js/)?.[0]
  expect(asset).toBeTruthy()
  const assetResponse = await request.get(asset as string)
  expect(assetResponse.headers()['cache-control']).toContain('immutable')

  const missing = await request.get('/api/v2/no-such-resource')
  expect(missing.status()).toBe(404)
  expect(missing.headers()['content-type']).toContain('application/json')
})

test('本地会话在服务端已失效（被撤销或过期）时回到登录页并清掉', async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem('e2e-signed-in')) {
      window.localStorage.setItem(
        'pindou-admin.session',
        JSON.stringify({
          accessToken: 'revoked-token',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          user: { id: '00000000-0000-4000-8000-000000000000', nickname: '旧会话', roles: ['owner'] },
        }),
      )
      window.sessionStorage.setItem('e2e-signed-in', '1')
    }
  })
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?redirect=%2F/)
  expect(await page.evaluate(() => window.localStorage.getItem('pindou-admin.session'))).toBeNull()
})
