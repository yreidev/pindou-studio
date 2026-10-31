import { expect, test, type Page } from '@playwright/test'
import { layoutBackend, ownerId, sampleMemberId, sampleMemberOrderId, sampleOrderId } from './layout-fixtures'
import { mockApi, signIn } from './mock-api'

// 版式：手机、平板、电脑三种宽度下逐页检查，防止「没居中、移动端没适配、字显示不全」。
// 数据故意给得满（长昵称、长商品名、长原因、几十条记录），截图存到 test-results 供人看。

const viewports = [
  { name: '手机', width: 390, height: 844 },
  { name: '平板', width: 820, height: 1180 },
  { name: '电脑', width: 1440, height: 900 },
] as const

const pages: [string, string][] = [
  ['首页', '/'],
  ['订单列表', '/orders'],
  ['订单详情', `/orders/${sampleOrderId}`],
  ['会员结账单详情', `/orders/${sampleMemberOrderId}`],
  ['库存', '/inventory'],
  ['采购入库', '/inventory?tab=purchase'],
  ['盘点', '/inventory?tab=adjust'],
  ['库存流水', '/inventory?tab=movements'],
  ['商品资料', '/inventory?tab=catalog'],
  ['规则-等级', '/rules?tab=tier'],
  ['规则-套餐', '/rules?tab=package'],
  ['规则-历史', '/rules?tab=history'],
  ['会员资产', `/members?account=${sampleMemberId}`],
  ['系统设置-收费', '/system-settings'],
  ['系统设置-营业与预约', '/system-settings?tab=reservations'],
  ['系统设置-小程序码', '/system-settings?tab=code'],
  ['预约', '/reservations'],
  ['预约-已结束', '/reservations?view=ended'],
  ['预约-代客登记', '/reservations?tab=register'],
  ['员工权限', '/staff'],
  ['运营-导出', '/operations?tab=export'],
  ['运营-审计', '/operations?tab=audit'],
  ['运营-数据', '/operations?tab=data'],
  ['桌码', '/table-codes'],
]

/** 在页面里找版式问题，返回人能看懂的描述。 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const vw = window.innerWidth
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}「${(el.textContent || '').trim().slice(0, 16)}」`
    // 1. 整页、内容区都不能横向溢出
    if (document.documentElement.scrollWidth > vw + 1)
      problems.push(`整页横向溢出：内容宽 ${document.documentElement.scrollWidth}，屏宽 ${vw}`)
    const main = document.querySelector('.admin-content')
    if (main && main.scrollWidth > main.clientWidth + 1)
      problems.push(`内容区横向溢出：内容宽 ${main.scrollWidth}，可见宽 ${main.clientWidth}`)
    // 表格等局部可横向滚动区里的内容不算被裁掉；内容区（.admin-content）整体左右滑不算——那就是溢出
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && !p.classList.contains('admin-content'); p = p.parentElement) {
        const style = getComputedStyle(p)
        if (/(auto|scroll)/.test(style.overflowX) && p.scrollWidth > p.clientWidth + 1) return true
      }
      return false
    }
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    // 2. 内容超出屏幕右边（被裁掉、看不到也点不到）
    const content = document.querySelector('.admin-content') ?? document.body
    let clipped = 0
    for (const el of content.querySelectorAll('button, a, input, th, td, h3, h4, h5, h6, .semi-tag, .semi-card')) {
      if (!visible(el) || inScroller(el)) continue
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1 && clipped++ < 5)
        problems.push(`超出屏幕右边 ${Math.round(r.right - vw)}px：${describe(el)}`)
    }
    // 3. 表头被挤成一个字一行
    for (const th of document.querySelectorAll('.semi-table-thead th')) {
      const text = (th.textContent || '').trim()
      if (!visible(th) || text.length < 2) continue
      const lineHeight = parseFloat(getComputedStyle(th).lineHeight) || 20
      const inner = th.querySelector('.semi-table-row-head-title, span') ?? th
      if (inner.getBoundingClientRect().height > lineHeight * 1.9) problems.push(`表头折行：${describe(th)}`)
    }
    // 4. 表格某一列被挤成两三个字宽（长文字竖着排），或时间被折成几行。
    // 格子高度跟着同一行最高的格子走，所以按文字实际排了几行来判断。
    const textLines = (el: Element) => {
      const tops: number[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        for (const rect of range.getClientRects())
          if (rect.width > 0 && !tops.some((top) => Math.abs(top - rect.top) < 6)) tops.push(rect.top)
      }
      return tops.length
    }
    let squeezed = 0
    for (const td of document.querySelectorAll('.semi-table-tbody td')) {
      const text = (td.textContent || '').trim()
      if (!visible(td) || text.length < 4 || squeezed >= 5) continue
      const style = getComputedStyle(td)
      const fontSize = parseFloat(style.fontSize) || 14
      const width = td.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const lines = textLines(td)
      if (width < fontSize * 4 && lines >= 3) {
        squeezed++
        problems.push(`表格列被挤窄（${Math.round(width)}px，${lines} 行）：${describe(td)}`)
      } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text) && lines > 1) {
        squeezed++
        problems.push(`时间折行：${describe(td)}`)
      }
    }
    // 5. 关键文字被截断（菜单、标题、按钮、标签页、角色标签、账户名）
    const critical =
      '.semi-navigation-item-text, h3, h4, .semi-card-header-wrapper-title, .semi-button-content, .semi-tabs-tab, .admin-header .semi-tag, .account-trigger .semi-typography'
    for (const el of document.querySelectorAll(critical)) {
      if (!visible(el)) continue
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
        problems.push(`文字被截断：${describe(el)}`)
    }
    // 6. 顶栏账户名不能折行
    const name = document.querySelector('.account-trigger .semi-typography')
    if (name && visible(name) && name.getBoundingClientRect().height > 30) problems.push('顶栏账户名折行')
    return problems
  })
}

for (const viewport of viewports) {
  test.describe(`${viewport.name} ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('登录页：二维码卡片居中、说明完整', async ({ page }, testInfo) => {
      await mockApi(page, { approveOnClaim: 0 })
      await page.goto('/login')
      await expect(page.locator('.login-qr svg')).toBeVisible()
      const card = await page.locator('.login-card').boundingBox()
      expect(card).not.toBeNull()
      const left = card!.x
      const right = viewport.width - card!.x - card!.width
      expect(Math.abs(left - right), '登录卡片左右留白应相等').toBeLessThanOrEqual(2)
      expect(await layoutProblems(page)).toEqual([])
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-登录.png`), fullPage: true })
    })

    test('后台各页：不溢出、不截断、表头不竖排', async ({ page }, testInfo) => {
      await mockApi(page, {
        account: { id: ownerId, nickname: '阿贝', roles: ['owner'], phoneVerificationStatus: 'verified' },
        handlers: [layoutBackend],
      })
      await signIn(page, { id: ownerId, nickname: '阿贝', roles: ['owner'] })
      const found: string[] = []
      for (const [name, path] of pages) {
        await page.goto(path)
        await expect(page.locator('h3').first()).toBeVisible()
        await expect(page.locator('.semi-spin-spinning')).toHaveCount(0)
        await page.waitForTimeout(150)
        for (const problem of await layoutProblems(page)) found.push(`${name}：${problem}`)
        await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${name}.png`), fullPage: true })
      }
      expect(found).toEqual([])
    })
  })
}

// 弹出层（日期面板、下拉、抽屉、弹窗、菜单）渲染在页面之外的 .semi-portal 里，上面逐页检查看不到，
// 手机上逐个打开，看有没有伸出屏幕。日期范围面板（两个月并排）和长选项下拉都出过这个问题。
const overlays: [string, string, (page: Page) => Promise<void>][] = [
  ['流水开始日期', '/inventory?tab=movements', (page) => page.getByPlaceholder('开始日期').click()],
  ['流水结束日期', '/inventory?tab=movements', (page) => page.getByPlaceholder('结束日期').click()],
  ['流水商品下拉', '/inventory?tab=movements', (page) => page.locator('.toolbar .semi-select').first().click()],
  ['员工账号下拉', '/staff', (page) => page.locator('.semi-select').first().click()],
  ['歇业日期面板', '/system-settings?tab=reservations', (page) => page.getByPlaceholder('选择歇业日期').click()],
  ['预约日期面板', '/reservations', (page) => page.getByPlaceholder('全部日期').click()],
  ['预约详情抽屉', '/reservations', (page) => page.getByRole('button', { name: '详情' }).first().click()],
  ['取消预约弹窗', '/reservations', (page) => page.getByRole('button', { name: '取消预约' }).first().click()],
  ['收费开关弹窗', '/system-settings', (page) => page.getByRole('button', { name: '关掉…' }).click()],
  ['退款抽屉', `/orders/${sampleOrderId}`, (page) => page.getByRole('button', { name: '办理退款' }).click()],
  [
    '会员退款抽屉',
    `/orders/${sampleMemberOrderId}`,
    (page) => page.getByRole('button', { name: '办理会员退款' }).click(),
  ],
  ['规则编辑抽屉', '/rules?tab=tier', (page) => page.getByRole('button', { name: '新建会员等级' }).click()],
  ['停用规则弹窗', '/rules?tab=tier', (page) => page.getByRole('button', { name: '停用' }).first().click()],
  ['新增商品弹窗', '/inventory?tab=catalog', (page) => page.getByRole('button', { name: '新增商品' }).click()],
  ['导航抽屉', '/', (page) => page.getByRole('button', { name: '打开菜单' }).click()],
  ['账户菜单', '/', (page) => page.locator('.account-trigger').click()],
  [
    '提醒设置弹窗',
    '/',
    async (page) => {
      await page.locator('.account-trigger').click()
      await page.getByRole('menuitem', { name: '提醒设置' }).click()
      await expect(page.locator('.semi-modal-content')).toBeVisible()
    },
  ],
]

test.describe('手机 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('弹出层不伸出屏幕', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await mockApi(page, {
      account: { id: ownerId, nickname: '阿贝', roles: ['owner'], phoneVerificationStatus: 'verified' },
      handlers: [layoutBackend],
    })
    await signIn(page, { id: ownerId, nickname: '阿贝', roles: ['owner'] })
    const found: string[] = []
    for (const [name, path, open] of overlays) {
      await page.goto(path)
      await expect(page.locator('h3').first()).toBeVisible()
      await expect(page.locator('.semi-spin-spinning')).toHaveCount(0)
      await open(page)
      // 等弹出层真正出现（下拉、日期面板、菜单显示时带 *-wrapper-show；抽屉、弹窗各有自己的容器）
      await expect(
        page.locator('.semi-portal [class*="-wrapper-show"], .semi-sidesheet-inner, .semi-modal-content').first(),
      ).toBeVisible()
      await page.waitForTimeout(400) // 等弹出动画走完再量
      const outside = await page.evaluate(() => {
        const vw = window.innerWidth
        const out: string[] = []
        for (const el of document.querySelectorAll('.semi-portal *')) {
          const r = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue
          if (r.right > vw + 1 || r.left < -1)
            out.push(
              `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}（${Math.round(r.left)}～${Math.round(r.right)}px）`,
            )
        }
        return [...new Set(out)].slice(0, 3)
      })
      for (const item of outside) found.push(`${name}：伸出屏幕 ${item}`)
      await page.screenshot({ path: testInfo.outputPath(`手机-弹出-${name}.png`) })
    }
    expect(found).toEqual([])
  })
})
