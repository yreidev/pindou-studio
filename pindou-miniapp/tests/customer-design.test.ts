import assert from 'node:assert/strict'
import path from 'node:path'
import { compile } from 'sass'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { test, vi } from 'vitest'
import { load, src } from './helpers/load'

test('吸顶偏移包含状态栏和44像素导航栏，随窗口变化更新', async () => {
  let renderer: ReactTestRenderer | undefined
  let statusHeight = 47
  let resize = () => {}
  const offResize = vi.fn()
  try {
    const { Screen } = await load('components/customer/index.tsx', {
      '@tarojs/taro': {
        default: {
          getWindowInfo: () => ({ statusBarHeight: statusHeight }),
          getMenuButtonBoundingClientRect: () => ({ top: statusHeight + 7, height: 32 }),
          onWindowResize: (callback) => {
            resize = callback
          },
          offWindowResize: offResize,
          setNavigationBarColor: async () => {},
        },
      },
      './message-badge': { MessageBadge: 'MessageBadge' },
      '../developer-status': { DeveloperStatus: 'DeveloperStatus' },
    })
    await act(async () => {
      renderer = create(createElement(Screen, { className: 'membership-screen', navigationHeight: 44 }))
    })
    const screen = () => renderer!.root.findAll((n) => n.props.className === 'screen  membership-screen')[0]
    assert.equal(screen().props.style['--customer-navigation-height'], '91px')
    await act(async () => {
      statusHeight = 20
      resize()
    })
    assert.equal(screen().props.style['--customer-navigation-height'], '64px')
  } finally {
    await act(async () => renderer?.unmount())
    assert.equal(offResize.mock.calls.length, 1)
  }
})

test('顾客稿件样式可独立编译：逻辑像素、字号和圆角保持390稿件数值，图标颜色来自tokens', () => {
  const files = [
    'pages/profile/index.scss',
    'pages/register/index.scss',
    'pages/customer/membership/index.scss',
    'pages/customer/member-claim/index.scss',
    'pages/customer/messages/index.scss',
    'pages/customer/consumption-detail/index.scss',
    'components/customer/design-icon.scss',
    'components/customer/ledger-icon.scss',
    'components/customer/bead-heart.scss',
  ]
  const css = Object.fromEntries(files.map((file) => [file, compile(path.join(src, file)).css]))
  assert.match(css['pages/customer/consumption-detail/index.scss'], /font-size: 36PX;/)
  assert.match(css['pages/customer/consumption-detail/index.scss'], /padding: 22PX 18PX 18PX;/)
  assert.match(css['pages/customer/membership/index.scss'], /font-size: 32PX;/)
  assert.match(css['pages/customer/membership/index.scss'], /border-radius: 18PX;/)
  const tabs = css['pages/customer/membership/index.scss'].match(/\.loyalty-tabs \{([^}]+)\}/)?.[1] || ''
  assert.match(tabs, /position: sticky;/)
  assert.match(tabs, /top: var\(--customer-navigation-height\);/)
  assert.match(tabs, /background: #f7f5f0;/)
  assert.doesNotMatch(css['pages/customer/membership/index.scss'], /membership-history-screen/)
  assert.match(css['pages/customer/messages/index.scss'], /padding: 14PX 14PX 14PX 16PX;/)
  assert.match(css['components/customer/bead-heart.scss'], /width: 146PX;/)
  assert.match(css['components/customer/design-icon.scss'], /%23806539/)
  assert.match(css['components/customer/design-icon.scss'], /%23286b50/)
  assert.doesNotMatch(css['components/customer/design-icon.scss'], /TOKEN|#\{/)
})
