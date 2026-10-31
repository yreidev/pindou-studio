import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { load, src } from './helpers/load'
import { nodes } from './helpers/tree'

// 转发给朋友、分享到朋友圈（docs/plan-notify-and-share.md 第 1 节，2026-10-20 业主定）：只开首页、图纸页、
// 图纸详情、预约座位四页，朋友圈不开预约座位；卡片只带打开哪一页，不带转发人的账户、桌码、预约编号。

const brand = await load('brand.ts')
const reservations = await load('services/reservations.ts', {
  './customer': { CustomerError: class extends Error {} },
  './staff': { request: async () => ({}) },
  './format': await load('services/format.ts'),
})
const share = await load('services/share.ts', { '../brand': brand, './reservations': reservations })

test('四个页面的转发卡片：标题、打开的页面；图纸详情用这张图纸的缩略图', () => {
  assert.deepEqual(share.homeShare(), { title: 'EXAMPLE 示例工坊 · 约上朋友来拼豆', path: '/pages/index/index' })
  assert.deepEqual(share.homeTimeline(), { title: 'EXAMPLE 示例工坊 · 约上朋友来拼豆' })
  assert.deepEqual(share.patternsShare('all'), { title: '示例工坊的图纸，挑一张一起拼', path: '/pages/patterns/index' })
  assert.deepEqual(share.patternsShare('c-fruit'), {
    title: '示例工坊的图纸，挑一张一起拼',
    path: '/pages/patterns/index?category=c-fruit',
  })
  assert.equal(share.patternsTimeline('new').query, 'category=new')
  assert.equal(share.patternsTimeline('all').query, '')
  const strawberry = { id: 'p 1', name: '草莓小熊', thumbnailUrl: 'https://shop.test/pattern-images/p1/thumb?v=a' }
  assert.deepEqual(share.patternShare(strawberry), {
    title: '一起拼这张：草莓小熊',
    path: '/pages/customer/pattern/index?id=p%201',
    imageUrl: strawberry.thumbnailUrl,
  })
  assert.deepEqual(share.patternTimeline(strawberry), {
    title: '一起拼这张：草莓小熊',
    query: 'id=p%201',
    imageUrl: strawberry.thumbnailUrl,
  })
})

test('预约座位：选了几点带上这个时段（写绝对日期），没选时带上看的那天', () => {
  // 门店时间 10 月 21 日 15:00
  const start = new Date('2026-10-21T07:00:00Z')
  assert.deepEqual(share.reservationShare(start, '2026-10-21'), {
    title: '10 月 21 日 15:00 还有空位，一起来拼豆',
    path: `/pages/customer/reservations/index?at=${start.getTime() / 1000}`,
  })
  assert.deepEqual(share.reservationShare(null, '2026-10-22'), {
    title: 'EXAMPLE 示例工坊 · 选个座位一起来',
    path: '/pages/customer/reservations/index?date=2026-10-22',
  })
  assert.equal(share.reservationShare(null, '').path, '/pages/customer/reservations/index')
})

/** 全部页面配置（含分包），按页面路径。 */
async function pageConfigs() {
  ;(globalThis as { definePageConfig?: (config: unknown) => unknown }).definePageConfig = (config) => config
  const found: Record<string, Record<string, unknown>> = {}
  const walk = async (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name === 'index.config.ts') {
        const file = path.relative(src, full)
        found[file.replace(/\/index\.config\.ts$/, '')] = (await load(file)).default
      }
    }
  }
  await walk(path.join(src, 'pages'))
  return found
}

test('只有这四页开转发，朋友圈只开首页和图纸两页（员工页、本次手作、订单、我的都不开）', async () => {
  const configs = await pageConfigs()
  const pick = (key: string) =>
    Object.entries(configs)
      .filter(([, config]) => config[key] === true)
      .map(([page]) => page)
      .sort()
  assert.deepEqual(pick('enableShareAppMessage'), [
    'pages/customer/pattern',
    'pages/customer/reservations',
    'pages/index',
    'pages/patterns',
  ])
  assert.deepEqual(pick('enableShareTimeline'), ['pages/customer/pattern', 'pages/index', 'pages/patterns'])
})

test('图纸页转发带着正在看的分类；朋友打开时站在同一个分类，分类没了回到「全部」', async () => {
  const registered: Record<string, () => unknown> = {}
  const library = {
    categories: [{ id: 'c-fruit', name: '水果', enabled: true }],
    patterns: [{ id: 'p1', name: '草莓', categoryId: 'c-fruit', isNew: false, thumbnailPath: '/t' }],
  }
  const open = async (category?: string) => {
    const { default: Patterns } = await load('pages/patterns/index.tsx', {
      react: {
        useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect() {},
      },
      '@tarojs/taro': {
        default: {},
        useRouter: () => ({ params: category ? { category } : {} }),
        useDidShow() {},
        useShareAppMessage: (fn: () => unknown) => (registered.message = fn),
        useShareTimeline: (fn: () => unknown) => (registered.timeline = fn),
      },
      '../../components/button': { Button: 'Button' },
      '../../components/customer': Object.fromEntries(
        ['Failure', 'RefreshNotice', 'Screen', 'SectionEmpty', 'Skeleton'].map((name) => [name, name]),
      ),
      '../../hooks/billing': { useOrdersTabText() {} },
      '../../hooks/query': { usePublicQuery: () => ({ loading: false, data: library, error: null, refresh() {} }) },
      '../../brand': brand,
      '../../services/navigation': { navigateApp: async () => {} },
      './index.scss': {},
    })
    return Patterns()
  }
  const tree = await open('c-fruit')
  assert.ok(
    nodes(tree, (node) => String(node.props.className).includes('patterns-filter-selected')).length === 1,
    '站在「水果」',
  )
  assert.deepEqual(registered.message(), {
    title: '示例工坊的图纸，挑一张一起拼',
    path: '/pages/patterns/index?category=c-fruit',
  })
  assert.equal((registered.timeline() as { query: string }).query, 'category=c-fruit')
  await open('c-gone')
  assert.equal((registered.message() as { path: string }).path, '/pages/patterns/index')
})

test('图纸详情转发这张图纸；下架了退回首页的卡片', async () => {
  const registered: Record<string, () => unknown> = {}
  const open = async (id: string) => {
    const { default: PatternDetail } = await load('pages/customer/pattern/index.tsx', {
      '@tarojs/taro': {
        default: {},
        useRouter: () => ({ params: { id } }),
        useShareAppMessage: (fn: () => unknown) => (registered.message = fn),
        useShareTimeline: (fn: () => unknown) => (registered.timeline = fn),
      },
      '../../../components/button': { Button: 'Button' },
      '../../../components/customer': Object.fromEntries(
        ['Failure', 'RefreshNotice', 'Screen', 'Skeleton', 'Status'].map((name) => [name, name]),
      ),
      '../../../hooks/customer': { useCustomer: () => ({ status: 'anonymous' }) },
      '../../../hooks/query': {
        usePublicQuery: () => ({
          loading: false,
          data: {
            categories: [],
            patterns: [
              {
                id: 'p1',
                name: '草莓小熊',
                categoryId: null,
                isNew: false,
                imagePath: '/full',
                thumbnailPath: '/thumb',
              },
            ],
          },
          error: null,
          refresh() {},
        }),
      },
      '../../../services/navigation': { beginLogin: async () => {}, navigateApp: async () => {} },
      '../../../services/storefront': {
        categoryName: () => '',
        imageUrl: (p: string) => `https://shop.test${p}`,
        storefront: {},
      },
      '../../../services/share': share,
      './index.scss': {},
    })
    return PatternDetail()
  }
  await open('p1')
  assert.deepEqual(registered.message(), {
    title: '一起拼这张：草莓小熊',
    path: '/pages/customer/pattern/index?id=p1',
    imageUrl: 'https://shop.test/thumb',
  })
  assert.equal((registered.timeline() as { imageUrl: string }).imageUrl, 'https://shop.test/thumb')
  await open('gone')
  assert.deepEqual(registered.message(), share.homeShare())
})
