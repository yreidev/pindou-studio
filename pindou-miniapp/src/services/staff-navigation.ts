import type { Role } from './customer'

/**
 * 员工端的去处。前四个是手机底部的四格（现场 / 桌位 / 预约 / 会员，2026-10-20 重做），
 * 电脑宽屏的侧栏列出全部。billing：系统内收费开着没有；关着时（2026-10-10 起，钱在美团、大众点评收）没有待结账。
 */
export function staffDestinations(roles: Role[], billing = true) {
  if (!roles.some((role) => ['clerk', 'manager', 'owner'].includes(role))) return []
  // 订单退款、商品资料、盘点、库存流水、员工权限、报表备份、桌码搬去电脑后台了（docs/plan-staff-web-admin.md），
  // 小程序员工端只留现场要用的。开台、会话是桌位页的底部弹层，扫码入座的确认在现场页（docs/plan-page-redesign.md）。
  // 收货入库 2026-10-06 回到手机：货到时人常不在电脑旁，要能扫条码入库（三个角色都有）。
  return [
    { page: 'workbench', label: '现场', icon: 'live' },
    { page: 'tables', label: '桌位', icon: 'tables' },
    { page: 'reservations', label: '预约', icon: 'reservations' },
    { page: 'membership', label: '会员', icon: 'members' },
    { page: 'orders', label: '待结账', icon: 'orders' },
    { page: 'receiving', label: '收货入库', icon: 'inventory' },
    // 扫电脑屏幕上的二维码登录网页后台、手机当扫码枪、一次退出本人所有电脑登录，都在这一页
    { page: 'web-login', label: '连电脑', icon: 'operations' },
  ].filter((link) => billing || link.page !== 'orders')
}

/** 底部四格：手机上这四页有底部导航，其余是从它们点进去的任务页（左上角返回）。 */
export const staffTabs = ['workbench', 'tables', 'reservations', 'membership']

export function activeStaffPage(path: string) {
  const page = path.split('/staff/')[1]?.split('/')[0]
  if (page === 'booking') return 'reservations'
  if (page === 'checkout') return 'orders'
  return page || ''
}
