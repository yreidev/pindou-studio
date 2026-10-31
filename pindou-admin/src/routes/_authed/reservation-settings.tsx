import { createFileRoute, redirect } from '@tanstack/react-router'

// 原「预约设置」页 2026-10-10 并进「系统设置 › 营业与预约」，旧地址（书签、旧链接）转过去。
export const Route = createFileRoute('/_authed/reservation-settings')({
  beforeLoad: () => {
    throw redirect({ to: '/system-settings', search: { tab: 'reservations' }, replace: true })
  },
})
