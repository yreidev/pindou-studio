import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from './helpers/load'

async function switchingHarness() {
  let snapshot: any = { revision: 1, account: { id: 'test', developerMode: 'developer' } }
  const calls: any[] = [],
    settings = { dirty: false, busy: false, confirm: false, index: 4 }
  const taro = {
    getCurrentPages: () => [{ route: 'pages/staff/checkout/index' }],
    showActionSheet: async (options) => {
      calls.push(['menu', options.itemList])
      return { tapIndex: settings.index }
    },
    showModal: async () => ({ confirm: settings.confirm }),
    showLoading: async () => {
      calls.push(['loading'])
    },
    hideLoading: () => {
      calls.push(['hide'])
    },
    showToast: (options) => {
      calls.push(['toast', options.title])
    },
    reLaunch: async (options) => {
      calls.push(['navigate', options.url])
    },
  }
  const navigation = await load('services/navigation.ts', { '@tarojs/taro': { default: taro } })
  navigation.registerLeaveGuard('/pages/staff/checkout/index', () => settings)
  const customer = {
    getSnapshot: () => snapshot,
    switchDeveloperMode: async (role) => {
      calls.push(['switch', role])
      snapshot = { ...snapshot, revision: snapshot.revision + 1, account: { ...snapshot.account, developerMode: role } }
    },
  }
  const api = await load('services/developer-switch.ts', {
    '@tarojs/taro': { default: taro },
    './navigation': navigation,
    './platform': { customer },
    './customer': { errorMessage: (error) => error.message },
  })
  return {
    api,
    settings,
    calls,
    taro,
    customer,
    setSnapshot: (value) => {
      snapshot = value
    },
  }
}

test('floating menu offers only the five experience roles and switches directly to the selected workbench', async () => {
  const h = await switchingHarness()
  await h.api.switchExperienceRole()
  assert.deepEqual(Array.from(h.calls[0][1]), ['游客', '顾客', '店员', '店长', '老板'])
  assert.deepEqual(h.calls.slice(1), [
    ['loading'],
    ['switch', 'owner'],
    ['navigate', '/pages/staff/workbench/index'],
    ['hide'],
  ])
  h.calls.length = 0
  await h.api.switchExperienceRole('owner')
  await h.api.switchExperienceRole('developer')
  assert.deepEqual(h.calls, [])
})

test('role switching respects unsaved changes and active submission, then can switch back from guest', async () => {
  const h = await switchingHarness()
  h.settings.dirty = true
  await h.api.switchExperienceRole('guest')
  assert.equal(h.calls.length, 0)
  h.settings.confirm = true
  h.settings.busy = true
  await h.api.switchExperienceRole('guest')
  assert.equal(
    h.calls.some((call) => call[0] === 'switch'),
    false,
  )
  h.settings.busy = false
  await h.api.switchExperienceRole('guest')
  assert.ok(h.calls.some((call) => call[1] === '/pages/index/index'))
  await h.api.switchExperienceRole('customer')
  assert.ok(h.calls.some((call) => call[1] === '/pages/profile/index'))
})

test('an open menu cannot switch after logout and duplicate taps cannot open a second menu', async () => {
  const h = await switchingHarness()
  let choose,
    count = 0
  h.taro.showActionSheet = () => {
    count++
    return new Promise((resolve) => {
      choose = resolve
    })
  }
  const pending = h.api.switchExperienceRole()
  await h.api.switchExperienceRole()
  assert.equal(count, 1)
  h.setSnapshot({ revision: 2, account: null })
  choose({ tapIndex: 4 })
  await pending
  assert.deepEqual(h.calls, [])
  await h.api.switchExperienceRole('owner')
  assert.deepEqual(h.calls, [])
})

test('failed switching leaves the page in place, releases its mask, and allows retry', async () => {
  const h = await switchingHarness()
  const success = h.customer.switchDeveloperMode
  h.customer.switchDeveloperMode = async () => {
    throw new Error('切换失败')
  }
  await h.api.switchExperienceRole('clerk')
  assert.deepEqual(h.calls, [['loading'], ['hide'], ['toast', '切换失败']])
  h.customer.switchDeveloperMode = success
  await h.api.switchExperienceRole('clerk')
  assert.ok(h.calls.some((call) => call[0] === 'navigate'))
})

function hooks() {
  const slots: any[] = [],
    cleanups: any[] = []
  let cursor = 0
  const api = {
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (value) => {
          slots[i] = value
        },
      ]
    },
    useRef(initial) {
      return api.useState(() => ({ current: initial }))[0]
    },
    useEffect(effect) {
      const i = cursor++
      if (!(i in slots)) {
        slots[i] = true
        cleanups.push(effect())
      }
    },
  }
  return {
    api,
    render(fn) {
      cursor = 0
      return fn()
    },
    unmount() {
      cleanups.forEach((fn) => fn?.())
    },
  }
}

test('developer control supports dragging without switching, remembers its location, and stays within resized bounds', async () => {
  const h = hooks(),
    listeners = new Set<() => void>()
  let shown,
    taps = 0,
    mode: string | null = 'guest'
  let info: any = {
    windowWidth: 390,
    windowHeight: 844,
    screenHeight: 844,
    statusBarHeight: 47,
    safeArea: { bottom: 810 },
  }
  const { DeveloperStatus } = await load('components/developer-status.tsx', {
    react: h.api,
    '@tarojs/components': { Image: 'Image', Text: 'Text', MovableArea: 'MovableArea', MovableView: 'MovableView' },
    '@tarojs/taro': {
      default: {
        getWindowInfo: () => info,
        onWindowResize: (fn) => listeners.add(fn),
        offWindowResize: (fn) => listeners.delete(fn),
      },
      useDidShow: (fn) => {
        shown = fn
      },
    },
    './button': { Button: 'Button' },
    '../hooks/customer': { useCustomer: () => ({ account: mode ? { developerMode: mode } : null }) },
    '../services/developer-switch': {
      developerModeNames: { guest: '游客' },
      switchExperienceRole: () => {
        taps++
      },
    },
  })
  let tree = h.render(DeveloperStatus)
  let movable = tree.props.children,
    button = movable.props.children
  assert.equal(tree.props.style.top, '119px')
  assert.equal(tree.props.style.height, '611px')
  assert.match(button.props.ariaLabel, /游客/)
  button.props.onTouchStart({ touches: [{ clientX: 330, clientY: 450 }] })
  button.props.onTouchMove({ touches: [{ clientX: 210, clientY: 350 }] })
  movable.props.onChange({ detail: { source: 'touch', x: 100, y: 200 } })
  button.props.onClick()
  assert.equal(taps, 0)
  shown()
  tree = h.render(DeveloperStatus)
  movable = tree.props.children
  button = movable.props.children
  assert.equal(movable.props.x, 100)
  assert.equal(movable.props.y, 200)
  button.props.onTouchStart({ touches: [{ clientX: 100, clientY: 200 }] })
  button.props.onClick()
  assert.equal(taps, 1)
  button.props.onTouchCancel()
  button.props.onClick()
  assert.equal(taps, 1)
  info = { ...info, windowWidth: 320, windowHeight: 360 }
  listeners.forEach((fn) => fn())
  tree = h.render(DeveloperStatus)
  movable = tree.props.children
  assert.ok(movable.props.x >= 0 && movable.props.x + 56 <= 296)
  assert.ok(movable.props.y >= 0 && movable.props.y + 56 <= 127)
  mode = null
  assert.equal(h.render(DeveloperStatus), null)
  h.unmount()
  assert.equal(listeners.size, 0)
})
