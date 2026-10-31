import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'
import { label, nodes } from './helpers/tree'

// 店里一张上架的图纸都没有时（2026-10-28 业主定，docs/plan-home-and-patterns.md）：底部第二格和这一页叫「做图纸」，
// 只放做图纸的两个入口，不摆空的「店里的图纸」（0.0.37 提审因【图纸】页「无具体运营内容」被驳回）；
// 上架第一张后变回「图纸」。

const strawberry = { id: 'p1', name: '草莓', categoryId: 'c-fruit', isNew: false, thumbnailPath: '/t' }
const library = (patterns: unknown[]) => ({ categories: [{ id: 'c-fruit', name: '水果', enabled: true }], patterns })

type Query = { loading?: boolean; data?: unknown; error?: unknown }

async function patternsPage(query: Query, params: Record<string, string> = {}) {
  const tabs: unknown[] = []
  const shared: Record<string, () => any> = {}
  const { default: Patterns } = await load('pages/patterns/index.tsx', {
    react: {
      useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: (effect: () => void) => effect(),
    },
    '@tarojs/taro': {
      default: { setTabBarItem: async (item: unknown) => tabs.push(item) },
      useRouter: () => ({ params }),
      useDidShow() {},
      useShareAppMessage: (fn: () => unknown) => (shared.message = fn),
      useShareTimeline: (fn: () => unknown) => (shared.timeline = fn),
    },
    '../../components/button': { Button: 'Button' },
    '../../components/customer': Object.fromEntries(
      ['Failure', 'RefreshNotice', 'Screen', 'SectionEmpty', 'Skeleton'].map((name) => [name, name]),
    ),
    '../../hooks/billing': { useOrdersTabText() {} },
    '../../hooks/query': {
      usePublicQuery: () => ({ loading: false, data: null, error: null, refresh() {}, ...query }),
    },
    '../../services/navigation': { navigateApp: async () => {} },
    './index.scss': {},
  })
  const tree = Patterns()
  const count = (type: string) => nodes(tree, (node) => node.type === type).length
  const has = (className: string) => nodes(tree, (node) => String(node.props?.className).includes(className)).length
  return {
    title: nodes(tree, (node) => node.type === 'Screen')[0].props.title,
    maker: nodes(tree, (node) => typeof node.type === 'function' && node.type.name === 'MakerEntries').length,
    intro: has('patterns-intro'),
    cards: has('patterns-card'),
    count,
    tree,
    tabs,
    shared,
  }
}

test('没有上架的图纸：这一页和底部那格叫「做图纸」，只放做图纸的入口，转发按做图纸说', async () => {
  const page = await patternsPage({ data: library([]) }, { category: 'c-fruit' })
  assert.equal(page.title, '做图纸')
  assert.equal(page.maker, 1)
  assert.equal(page.intro, 0, '不摆「今天来示例工坊拼什么？」')
  assert.equal(page.count('SectionEmpty'), 0, '不说「图纸还在准备中」')
  assert.doesNotMatch(label(page.tree), /图纸还在准备中|店里挑的图纸/)
  assert.deepEqual(page.tabs, [{ index: 1, text: '做图纸' }])
  assert.deepEqual(page.shared.message(), { title: '在示例工坊把照片做成拼豆图纸', path: '/pages/patterns/index' })
  assert.equal(page.shared.timeline().query, '')
})

test('上架了图纸：叫「图纸」，做图纸入口下面是店里的图纸', async () => {
  const page = await patternsPage({ data: library([strawberry]) })
  assert.equal(page.title, '图纸')
  assert.equal(page.maker, 1)
  assert.equal(page.intro, 1)
  assert.equal(page.cards, 1)
  assert.deepEqual(page.tabs, [{ index: 1, text: '图纸' }])
  assert.equal(page.shared.message().title, '示例工坊的图纸，挑一张一起拼')
})

test('还没读到图纸库：先按「做图纸」，不放骨架、不改底栏；读不到只给重试', async () => {
  const loading = await patternsPage({ loading: true })
  assert.equal(loading.title, '做图纸')
  assert.equal(loading.count('Skeleton') + loading.count('Failure') + loading.intro, 0)
  assert.deepEqual(loading.tabs, [])
  const failed = await patternsPage({ error: new Error('图纸暂时无法加载') })
  assert.equal(failed.count('Failure'), 1)
  assert.equal(failed.intro, 0)
  assert.deepEqual(failed.tabs, [])
})

test('图纸详情：这张下架了、店里也一张都没有时，带去做图纸', async () => {
  const status = async (patterns: unknown[]) => {
    const { default: PatternDetail } = await load('pages/customer/pattern/index.tsx', {
      '@tarojs/taro': {
        default: {},
        useRouter: () => ({ params: { id: 'gone' } }),
        useShareAppMessage() {},
        useShareTimeline() {},
      },
      '../../../components/button': { Button: 'Button' },
      '../../../components/customer': Object.fromEntries(
        ['Failure', 'RefreshNotice', 'Screen', 'Skeleton', 'Status'].map((name) => [name, name]),
      ),
      '../../../hooks/customer': { useCustomer: () => ({ status: 'anonymous' }) },
      '../../../hooks/query': {
        usePublicQuery: () => ({ loading: false, data: library(patterns), error: null, refresh() {} }),
      },
      '../../../services/navigation': { beginLogin: async () => {}, navigateApp: async () => {} },
      './index.scss': {},
    })
    const { message, action } = nodes(PatternDetail(), (node) => node.type === 'Status')[0].props
    return { message, action }
  }
  assert.deepEqual(await status([]), {
    message: '店里的图纸暂时都下架了，可以先用照片自己做一张。',
    action: '去做图纸',
  })
  assert.deepEqual(await status([strawberry]), { message: '去「图纸」看看别的吧。', action: '看全部图纸' })
})
