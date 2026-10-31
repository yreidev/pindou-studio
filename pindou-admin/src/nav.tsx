import {
  IconArchive,
  IconCalendarClock,
  IconCreditCard,
  IconGift,
  IconHome,
  IconImage,
  IconList,
  IconMapPin,
  IconQrCode,
  IconServer,
  IconSetting,
  IconUserGroup,
} from '@douyinfe/semi-icons'
import type { ReactNode } from 'react'
import { hasRole, type StaffRole } from './account'
import type { Account } from './session'

/**
 * 侧栏导航。roles 只决定显示，权限由后端校验；和小程序同一套划分（docs/plan-staff-web-admin.md）。
 * 新页面加在这里，路由文件放 src/routes/_authed/ 下。
 */
export interface NavItem {
  to: string
  text: string
  icon: ReactNode
  roles: StaffRole[]
  /** 首页入口卡片上的一句说明 */
  summary?: string
  /** 只在系统内收费开着时显示（关着时门店不在系统里收钱，订单、结账入口先藏起来，地址照样能进）。 */
  billingOnly?: boolean
}

const everyone: StaffRole[] = ['clerk', 'manager', 'owner']
const managers: StaffRole[] = ['manager', 'owner']

export const navItems: NavItem[] = [
  { to: '/', text: '首页', icon: <IconHome />, roles: everyone },
  {
    to: '/board',
    text: '现场',
    icon: <IconMapPin />,
    roles: everyone,
    summary: '平面图看桌位计时与预约，点空座位开台，处理扫码入座、到店开台、快到点和超时',
  },
  {
    to: '/reservations',
    text: '预约',
    icon: <IconCalendarClock />,
    roles: everyone,
    summary: '按日期看预约，确认、到店开台、取消、标记爽约，接电话时代客登记',
  },
  {
    to: '/orders',
    text: '订单与退款',
    icon: <IconList />,
    roles: everyone,
    summary: '待结账订单结账收款、打印小票，查订单与退款记录，按件登记退款',
    billingOnly: true,
  },
  {
    to: '/inventory',
    text: '商品与库存',
    icon: <IconArchive />,
    roles: everyone,
    summary: '商品资料、采购入库、盘点和库存流水',
  },
  {
    to: '/rules',
    text: '经营规则',
    icon: <IconGift />,
    roles: managers,
    summary: '会员等级、充值、积分、生日与套餐：草稿、预览、发布',
  },
  {
    to: '/members',
    text: '会员资产',
    icon: <IconCreditCard />,
    roles: everyone,
    summary: '查会员余额与流水，手动加减储值和积分，柜台充值、积分兑换、生日礼物核销；老板办充值退款',
  },
  { to: '/staff', text: '员工权限', icon: <IconUserGroup />, roles: managers, summary: '分配和撤销店员、店长、老板' },
  {
    to: '/operations',
    text: '运营与系统',
    icon: <IconServer />,
    roles: managers,
    summary: '导出 Excel、备份与恢复、审计记录',
  },
  {
    to: '/storefront',
    text: '首页内容',
    icon: <IconImage />,
    roles: everyone,
    summary: '小程序首页的公告，顾客看的图纸和图纸分类：上传、上下架、排顺序',
  },
  { to: '/table-codes', text: '桌码', icon: <IconQrCode />, roles: everyone, summary: '生成桌码，浏览器直接打印' },
  {
    to: '/system-settings',
    text: '系统设置',
    icon: <IconSetting />,
    roles: ['owner'],
    summary: '系统内收费开关、营业时间与预约（含门店地址）、小程序码指向的版本',
  },
]

/** billing：系统内收费开着没有（useBillingEnabled）。 */
export function visibleNavItems(account: Account, billing: boolean): NavItem[] {
  return navItems.filter((item) => hasRole(account, ...item.roles) && (billing || !item.billingOnly))
}

/** 没有自己侧栏项的页面算在哪一项下：结账、小票是订单的一步。 */
const parentPaths: Record<string, string> = { '/checkout': '/orders', '/receipt': '/orders' }

/** 当前地址落在哪个侧栏项上：/orders/123 也算「订单与退款」。 */
export function activeNavKey(pathname: string): string {
  const parent = Object.entries(parentPaths).find(([path]) => pathname.startsWith(`${path}/`))
  if (parent) return parent[1]
  const match = navItems
    .filter((item) => item.to !== '/' && (pathname === item.to || pathname.startsWith(`${item.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0]
  return match?.to ?? '/'
}
