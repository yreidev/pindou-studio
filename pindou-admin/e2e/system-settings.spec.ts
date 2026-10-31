import { expect, test } from '@playwright/test'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 系统设置（2026-10-10 起门店级设置都在这一页）：系统内收费开关只有老板能改，要看清后果、写原因、勾确认，
// 带确认时看到的状态提交，被别人改过就 409、重读后重新确认；开关跟着改侧栏（收费关着时没有「订单与退款」）。
// 营业与预约、小程序码版本两个标签页的用例在 reservation-settings.spec.ts、table-codes.spec.ts。

/** 模拟后端：保存时比对 expectedEnabled，不符回 409（同后端 billing_settings.go）。 */
function billingBackend(enabled: boolean) {
  const state = { enabled, updatedAt: null as string | null }
  const saved: unknown[] = []
  const handler: MockHandler = ({ method, path, body }) => {
    if (path !== '/system/billing-settings') return undefined
    if (method === 'GET') return { status: 200, body: state }
    if (method !== 'PATCH') return undefined
    saved.push(body)
    const input = body as { enabled: boolean; expectedEnabled: boolean; reason: string }
    if (input.expectedEnabled !== state.enabled)
      return {
        status: 409,
        body: {
          code: 'billing_settings_conflict',
          message: `系统内收费刚被别人改成了${state.enabled ? '开' : '关'}，请刷新后重新确认`,
          requestId: 'm',
        },
      }
    Object.assign(state, { enabled: input.enabled, updatedAt: new Date().toISOString() })
    return { status: 200, body: state }
  }
  return { state, saved, handler }
}

const nav = (page: import('@playwright/test').Page) => page.locator('.admin-nav')

test('老板打开系统内收费：写原因、勾确认才能提交；打开后侧栏出现订单与退款', async ({ page }) => {
  const backend = billingBackend(false)
  await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/')

  // 收费关着：侧栏没有订单，有系统设置
  await expect(nav(page).getByText('系统设置')).toBeVisible()
  await expect(nav(page).getByText('订单与退款')).toHaveCount(0)
  await nav(page).getByText('系统设置').click()
  await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '系统内收费' })).toHaveAttribute('aria-selected', 'true')

  const card = page.locator('.semi-card', { hasText: '系统内收费' })
  await expect(card).toContainText('没改过（默认关）')
  await expect(card).toContainText('钱在美团、大众点评收，系统只管预约和计时。')
  await card.getByRole('button', { name: '打开…' }).click()

  const dialog = page.locator('.semi-modal', { hasText: '打开系统内收费' })
  await expect(dialog).toContainText('在系统里结账收款，结账后才放座。')
  await expect(dialog).toContainText('打开后，正在计时的台也要结账才能放座。')
  const submit = dialog.getByRole('button', { name: '确认打开' })
  await expect(submit).toBeDisabled()
  await expect(dialog).toContainText('还差：写明为什么改')
  await dialog.getByRole('textbox', { name: '修改原因' }).fill('开始在系统里结账收款')
  await expect(dialog).toContainText('还差：勾选确认已看清后果')
  await expect(submit).toBeDisabled()
  await dialog.locator('.semi-checkbox', { hasText: '我已看清打开后店里怎么收钱、怎么放座' }).click()
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(page.getByText('系统内收费已打开：结账后才放座')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(backend.saved).toEqual([{ enabled: true, expectedEnabled: false, reason: '开始在系统里结账收款' }])
  await expect(card.locator('.semi-tag', { hasText: '开' })).toBeVisible()
  await expect(nav(page).getByText('订单与退款')).toBeVisible()
})

test('收费开关被别人改过：409 后重读，按最新状态重新确认', async ({ page }) => {
  const backend = billingBackend(true)
  await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/system-settings')

  const card = page.locator('.semi-card', { hasText: '系统内收费' })
  await card.getByRole('button', { name: '关掉…' }).click()
  const dialog = page.locator('.semi-modal')
  await expect(dialog).toContainText('关掉系统内收费')
  await expect(dialog).toContainText('正在计时的台直接点「结束」放座')
  await dialog.getByRole('textbox', { name: '修改原因' }).fill('门店的钱都在美团、大众点评收')
  await dialog.locator('.semi-checkbox', { hasText: '我已看清关掉后' }).click()

  // 这时另一台电脑已经关掉了
  backend.state.enabled = false
  await dialog.getByRole('button', { name: '确认关掉' }).click()
  await expect(dialog).toContainText(
    '系统内收费刚被别人改成了关，请刷新后重新确认。已重新读取，请看清现在的状态后再决定。',
  )
  // 重读后按最新的「关」重新确认：要打开得重新勾选
  await expect(dialog).toContainText('打开系统内收费')
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: '确认打开' })).toBeDisabled()
  expect(backend.saved).toEqual([{ enabled: false, expectedEnabled: true, reason: '门店的钱都在美团、大众点评收' }])
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(card.getByRole('button', { name: '打开…' })).toBeVisible()
})

test('不是老板：系统设置只能看；旧的预约设置地址转到营业与预约', async ({ page }) => {
  await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    billingEnabled: false,
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长', roles: ['manager'] })
  await page.goto('/system-settings')
  await expect(page.getByText('只有老板可以修改系统设置。')).toBeVisible()
  const card = page.locator('.semi-card', { hasText: '系统内收费' })
  await expect(card).toContainText('只有老板可以开关。')
  await expect(card.getByRole('button')).toHaveCount(0)
  await expect(nav(page).getByText('系统设置')).toHaveCount(0)
  await expect(nav(page).getByText('订单与退款')).toHaveCount(0)

  await page.goto('/reservation-settings')
  await expect(page).toHaveURL(/\/system-settings\?tab=reservations$/)
  await expect(page.getByRole('tab', { name: '营业与预约' })).toHaveAttribute('aria-selected', 'true')
})
