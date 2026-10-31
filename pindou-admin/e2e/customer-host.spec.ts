import { expect, test } from '@playwright/test'

// 顾客域名（pindou.example.invalid）：顾客网页 2026-10-31 下线（docs/plan-split-release.md）。微信扫网页桌码由公众平台的
// 「扫普通链接二维码打开小程序」规则直接打开小程序，不到这里；用手机相机、浏览器扫才打开网页，后端给一页「请用微信扫码」。
// 同一个开发后端按域名分流：localhost 是顾客域名，127.0.0.1 是网页后台（cmd/pindou-dev 的默认）。
const port = Number(process.env.PINDOU_ADMIN_E2E_PORT ?? 18080)
const customer = `http://localhost:${port}`

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test('不用微信扫网页桌码：看到「请用微信扫码」，生产 CSP 下样式照常、没有报错；以前的顾客网页地址 404', async ({
  page,
}) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text())) problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))

  const response = await page.goto(`${customer}/t?tableId=e5e94125-43e3-4088-93cc-b2ea9ea01102`)
  expect(response?.status()).toBe(200)
  expect(response?.headers()['content-security-policy']).toContain("default-src 'none'")
  await expect(page.getByRole('heading', { name: '请用微信扫码' })).toBeVisible()
  await expect(page.getByText('打开微信，点右上角「＋」里的「扫一扫」，再扫一次桌上的二维码。')).toBeVisible()
  // 内联样式没被 CSP 拦：正文居中
  await expect(page.locator('main')).toHaveCSS('text-align', 'center')
  expect(problems).toEqual([])

  expect((await page.request.get(`${customer}/pages/customer/pattern/index?id=x`)).status()).toBe(404)
  // 同一个后端，后台域名照常是网页后台
  expect(await (await page.request.get('/')).text()).toContain('<div id="root">')
})
