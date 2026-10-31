import { Input, Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import { StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { staffApi, type Order } from '../../../services/staff'
import { isOpenOrder, money, pendingAmount } from '../../../services/format'
import { navigateApp } from '../../../services/navigation'
import { storeClock } from '../../../services/reservations'
import { useState } from 'react'
import './index.scss'

/**
 * 待结账（系统内收费打开时）：柜台收款的入口。点一单进结账页，在那里改明细、人工折扣、会员抵扣、确认收款。
 * 2026-10-20 重做：分「可以收了」（已停止计时、部分付款、没有计时的单）和「还在计时」两段，按桌号列；
 * 还在计时的金额算到此刻，收第一笔时停表。
 *
 * ★ 订单查询、退款搬去电脑后台「订单与退款」了（admin.example.invalid）：这里只留现场要用的——哪些单还没收钱。
 */
export default function StaffOrders() {
  const live = useStaffEvents(5000)
  const data = useStaffQuery(['sales-orders', 'open'], staffApi.listDraftOrders, {
    refetchInterval: live.refetchInterval,
  })
  // 进行中的会话和桌位只为分段、写桌号：和桌位页同一个查询
  const sessions = useStaffQuery(['venue-sessions', 'live'], () => staffApi.listLiveSessions(), {
    refetchInterval: live.refetchInterval,
  })
  const tables = useStaffQuery(['service-tables'], () => staffApi.listTables(), {
    refetchInterval: live.refetchInterval,
  })
  const [search, setSearch] = useState('')
  const sessionOf = (order: Order) => sessions.data?.find((session) => session.id === order.venueSessionId)
  const tableOf = (order: Order) => {
    const session = sessionOf(order)
    return session ? tables.data?.find((table) => table.id === session.serviceTableId) : undefined
  }
  // 待结账含部分付款（分笔付款收了一部分、还没收齐）：点进去接着收下一笔或对剩余免单
  const keyword = search.trim().toLowerCase()
  const open = (data.data || [])
    .filter(isOpenOrder)
    .filter((order) =>
      `${tableOf(order)?.code || ''} ${order.id} ${order.customer?.nickname || ''} ${order.lines?.map((line) => line.name || '').join(' ')}`
        .toLowerCase()
        .includes(keyword),
    )
    // 按桌号排，没有桌的排最后；同一张桌新的在前
    .sort(
      (a, b) =>
        Number(!tableOf(a)) - Number(!tableOf(b)) ||
        (tableOf(a)?.code || '').localeCompare(tableOf(b)?.code || '') ||
        (b.createdAt || '').localeCompare(a.createdAt || ''),
    )
  const running = (order: Order) => {
    const session = sessionOf(order)
    return order.status === 'draft' && !!session && !session.stoppedAt
  }
  const ready = open.filter((order) => !running(order))
  const timing = open.filter(running)
  const card = (order: Order) => {
    const table = tableOf(order)
    const session = sessionOf(order)
    const amount = pendingAmount(order)
    return (
      <View className="staff-order" key={order.id}>
        <View className="staff-order-head">
          <Text className="staff-order-table">{table?.code || '无桌'}</Text>
          <View className="staff-order-copy">
            <Text className="staff-order-title">
              {order.accountId ? order.customer?.nickname || '会员' : '散客'}
              {session ? ` · ${storeClock(session.startedAt)} 开始` : ''}
            </Text>
            <Text className="staff-order-meta">
              {order.lines
                ?.slice(0, 2)
                .map((line) => `${line.name || '项目'} ×${line.quantity}`)
                .join('、') || '暂无明细'}
              {(order.lines?.length || 0) > 2 ? ` · 共 ${order.lines?.length} 项` : ''}
            </Text>
          </View>
          <View className="staff-order-amount">
            <Text className="money">¥{money(amount.cents)}</Text>
            <Text className={order.status === 'partially_paid' ? 'staff-order-state-warning' : 'staff-order-state'}>
              {amount.label}
            </Text>
          </View>
        </View>
        <Button
          className={`staff-order-button ${running(order) ? '' : 'staff-order-button-dark'}`}
          ariaLabel={`去收款，${table?.code || '订单'} ${order.id.slice(0, 8)}，${amount.text}`}
          onClick={() => {
            void navigateApp(`/pages/staff/checkout/index?id=${encodeURIComponent(order.id)}`, true)
          }}
        >
          去收款
        </Button>
      </View>
    )
  }
  return (
    <StaffScreen
      title="待结账"
      loading={data.loading}
      error={data.error}
      stale={data.data !== null}
      onRetry={data.refresh}
      live={live}
      updatedAt={data.updatedAt}
    >
      <Input
        className="input staff-orders-search"
        ariaLabel="查找订单：桌号、顾客、订单编号或商品名称"
        value={search}
        placeholder="桌号、顾客、订单编号或商品名称"
        onInput={(event) => setSearch(event.detail.value)}
      />
      <View className="staff-orders-group">
        <Text className="staff-orders-title">可以收了 · {ready.length}</Text>
        {ready.map(card)}
        {!ready.length && (
          <Text className="staff-orders-empty">{search ? '没有匹配的订单' : '没有停了表、等收款的单'}</Text>
        )}
      </View>
      <View className="staff-orders-group">
        <Text className="staff-orders-title">还在计时 · {timing.length}</Text>
        <Text className="staff-orders-note">金额算到此刻，收第一笔时停表</Text>
        {timing.map(card)}
        {!timing.length && <Text className="staff-orders-empty">没有还在计时的待结账单</Text>}
      </View>
      <Text className="field-help">历史订单和退款在电脑后台「订单与退款」里查询与办理。</Text>
    </StaffScreen>
  )
}
