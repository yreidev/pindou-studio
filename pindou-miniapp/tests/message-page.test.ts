import assert from 'node:assert/strict'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { test } from 'vitest'
import { load } from './helpers/load'

async function harness(empty = false) {
  let hide: () => void = () => {},
    unload: () => void = () => {},
    visible = true
  let reads = 0,
    refreshes = 0,
    fail = false
  const navigated: string[] = []
  const item: any = {
    id: 'entry:1',
    kind: 'loyalty',
    at: '2026-10-27T10:00:00Z',
    unread: true,
    entry: {
      id: '1',
      kind: 'consume',
      principalCents: -100,
      giftCents: 0,
      points: [],
      boardUses: 0,
      createdAt: '2026-10-27T10:00:00Z',
      reason: '',
    },
  }
  let feed = { items: empty ? [] : [item], unreadCount: empty ? 0 : 1 }
  const { default: Page } = await load('pages/customer/messages/index.tsx', {
    '@tarojs/taro': {
      useDidHide: (fn) => {
        hide = fn
      },
      useUnload: (fn) => {
        unload = fn
      },
      default: {},
    },
    '../../../components/button': { Button: 'Button' },
    '../../../components/customer': {
      Screen: 'Screen',
      AuthBoundary: 'AuthBoundary',
      Failure: 'Failure',
      RefreshNotice: 'RefreshNotice',
      Skeleton: 'Skeleton',
    },
    '../../../hooks/customer': { useCustomer: () => ({ status: 'authenticated', account: { id: 'a1' } }) },
    '../../../hooks/query': {
      usePageVisible: () => visible,
      useCustomerQuery: (key) => ({ data: key[0] === 'messages' ? feed : null, loading: false, refresh() {} }),
      useRefreshAll: () => async () => {
        refreshes++
        feed = { ...feed, unreadCount: 0, items: feed.items.map((m) => ({ ...m, unread: false })) }
      },
    },
    '../../../services/messages': {
      ...(await load('services/messages.ts')),
      messages: {
        me() {},
        markRead: async () => {
          reads++
          if (fail) throw new Error('网络未连上')
        },
      },
    },
    '../../../services/navigation': {
      navigateApp: async (url) => {
        navigated.push(url)
      },
    },
  })
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Page))
  })
  const update = async () => {
    await act(async () => {
      renderer.update(createElement(Page))
    })
  }
  return {
    renderer,
    reads: () => reads,
    refreshes: () => refreshes,
    navigated,
    update,
    setFailure: (value: boolean) => {
      fail = value
    },
    async leave() {
      await act(async () => {
        hide()
        unload()
      })
      visible = false
      await update()
    },
    async return() {
      visible = true
      await update()
    },
    async click() {
      await act(async () => {
        renderer.root
          .findAll((n) => String(n.type) === 'Button' && n.props.children === '全部标为已读')[0]
          .props.onClick()
      })
      await update()
    },
  }
}
const dots = (h) => h.renderer.root.findAll((n) => n.type === 'View' && n.props.className === 'message-unread').length

test('消息进入不提交已读；手动标记只发一次并清红点，离开不重复，返回不再显示', async () => {
  const h = await harness()
  assert.equal(h.reads(), 0)
  assert.equal(dots(h), 1)
  await h.click()
  assert.equal(h.reads(), 1)
  assert.equal(h.refreshes(), 1)
  assert.equal(dots(h), 0)
  const target = h.renderer.root.findAll((n) => String(n.type) === 'Button' && n.props.className === 'message-row')[0]
  await act(async () => {
    target.props.onClick()
  })
  assert.equal(h.navigated[0], '/pages/customer/consumption-detail/index?id=1')
  await h.leave()
  assert.equal(h.reads(), 1)
  await h.return()
  assert.equal(dots(h), 0)
  await act(async () => h.renderer.unmount())
})

test('不点已读时离开才POST，hide与unload不重复；失败可以重试', async () => {
  const h = await harness()
  assert.equal(h.reads(), 0)
  await h.leave()
  assert.equal(h.reads(), 1)
  const retry = await harness()
  retry.setFailure(true)
  await retry.click()
  assert.equal(retry.refreshes(), 0)
  assert.match(JSON.stringify(retry.renderer.toJSON()), /重试标记已读/)
  retry.setFailure(false)
  await retry.click()
  assert.equal(retry.reads(), 2)
  assert.equal(retry.refreshes(), 1)
  await act(async () => {
    h.renderer.unmount()
    retry.renderer.unmount()
  })
})

test('消息空态按稿件原文，预约按钮可用', async () => {
  const h = await harness(true)
  const text = JSON.stringify(h.renderer.toJSON())
  for (const copy of ['还没有消息', '预约成功或取消、到店充值、消费登记以后，都会在这里留一条。'])
    assert.ok(text.includes(copy), copy)
  await act(async () => {
    h.renderer.root
      .findAll((n) => String(n.type) === 'Button' && n.props.className === 'messages-book')[0]
      .props.onClick()
  })
  assert.equal(h.navigated[0], '/pages/customer/reservations/index')
  await act(async () => h.renderer.unmount())
})
