import Taro from '@tarojs/taro'

const home = '/pages/index/index'
const tabs = [home, '/pages/patterns/index', '/pages/orders/index', '/pages/profile/index']
const allowed = new Map<string, string[]>([
  ['/pages/developer/index', []],
  ['/pages/customer/membership/index', []],
  ['/pages/customer/messages/index', []],
  ['/pages/customer/consumption-detail/index', ['id']],
  ['/pages/customer/member-claim/index', ['phone']],
  ['/pages/customer/experience/index', ['tableId', 'scene']],
  ['/pages/staff/membership/index', ['orderId']],
  ...['index', 'patterns', 'orders', 'profile'].map((page) => [`/pages/${page}/index`, []] as [string, string[]]),
  ...['profile-edit', 'my-reservations'].map((page) => [`/pages/customer/${page}/index`, []] as [string, string[]]),
  // at：首页「今天还能约」点的那个整点（Unix 秒），预约页先只亮这个时间还有空的座位
  ['/pages/customer/reservations/index', ['at']],
  ['/pages/customer/order-detail/index', ['id']],
  ['/pages/customer/pattern/index', ['id']],
  // 做图纸（docs/plan-bead-maker.md，只在小程序里）：id 是图纸编号，tab=bead 直接打开「边拼边看」
  ...['mine', 'import'].map((page) => [`/pages/maker/${page}/index`, []] as [string, string[]]),
  // pick=1：从底部「图纸」进来，到了照片页再选照片
  ['/pages/maker/photo/index', ['pick']],
  ['/pages/maker/pattern/index', ['id', 'tab']],
  ...['workbench', 'reservations', 'booking', 'orders', 'receiving'].map(
    (page) => [`/pages/staff/${page}/index`, []] as [string, string[]],
  ),
  // tableId：从别处点「看这张桌」进来，桌位页直接弹出这张桌的会话
  ['/pages/staff/tables/index', ['tableId']],
  ['/pages/staff/checkout/index', ['id']],
  // scene：网页后台登录码（小程序码）用微信扫一扫打开时带的挑战编号；没登录时要先登录、再带着它回来
  ['/pages/staff/web-login/index', ['id', 'scene']],
])
let loginTarget: string | undefined
let completingLogin = false
const guards = new Map<string, () => { dirty: boolean; busy: boolean }>()

export function sanitizeTarget(value: string): string {
  const [path, query = ''] = value.split('?')
  const keys = allowed.get(path)
  if (!keys || value.includes('#')) return home
  try {
    const params = query
      .split('&')
      .filter(Boolean)
      .map((part) => {
        const split = part.indexOf('=')
        return [
          decodeURIComponent(split < 0 ? part : part.slice(0, split)),
          decodeURIComponent(split < 0 ? '' : part.slice(split + 1)),
        ]
      })
      .filter(
        ([key, value]) =>
          keys.includes(key) &&
          value.length <= 128 &&
          (path === '/pages/customer/member-claim/index' && key === 'phone'
            ? /^\+?\d{6,15}$/.test(value)
            : /^[a-zA-Z0-9_-]+$/.test(value)),
      )
    const unique = [...new Map(params as [string, string][])]
    return (
      path +
      (unique.length
        ? '?' + unique.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
        : '')
    )
  } catch {
    return home
  }
}

/** 登录完要回去的地方（登录页上写「登录后接着……」用）；直接打开登录页的为 undefined。 */
export const pendingLoginTarget = () => loginTarget

export function clearLoginTarget() {
  loginTarget = undefined
}
export async function beginLogin(target = home) {
  loginTarget = sanitizeTarget(target)
  try {
    await Taro.navigateTo({ url: '/pages/register/index' })
  } catch {
    clearLoginTarget()
    void Taro.showToast({ title: '暂时无法打开登录页，请重试', icon: 'none' })
  }
}

export async function completeLogin() {
  if (completingLogin) return
  completingLogin = true
  const target = loginTarget || home
  clearLoginTarget()
  try {
    await navigateApp(target, true)
  } finally {
    completingLogin = false
  }
}

export function registerLeaveGuard(route: string, read: () => { dirty: boolean; busy: boolean }) {
  guards.set(route, read)
  return () => {
    if (guards.get(route) === read) guards.delete(route)
  }
}
export async function confirmLeave() {
  const pages = Taro.getCurrentPages()
  const route = '/' + (pages[pages.length - 1]?.route || '').replace(/^\//, '')
  const state = guards.get(route)?.()
  if (state?.busy) {
    void Taro.showToast({ title: '正在提交，请稍候', icon: 'none' })
    return false
  }
  if (!state?.dirty) return true
  try {
    return (
      await Taro.showModal({
        title: '放弃未保存的修改？',
        content: '离开后，本次未保存的内容将丢失。',
        confirmText: '放弃修改',
        cancelText: '继续编辑',
      })
    ).confirm
  } catch {
    return false
  }
}
export async function navigateApp(url: string, replace = false) {
  if (!replace && !(await confirmLeave())) return false
  const target = sanitizeTarget(url)
  try {
    if (tabs.includes(target)) await Taro.switchTab({ url: target })
    else if (replace) await Taro.redirectTo({ url: target })
    else await Taro.navigateTo({ url: target })
    return true
  } catch {
    void Taro.showToast({ title: '暂时无法打开页面，请重试', icon: 'none' })
    return false
  }
}

export async function openHome() {
  try {
    await Taro.switchTab({ url: '/pages/index/index' })
  } catch {
    void Taro.showToast({ title: '暂时无法打开首页，请点击首页重试', icon: 'none' })
  }
}

export function fallbackPage(route: string): string {
  const path = route.replace(/^\//, '').split('?')[0]
  if (path === 'pages/customer/messages/index') return '/pages/profile/index'
  if (path === 'pages/customer/consumption-detail/index') return '/pages/customer/membership/index'
  if (path === 'pages/customer/member-claim/index') return '/pages/register/index'
  if (path === 'pages/customer/membership/index') return '/pages/profile/index'
  if (path === 'pages/customer/my-reservations/index') return '/pages/profile/index'
  if (path === 'pages/customer/pattern/index') return '/pages/patterns/index'
  // 一张图纸、导入像素画退到「我的图纸」，「我的图纸」和照片做图纸退到底部「图纸」
  if (path === 'pages/maker/pattern/index' || path === 'pages/maker/import/index') return '/pages/maker/mine/index'
  if (path.startsWith('pages/maker/')) return '/pages/patterns/index'
  if (path === 'pages/customer/profile-edit/index' || path === 'pages/staff/workbench/index')
    return '/pages/profile/index'
  if (path === 'pages/staff/booking/index') return '/pages/staff/reservations/index'
  if (path === 'pages/staff/checkout/index') return '/pages/staff/orders/index'
  // 其余员工页（桌位、预约、会员、连电脑、收货入库……）回现场
  if (path.startsWith('pages/staff/')) return '/pages/staff/workbench/index'
  return '/pages/index/index'
}

export async function returnToPreviousPage(force = false) {
  if (!force && !(await confirmLeave())) return
  const pages = Taro.getCurrentPages()
  const target = fallbackPage(pages[pages.length - 1]?.route || '')
  if (pages.length > 1) {
    try {
      await Taro.navigateBack()
      return
    } catch {
      /* 原生页面栈不能返回时，使用这一页的上级入口。 */
    }
  }
  try {
    if (target.startsWith('/pages/staff/') || target === '/pages/register/index') await Taro.redirectTo({ url: target })
    else await Taro.switchTab({ url: target })
  } catch {
    void Taro.showToast({ title: '暂时无法返回，请重试', icon: 'none' })
  }
}
