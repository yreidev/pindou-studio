import { expect, test, type Page } from '@playwright/test'
import { mockApi, signIn, type MockHandler } from './mock-api'

// 首页内容（2026-10-20 起）：所有员工都能发公告、传图纸、管分类。上传前在浏览器里缩图、带幂等键；写接口都回整个图纸库，
// 页面拿它重画。规则本身（名字、上新、排序冲突、图片重新编码）由 Go 测试覆盖，这里走页面上的操作。

type Category = { id: string; name: string; enabled: boolean }
type Pattern = {
  id: string
  name: string
  categoryId: string | null
  published: boolean
  isNew: boolean
  firstPublishedAt: string | null
  width: number
  height: number
  updatedAt: string
  imagePath: string
  thumbnailPath: string
}

// 1×1 的红色 PNG
const redDot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
)

/** 模拟后端：图纸库和公告存在内存里，写接口照真后端回整个图纸库。 */
function storefrontBackend() {
  const now = new Date().toISOString()
  const library = {
    categories: [
      { id: 'c-new', name: '新手', enabled: true },
      { id: 'c-animal', name: '小动物', enabled: true },
      { id: 'c-fruit', name: '水果', enabled: true },
      { id: 'c-flower', name: '花草', enabled: true },
    ] as Category[],
    patterns: [] as Pattern[],
  }
  let announcement: { body: string; expiresOn: string | null; updatedAt: string; expired: boolean } | null = null
  let beads: Record<string, unknown> & { revision: number } = {
    palette: 'mard-221',
    available: null,
    boxes: {},
    boardSize: 52,
    beadSize: 'mini',
    revision: 0,
    updatedAt: null,
  }
  let seq = 0
  const handler: MockHandler = ({ method, path, search, body }) => {
    if (method === 'GET' && path === '/patterns' && search.get('scope') === 'all') return { status: 200, body: library }
    if (method === 'GET' && path.startsWith('/pattern-images/')) return { status: 404, body: { code: 'not_found' } }
    if (method === 'POST' && path === '/patterns') {
      const input = body as { name: string; categoryId: string | null; published: boolean; image: string }
      seq++
      library.patterns.unshift({
        id: `p${seq}`,
        name: input.name,
        categoryId: input.categoryId,
        published: input.published,
        isNew: input.published,
        firstPublishedAt: input.published ? now : null,
        width: 1,
        height: 1,
        updatedAt: now,
        imagePath: `/pattern-images/p${seq}/full?v=a`,
        thumbnailPath: `/pattern-images/p${seq}/thumb?v=a`,
      })
      return { status: 201, body: library }
    }
    const one = path.match(/^\/patterns\/([^/]+)$/)
    if (one && method === 'PATCH') {
      const pattern = library.patterns.find((item) => item.id === one[1])!
      Object.assign(pattern, body)
      if (pattern.published && !pattern.firstPublishedAt) Object.assign(pattern, { firstPublishedAt: now, isNew: true })
      if (!pattern.published) pattern.isNew = false
      return { status: 200, body: library }
    }
    if (one && method === 'DELETE') {
      library.patterns = library.patterns.filter((item) => item.id !== one[1])
      return { status: 200, body: library }
    }
    if (method === 'PATCH' && path === '/pattern-order') {
      const ids = (body as { ids: string[] }).ids
      library.patterns = ids.map((id) => library.patterns.find((item) => item.id === id)!)
      return { status: 200, body: library }
    }
    if (method === 'PATCH' && path === '/pattern-category-order') {
      const ids = (body as { ids: string[] }).ids
      library.categories = ids.map((id) => library.categories.find((item) => item.id === id)!)
      return { status: 200, body: library }
    }
    if (method === 'POST' && path === '/pattern-categories') {
      library.categories.push({ id: `c${++seq}`, name: (body as { name: string }).name, enabled: true })
      return { status: 201, body: library }
    }
    const category = path.match(/^\/pattern-categories\/([^/]+)$/)
    if (category && method === 'DELETE') {
      library.categories = library.categories.filter((item) => item.id !== category[1])
      return { status: 200, body: library }
    }
    if (category && method === 'PATCH') {
      Object.assign(
        library.categories.find((item) => item.id === category[1])!,
        body,
      )
      return { status: 200, body: library }
    }
    if (path === '/bead-settings' && method === 'GET') return { status: 200, body: beads }
    if (path === '/bead-settings' && method === 'PATCH') {
      const { expectedRevision, ...input } = body as { expectedRevision: number } & Record<string, unknown>
      if (expectedRevision !== beads.revision)
        return {
          status: 409,
          body: { code: 'bead_settings_conflict', message: '别人刚改过做图纸用的豆子，请刷新后再改' },
        }
      beads = { ...beads, ...input, revision: beads.revision + 1, updatedAt: now }
      return { status: 200, body: beads }
    }
    if (path === '/storefront/announcement' && method === 'GET') return { status: 200, body: { announcement } }
    if (path === '/storefront/announcement' && method === 'PATCH') {
      const input = body as { body: string; expiresOn: string | null }
      announcement = input.body
        ? { body: input.body, expiresOn: input.expiresOn, updatedAt: now, expired: false }
        : null
      return { status: 200, body: { announcement } }
    }
    return undefined
  }
  return {
    library,
    handler,
    /** 别人在别处保存了一次 */
    otherSave: () => {
      beads = { ...beads, boardSize: 29, revision: beads.revision + 1, updatedAt: now }
    },
  }
}

const asClerk = async (page: Page) => {
  const backend = storefrontBackend()
  const api = await mockApi(page, {
    account: { id: 'u-clerk', nickname: '小林', roles: ['clerk'], phoneVerificationStatus: 'verified' },
    handlers: [backend.handler],
  })
  await signIn(page, { id: 'u-clerk', nickname: '小林', roles: ['clerk'] })
  return { api, backend }
}

const upload = async (page: Page, name: string, category: string | null, publish = true) => {
  await page.getByRole('button', { name: '上传图纸' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '上传图纸' })
  await dialog.getByTestId('pattern-file').setInputFiles({ name: '草莓.png', mimeType: 'image/png', buffer: redDot })
  await expect(dialog.getByRole('img', { name: '图纸预览' })).toBeVisible()
  // 名字默认取文件名
  await expect(dialog.getByLabel('名字')).toHaveValue('草莓')
  await dialog.getByLabel('名字').fill(name)
  if (category) {
    await dialog.getByRole('combobox', { name: '分类' }).click()
    await page.getByRole('option', { name: category }).click()
    await expect(dialog.getByRole('combobox', { name: '分类' })).toContainText(category)
  }
  if (!publish) await dialog.getByRole('switch', { name: '立即上架' }).click()
  await dialog.getByRole('button', { name: '上传', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('店员传图纸：浏览器里缩好图带幂等键上传，上下架、排顺序、删除', async ({ page }) => {
  const { api } = await asClerk(page)
  await page.goto('/')
  await page.locator('.admin-nav').getByText('首页内容').click()
  await expect(page.getByRole('heading', { name: '首页内容' })).toBeVisible()
  await expect(page.getByText('还没有图纸，点右上角「上传图纸」传第一张。')).toBeVisible()
  await expect(page.getByText('由老板在系统设置里填。')).toBeVisible()

  await upload(page, '草莓小熊', '水果')
  await expect(page.getByText('图纸已上传并上架')).toBeVisible()
  const first = api.writes.find((write) => write.path === '/patterns')!
  expect(first.idempotencyKey).toBeTruthy()
  expect(first.body).toMatchObject({ name: '草莓小熊', categoryId: 'c-fruit', published: true })
  expect((first.body as { image: string }).image).toMatch(/^data:image\/png;base64,/)
  const row = page.locator('.semi-table-row', { hasText: '草莓小熊' })
  await expect(row).toContainText('水果')
  await expect(row).toContainText('上架中')
  await expect(row).toContainText('上新 · 还剩 7 天')

  await upload(page, '郁金香', null, false)
  await expect(page.getByText('图纸已上传，还没上架')).toBeVisible()
  const tulip = page.locator('.semi-table-row', { hasText: '郁金香' })
  await expect(tulip).toContainText('不分类')
  await expect(tulip).toContainText('未上架')

  // 新传的在最前面；下移郁金香
  await expect(page.locator('.semi-table-tbody .semi-table-row').first()).toContainText('郁金香')
  await page.getByRole('button', { name: '郁金香 下移' }).click()
  await expect(page.locator('.semi-table-tbody .semi-table-row').first()).toContainText('草莓小熊')
  expect(api.writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/pattern-order', body: { ids: ['p1', 'p2'] } })

  await tulip.getByRole('button', { name: '上架' }).click()
  await expect(tulip).toContainText('上架中')
  expect(api.writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/patterns/p2', body: { published: true } })

  // 改名字和分类：只发改了的字段
  await tulip.getByRole('button', { name: '修改' }).click()
  const edit = page.locator('.semi-modal', { hasText: '修改图纸「郁金香」' })
  await expect(edit.getByRole('button', { name: '保存修改' })).toBeDisabled()
  await edit.getByLabel('名字').fill('红色郁金香')
  await edit.getByRole('combobox', { name: '分类' }).click()
  await page.getByRole('option', { name: '花草' }).click()
  await expect(edit.getByRole('combobox', { name: '分类' })).toContainText('花草')
  await edit.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByText('图纸已修改')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({
    method: 'PATCH',
    path: '/patterns/p2',
    body: { name: '红色郁金香', categoryId: 'c-flower' },
  })

  const strawberry = page.locator('.semi-table-row', { hasText: '草莓小熊' })
  await strawberry.getByRole('button', { name: '删除' }).click()
  await page.locator('.semi-modal button', { hasText: '删除图纸' }).click()
  await expect(page.getByText('图纸已删除')).toBeVisible()
  await expect(strawberry).toHaveCount(0)
  expect(api.writes.at(-1)).toMatchObject({ method: 'DELETE', path: '/patterns/p1' })
})

test('选的文件不对：不是 JPG、PNG 或超过 5 MB 时说明原因，不能上传', async ({ page }) => {
  await asClerk(page)
  await page.goto('/storefront')
  await page.getByRole('button', { name: '上传图纸' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '上传图纸' })
  await dialog
    .getByTestId('pattern-file')
    .setInputFiles({ name: '动图.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
  await expect(dialog.getByText('只能上传 JPG 或 PNG 图片')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '上传', exact: true })).toBeDisabled()
})

test('店员发公告：保存后显示状态，清除前确认', async ({ page }) => {
  const { api } = await asClerk(page)
  await page.goto('/storefront')
  const card = page.locator('.semi-card', { hasText: '首页公告' })
  await expect(card.getByText('没有公告')).toBeVisible()
  await expect(card.getByRole('button', { name: '保存公告' })).toBeDisabled()

  await card.getByLabel('公告文字').fill('10 月 22 日店休一天\n23 日照常营业')
  await card.getByRole('button', { name: '保存公告' }).click()
  await expect(page.getByText('公告已保存，顾客打开首页就能看到')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({
    method: 'PATCH',
    path: '/storefront/announcement',
    body: { body: '10 月 22 日店休一天\n23 日照常营业', expiresOn: null },
  })
  await expect(card.getByText('首页显示中，不过期')).toBeVisible()

  await card.getByRole('button', { name: '清除公告' }).click()
  await page.locator('.semi-modal button', { hasText: '清除公告' }).click()
  await expect(page.getByText('公告已清除')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({ body: { body: '', expiresOn: null } })
  await expect(card.getByText('没有公告')).toBeVisible()
  await expect(card.getByLabel('公告文字')).toHaveValue('')
})

test('店员管分类：加、重名当场提示、改名、停用、排顺序、删空分类', async ({ page }) => {
  const { api } = await asClerk(page)
  await page.goto('/storefront')
  const card = page.locator('.semi-card', { hasText: '图纸分类' })

  await card.getByRole('button', { name: '添加分类' }).click()
  const dialog = page.locator('.semi-modal', { hasText: '添加图纸分类' })
  await dialog.getByLabel('分类名字').fill('水果')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(dialog.getByText('已经有叫「水果」的分类了')).toBeVisible()
  await dialog.getByLabel('分类名字').fill('节日')
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByText('分类已添加')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({ method: 'POST', path: '/pattern-categories', body: { name: '节日' } })
  await expect(card.locator('.semi-table-tbody .semi-table-row').last()).toContainText('节日')

  const fruit = card.locator('.semi-table-row', { hasText: '水果' })
  await fruit.getByRole('button', { name: '改名' }).click()
  const rename = page.locator('.semi-modal', { hasText: '给分类「水果」改名' })
  await rename.getByLabel('分类名字').fill('水果蔬菜')
  await rename.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('分类已改名')).toBeVisible()

  const flower = card.locator('.semi-table-row', { hasText: '花草' })
  await flower.getByRole('button', { name: '停用' }).click()
  await expect(flower).toContainText('已停用')
  expect(api.writes.at(-1)).toMatchObject({ path: '/pattern-categories/c-flower', body: { enabled: false } })

  await card.getByRole('button', { name: '新手 下移' }).click()
  await expect(card.locator('.semi-table-tbody .semi-table-row').first()).toContainText('小动物')
  expect(api.writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/pattern-category-order' })

  // 只有没图纸的分类给「删除」：先往「小动物」传一张下架的，它就不能删
  await upload(page, '小猫', '小动物', false)
  const animal = card.locator('.semi-table-row', { hasText: '小动物' })
  await expect(animal).toContainText('1 张')
  await expect(animal.getByRole('button', { name: '删除' })).toHaveCount(0)
  const festival = card.locator('.semi-table-row', { hasText: '节日' })
  await festival.getByRole('button', { name: '删除' }).click()
  const confirm = page.locator('.semi-modal', { hasText: '删除分类「节日」？' })
  await expect(confirm).toContainText('删了这个名字就能再用')
  await confirm.getByRole('button', { name: '删除分类' }).click()
  await expect(page.getByText('分类已删除')).toBeVisible()
  expect(api.writes.at(-1)).toMatchObject({ method: 'DELETE', path: '/pattern-categories/c1' })
  await expect(card.locator('.semi-table-row', { hasText: '节日' })).toHaveCount(0)
})

test('店员改做图纸用的豆子：去掉颜色、填盒号、换豆子大小，别人先保存了时不覆盖', async ({ page }) => {
  const { api, backend } = await asClerk(page)
  await page.goto('/storefront')
  const card = page.locator('.semi-card', { hasText: '做图纸用的豆子' })
  await expect(card.getByText('店里有 221 / 221 种，填了 0 个盒号')).toBeVisible()
  await expect(card.getByRole('button', { name: '保存' })).toBeDisabled()
  // Semi 的复选框由外层盖住 input，点外层（同 table-codes.spec.ts）
  const toggle = (name: string) => card.locator('.semi-checkbox', { has: page.getByRole('checkbox', { name }) }).click()

  await toggle('A1 店里有')
  await expect(card.getByRole('checkbox', { name: 'A1 店里有' })).not.toBeChecked()
  await card.getByRole('button', { name: '这一系列都没有' }).click()
  await card.getByRole('button', { name: '这一系列都有' }).click()
  await toggle('A1 店里有')
  await card.getByLabel('A2 盒号').fill(' 3 ')
  await card.getByText('5 毫米（大豆）').click()
  await expect(card.getByText('店里有 220 / 221 种，填了 1 个盒号')).toBeVisible()
  await card.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('已保存，顾客下次打开「做图纸」就用新的')).toBeVisible()
  const saved = api.writes.at(-1)!
  expect(saved).toMatchObject({
    method: 'PATCH',
    path: '/bead-settings',
    body: { expectedRevision: 0, palette: 'mard-221', boxes: { A2: '3' }, boardSize: 52, beadSize: 'midi' },
  })
  const available = (saved.body as { available: string[] }).available
  expect(available).toHaveLength(220)
  expect(available.includes('A1')).toBe(false)
  await expect(card.getByRole('button', { name: '保存' })).toBeDisabled()

  // 别人先保存了：这边改了一半时保存不了，提示看最新的
  backend.otherSave()
  await card.getByLabel('A3 盒号').fill('4')
  await card.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('别人刚改过，先看看最新的再改')).toBeVisible()
  await expect(card.getByText('别人刚改过做图纸用的豆子，这边的修改保存不了。')).toBeVisible()
  await card.getByRole('button', { name: '放弃这边的修改，看最新的' }).click()
  await expect(card.getByLabel('底板')).toHaveValue('29')
  await expect(card.getByLabel('A3 盒号')).toHaveValue('')

  // 换色卡：店里有没有、盒号从头来
  await card.getByRole('combobox', { name: '色卡' }).click()
  await page.getByRole('option', { name: 'Hama 中号 92 色' }).click()
  await expect(card.getByText('店里有 92 / 92 种，填了 0 个盒号')).toBeVisible()
  await card.getByRole('button', { name: '撤销修改' }).click()
  await expect(card.getByText('店里有 220 / 221 种，填了 1 个盒号')).toBeVisible()
})
