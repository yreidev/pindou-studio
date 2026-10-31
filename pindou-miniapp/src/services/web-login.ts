import Taro from '@tarojs/taro'
import type { components, operations } from '../api/schema'
import { navigateApp } from './navigation'
import { request } from './staff'

// 电脑网页后台（admin.example.invalid）的扫码登录：电脑上显示二维码，员工用小程序扫，
// 在这里看清是哪台电脑后批准，电脑随即进入后台。批准与否都记审计；接口见 docs/api.yaml。

export const webLoginQrPrefix = 'pindou-web-login:'

export type WebLoginRequest = components['schemas']['WebLoginChallenge']
export type WebLoginStatus = WebLoginRequest['status']
type Decision = operations['decideWebLoginChallenge']['responses'][200]['content']['application/json']
type Revoked = operations['deleteMyWebSessions']['responses'][200]['content']['application/json']

export const webLoginStatusLabels: Record<WebLoginStatus, string> = {
  pending: '等待你确认',
  approved: '已允许，电脑正在进入后台',
  rejected: '已拒绝',
  used: '这台电脑已经登录',
  expired: '二维码已过期，请在电脑上换一个二维码再扫',
}

const challengeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 电脑登录二维码的内容是 `pindou-web-login:<挑战编号>`；桌码、别家的二维码一律返回空。 */
export function parseWebLoginQr(text: string): string {
  const value = (text || '').trim()
  if (!value.startsWith(webLoginQrPrefix)) return ''
  const id = value.slice(webLoginQrPrefix.length)
  return challengeId.test(id) ? id : ''
}

/**
 * 电脑登录码（小程序码）的 scene 是去掉连字符的挑战编号（32 位）。微信扫一扫打开时它在启动参数 scene 里
 * （可能被编码过）；在小程序里用「扫码」扫到小程序码时，它在结果的 path 里（`…web-login/index?scene=…`）。
 * 都认不出返回空。
 */
export function webLoginIdFromScene(value: string | undefined): string {
  let text = (value || '').trim()
  try {
    text = decodeURIComponent(text)
  } catch {
    return ''
  }
  const match = text.match(/(?:^|[?&])(?:scene=)?([0-9a-f]{32})(?:$|&)/i)
  if (!match) return ''
  const id = match[1].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  return challengeId.test(id) ? id.toLowerCase() : ''
}

/** 把浏览器标识说成人话：店员要认的是「是不是我面前这台 Windows 上的 Edge」。 */
export function describeDevice(userAgent: string): string {
  const ua = userAgent || ''
  const system = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android 设备'
        : /Windows/.test(ua)
          ? 'Windows 电脑'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac 电脑'
            : /Linux|X11/.test(ua)
              ? 'Linux 电脑'
              : ''
  const browser = /MicroMessenger/.test(ua)
    ? '微信内置浏览器'
    : /Edg\//.test(ua)
      ? 'Edge 浏览器'
      : /Firefox\//.test(ua)
        ? 'Firefox 浏览器'
        : /Chrome\//.test(ua)
          ? 'Chrome 浏览器'
          : /Safari\//.test(ua)
            ? 'Safari 浏览器'
            : ''
  return [system, browser].filter(Boolean).join(' · ') || '未知设备'
}

/** 扫码取得挑战编号。取消扫码返回空；扫到的不是电脑登录码时报错说明。 */
export async function scanWebLogin(): Promise<string> {
  // 电脑上显示的可能是小程序码（扫到本小程序的码时，结果在 path 里）或普通二维码（退路，结果在 result 里）。
  // ★ 不传 scanType：文档里它的合法值没有小程序码，传了以后 iOS、安卓真机都认不出小程序码（提示「未发现二维码/条码/小程序码」），
  //   开发者工具却照样认得出，测试发现不了。2026-10-27 业主真机在「连电脑」里扫不上，微信扫一扫能扫；桌码（table-code.ts）一直不传，能扫。
  const scanned = await Taro.scanCode({ onlyFromCamera: true }).then(
    (result) => ({ text: result.result, path: result.path || '', cancelled: false, failed: false }),
    (error: { errMsg?: string } | undefined) => ({
      text: '',
      path: '',
      cancelled: /cancel/.test(error?.errMsg || ''),
      failed: true,
    }),
  )
  if (scanned.cancelled) return ''
  if (scanned.failed) throw new Error('没有扫到二维码，请再试一次')
  // 小程序码只认指向批准页的：桌码的 scene 也是 32 位编号，不核对页面会把桌码当成登录码
  const [page, query = ''] = scanned.path.replace(/^\//, '').split('?')
  const id = parseWebLoginQr(scanned.text) || (page === 'pages/staff/web-login/index' ? webLoginIdFromScene(query) : '')
  if (!id) throw new Error('这不是电脑后台的登录码，请扫电脑屏幕上的码')
  return id
}

/** 工作台上的「扫码登录电脑」：直接调起扫码，扫到电脑登录码就进确认页；取消不提示，扫错了轻提示。 */
export async function openWebLoginByScan(): Promise<void> {
  try {
    const id = await scanWebLogin()
    if (id) await navigateApp(`/pages/staff/web-login/index?id=${encodeURIComponent(id)}`, true)
  } catch (error) {
    void Taro.showToast({ title: error instanceof Error ? error.message : '扫码失败', icon: 'none' })
  }
}

export const webLogin = {
  view: (id: string) => request<WebLoginRequest>(`/auth/web-login-challenges/${encodeURIComponent(id)}`),
  decide: (id: string, approve: boolean) =>
    request<Decision>(`/auth/web-login-challenges/${encodeURIComponent(id)}/decision`, 'POST', { approve }),
  /** 退出本人在所有电脑上的网页登录；别人的登录、小程序登录都不受影响。 */
  revokeAll: () => request<Revoked>('/auth/web-sessions', 'DELETE'),
}
