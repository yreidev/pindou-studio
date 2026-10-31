import { membershipName } from '../brand'
import { friendlyStamp, slotFromParam } from './reservations'

/**
 * 登录页上那一句「登录后接着……」（2026-10-20，docs/plan-page-redesign.md 第 1 节第 7 条）：从别处点进登录的，
 * 告诉顾客登录完回到哪件事，比如带着 14:00 回预约页。去处是 navigation.ts 记下的登录目标（已按白名单清洗过）；
 * 回首页、图纸，或者直接打开登录页的，不写。
 */
export function loginHint(target: string | undefined, now: Date = new Date()): string {
  if (!target) return ''
  const [path, query = ''] = target.split('?')
  const at = slotFromParam(/(?:^|&)at=(\d+)/.exec(query)?.[1])
  if (path === '/pages/customer/reservations/index')
    return at ? `登录后接着预约${friendlyStamp(at, now)}` : '登录后接着预约座位'
  if (path === '/pages/customer/experience/index') return '登录后接着本次手作'
  if (path === '/pages/customer/membership/index') return `登录后打开${membershipName}`
  if (path === '/pages/customer/my-reservations/index') return '登录后看我的预约'
  if (path === '/pages/orders/index') return '登录后看你的预约和订单'
  if (path === '/pages/customer/order-detail/index') return '登录后接着看这笔订单'
  if (path === '/pages/profile/index' || path === '/pages/customer/profile-edit/index') return '登录后管理个人资料'
  if (path === '/pages/staff/web-login/index') return '登录后接着登录电脑'
  if (path.startsWith('/pages/staff/')) return '登录后回到员工页面'
  return ''
}
