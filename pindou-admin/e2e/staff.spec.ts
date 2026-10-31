import { expect, test, type Page } from '@playwright/test'
import { accountListResult } from './account-list'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 员工权限：选账号（关键字在服务端筛，不拉全部账号）、选角色、确认后分配；撤销要确认；自己那条不给撤销。
// 任命列表里的称呼由服务端带上。

type Listed = { id: string; nickname: string; roles: string[]; phoneVerificationStatus: string; phoneMasked?: string }
type Assignment = { id: string; accountId: string; role: string; assignedAt: string }

const label = (account: Listed) => ({
  id: account.id,
  nickname: account.nickname,
  phoneMasked: account.phoneMasked ?? '',
})

/** 照后端的模拟：账号搜索分页、任命列表带称呼。searches 记下网页发出的账号查询条件。 */
function staffBackend(accounts: Listed[], initial: Assignment[]) {
  const state = { assignments: initial, searches: [] as URLSearchParams[] }
  const withLabel = (row: Assignment) => {
    const account = accounts.find((item) => item.id === row.accountId)
    return { ...row, account: account ? label(account) : null }
  }
  const handler: MockHandler = ({ method, path, search, body }) => {
    if (method === 'GET' && path === '/accounts') {
      state.searches.push(new URLSearchParams(search))
      return accountListResult(accounts, search)
    }
    if (method === 'GET' && path === '/staff-role-assignments')
      return { status: 200, body: state.assignments.map(withLabel) }
    if (method === 'POST' && path === '/staff-role-assignments') {
      const input = body as { accountId: string; role: string }
      const created = { id: 'r-new', ...input, assignedAt: '2026-10-04T08:00:00Z' }
      state.assignments = [...state.assignments, created]
      return { status: 201, body: withLabel(created) }
    }
    const revoke = path.match(/^\/staff-role-assignments\/([^/]+)$/)
    if (method === 'DELETE' && revoke) {
      state.assignments = state.assignments.filter((row) => row.id !== revoke[1])
      return { status: 204 }
    }
    return undefined
  }
  return { state, handler }
}

// 「没有匹配」那一行也带 semi-select-option 类名，但没有 option 角色
const options = (page: Page) => page.getByRole('option')

test('老板按关键字找到顾客分配店员、撤销店长', async ({ page }) => {
  // 按注册先后：阿贝最早，小王最新
  const accounts: Listed[] = [
    {
      id: 'u-owner',
      nickname: '阿贝',
      roles: ['owner'],
      phoneVerificationStatus: 'verified',
      phoneMasked: '138****0001',
    },
    { id: 'u-li', nickname: '小李', roles: [], phoneVerificationStatus: 'verified', phoneMasked: '139****0002' },
    { id: 'u-wang', nickname: '小王', roles: ['manager'], phoneVerificationStatus: 'verified' },
  ]
  // 任命列表里还有一位已经注销的账号：服务端称呼为 null，只显示编号
  const backend = staffBackend(accounts, [
    { id: 'r-owner', accountId: 'u-owner', role: 'owner', assignedAt: '2026-10-01T02:00:00Z' },
    { id: 'r-wang', accountId: 'u-wang', role: 'manager', assignedAt: '2026-10-02T02:00:00Z' },
    {
      id: 'r-gone',
      accountId: 'deadbeef-0000-4000-8000-000000000000',
      role: 'clerk',
      assignedAt: '2026-09-01T02:00:00Z',
    },
  ])
  const api = await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/staff')

  await expect(page.getByRole('heading', { name: '员工权限' })).toBeVisible()
  const table = page.locator('.semi-table')
  await expect(table.getByText('阿贝 · 138****0001')).toBeVisible()
  await expect(table.getByText('小王 · u-wang')).toBeVisible()
  await expect(table.getByText('deadbeef', { exact: true })).toBeVisible()
  await expect(table.getByText('本人')).toBeVisible()
  // 下拉没打开时不读账号
  expect(backend.state.searches).toHaveLength(0)

  // 没选账号直接提交：表单拦下
  await page.getByRole('button', { name: '确认分配' }).click()
  await expect(page.getByText('请选择账号')).toBeVisible()
  expect(api.writes).toHaveLength(0)

  // 打开下拉：先列出最新注册的一批（带每页条数，不整表读取）
  await page.locator('.semi-select').first().click()
  await expect(options(page)).toHaveCount(3)
  await expect(options(page).first()).toContainText('小王')
  expect(Object.fromEntries(backend.state.searches.at(-1) ?? [])).toEqual({ page: '1', pageSize: '20' })

  // 输入手机尾号：停手后交给服务端筛
  await page.locator('.semi-select input').fill('0002')
  await expect(options(page)).toHaveCount(1)
  expect(Object.fromEntries(backend.state.searches.at(-1) ?? [])).toEqual({ page: '1', pageSize: '20', q: '0002' })
  await options(page).filter({ hasText: '小李' }).click()
  // 选中后下方显示这个账号的当前角色，说明已写进表单
  await expect(page.getByText('当前角色：普通用户')).toBeVisible()
  await expect(page.locator('.semi-select')).toContainText('小李 · 139****0002')
  await page.getByRole('radio', { name: '店员' }).check()
  await page.getByRole('button', { name: '确认分配' }).click()
  // Semi 弹窗底部按钮的 aria-label 是英文 confirm/cancel，按按钮文字找
  const dialog = page.locator('.semi-modal')
  await expect(dialog.getByText('小李 · 139****0002')).toBeVisible()
  await expect(dialog.getByText('当前：普通用户')).toBeVisible()
  await expect(dialog.getByText('变更为：店员')).toBeVisible()
  await dialog.locator('button', { hasText: '确认分配' }).click()
  await expect(page.getByText('角色已更新')).toBeVisible()
  expect(api.writes).toMatchObject([
    { method: 'POST', path: '/staff-role-assignments', body: { accountId: 'u-li', role: 'clerk' } },
  ])
  // 任命不要求幂等键（后端不收，契约也没有这个参数）：同样的任命再提交一次结果相同
  expect(api.writes[0].idempotencyKey).toBeUndefined()
  // 分配后表单清空，新任命带着服务端的称呼出现在列表里
  await expect(page.getByText('当前角色：')).toHaveCount(0)
  await expect(table.getByRole('row', { name: /小李 · 139\*\*\*\*0002/ })).toContainText('店员')

  // 撤销店长
  const wangRow = table.getByRole('row', { name: /小王/ })
  await wangRow.getByRole('button', { name: '撤销' }).click()
  await expect(page.locator('.semi-modal')).toContainText('小王 · u-wang')
  await page.locator('.semi-modal button', { hasText: '确认撤销' }).click()
  await expect(page.getByText('角色已撤销')).toBeVisible()
  await expect(table.getByText(/小王/)).toHaveCount(0)
})

test('店长看不到老板选项，也不能撤销老板', async ({ page }) => {
  const accounts: Listed[] = [
    { id: 'u-boss', nickname: '老板', roles: ['owner'], phoneVerificationStatus: 'verified' },
    { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    { id: 'u-li', nickname: '小李', roles: [], phoneVerificationStatus: 'verified', phoneMasked: '139****0002' },
  ]
  const backend = staffBackend(accounts, [
    { id: 'r-boss', accountId: 'u-boss', role: 'owner', assignedAt: '2026-10-01T02:00:00Z' },
    { id: 'r-mgr', accountId: 'u-mgr', role: 'manager', assignedAt: '2026-10-01T02:00:00Z' },
  ])
  await mockApi(page, {
    account: { id: 'u-mgr', nickname: '店长', roles: ['manager'], phoneVerificationStatus: 'verified' },
    handlers: [backend.handler],
  })
  await signIn(page, { id: 'u-mgr', nickname: '店长', roles: ['manager'] })
  await page.goto('/staff')
  await expect(page.getByRole('radio', { name: '老板' })).toHaveCount(0)
  await expect(page.locator('.semi-table').getByRole('row', { name: /老板/ })).toBeVisible()
  await expect(
    page.locator('.semi-table').getByRole('row', { name: /老板/ }).getByRole('button', { name: '撤销' }),
  ).toHaveCount(0)

  // 搜索结果里的老板不给选
  await page.locator('.semi-select').first().click()
  await expect(options(page)).toHaveCount(2)
  await expect(options(page).filter({ hasText: '老板' })).toHaveCount(0)
  await page.locator('.semi-select input').fill('老板')
  await expect(page.getByText('没有匹配的账号')).toBeVisible()
})

test('账号多时只列最新注册的 20 个，提示输入关键字找其他人', async ({ page }) => {
  const accounts: Listed[] = Array.from({ length: 25 }, (_, index) => ({
    id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
    nickname: `顾客${index + 1}`,
    roles: [],
    phoneVerificationStatus: 'verified',
    phoneMasked: `139****${String(index + 1).padStart(4, '0')}`,
  }))
  const backend = staffBackend(accounts, [])
  await mockApi(page, { handlers: [backend.handler] })
  await signIn(page, { id: 'u-owner' })
  await page.goto('/staff')

  await page.locator('.semi-select').first().click()
  await expect(options(page)).toHaveCount(20)
  await expect(options(page).first()).toContainText('顾客25')
  await expect(page.getByText('只列出最新注册的 20 个，其他账号请输入关键字查找')).toBeVisible()

  // 最早注册的那位不在第一批里，按编号开头找到
  await page.locator('.semi-select input').fill('00000001')
  await expect(options(page)).toHaveCount(1)
  await expect(options(page)).toContainText('顾客1')
  await expect(page.getByText(/只列出最新注册/)).toHaveCount(0)
})
