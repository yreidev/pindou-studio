import { PageControls, pageSlice } from '../../components/pagination'
import { useMemo, useState } from 'react'
import { Text, View } from '@tarojs/components'
import { Button } from '../../components/button'
import Taro from '@tarojs/taro'
import { AuthBoundary, Failure, RefreshNotice, OrderCard, Screen, Skeleton, Status } from '../../components/customer'
import { MyReservationsContent } from '../../components/customer/my-reservations'
import { useBillingEnabled, useOrdersTabText } from '../../hooks/billing'
import { useCustomerQuery } from '../../hooks/query'
import { customer } from '../../services/platform'
import type { Order } from '../../services/customer'
import { dateTime, isOpenOrder, money, orderTitle } from '../../services/format'
import { reservations } from '../../services/reservations'
import './index.scss'

const filters: { value: 'all' | Order['status']; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '待结账' },
  { value: 'paid', label: '已付款' },
  { value: 'refunded', label: '已退款' },
]

// 底部第三格：系统内收费开着是「我的订单」；关着时（钱在美团、大众点评收，没有订单）换成「我的预约」，
// 底部栏的名字由 useOrdersTabText 跟着改。

export default function Orders() {
  const billing = useBillingEnabled()
  useOrdersTabText()
  return (
    <Screen brand className="orders-screen">
      <AuthBoundary>
        {billing ? (
          <OrderList />
        ) : (
          <>
            <Text className="page-heading">我的预约</Text>
            <MyReservationsContent />
          </>
        )}
      </AuthBoundary>
    </Screen>
  )
}

/**
 * 我的订单（系统内收费打开时，2026-10-20 重做，画稿 BOrders）：还没结清的做成深色大卡（用完找店员结账），
 * 以前的列表照旧点进详情；右上角进我的预约。
 */
function OrderList() {
  const [filter, setFilter] = useState<'all' | Order['status']>('all')
  const [page, setPage] = useState(0)
  const resource = useCustomerQuery(['sales-orders'], customer.listOrders, { live: true })
  // 右上角「我的预约 · N」：和我的预约同一个查询
  const mine = useCustomerQuery(['reservations'], reservations.me)
  const upcoming = (mine.data?.reservations || []).filter(
    (entry) => entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed',
  ).length
  // 「待结账」含部分付款（分笔付款收了一部分、还没收齐）
  const orders = useMemo(
    () =>
      (resource.data || []).filter(
        (order) => filter === 'all' || order.status === filter || (filter === 'draft' && isOpenOrder(order)),
      ),
    [resource.data, filter],
  )
  const open = orders.filter(isOpenOrder)
  const rest = orders.filter((order) => !isOpenOrder(order))
  return (
    <>
      {!!resource.error && resource.data !== null && (
        <RefreshNotice
          retry={() => {
            void resource.refresh()
          }}
        />
      )}
      <View className="orders-head">
        <Text className="page-heading">我的订单</Text>
        <Button
          className="orders-reservations"
          onClick={() => {
            void Taro.navigateTo({ url: '/pages/customer/my-reservations/index' })
          }}
        >
          我的预约{upcoming ? ` · ${upcoming}` : ''}
        </Button>
      </View>
      <View className="order-tabs" role="tablist">
        {filters.map((item) => {
          const count = item.value === 'draft' ? (resource.data || []).filter(isOpenOrder).length : 0
          return (
            <Button
              key={item.value}
              className={`order-tab ${filter === item.value ? 'selected' : ''}`}
              ariaLabel={`${item.label}${filter === item.value ? '，已选中' : ''}`}
              onClick={() => {
                setFilter(item.value)
                setPage(0)
              }}
            >
              {item.label}
              {count ? ` · ${count}` : ''}
            </Button>
          )
        })}
      </View>
      {resource.loading ? (
        <Skeleton />
      ) : resource.error && !resource.data ? (
        <Failure
          error={resource.error}
          retry={() => {
            void resource.refresh()
          }}
        />
      ) : orders.length ? (
        <View>
          {open.length > 0 && (
            <>
              <Text className="orders-section">还没结清</Text>
              {open.map((order) => (
                <OpenOrder key={order.id} order={order} />
              ))}
            </>
          )}
          {rest.length > 0 && (
            <>
              <Text className="orders-section">以前的</Text>
              <View className="orders-past">
                {pageSlice(rest, page).map((order) => (
                  <OrderCard key={order.id} order={order} />
                ))}
              </View>
              <PageControls page={page} total={rest.length} onChange={setPage} />
            </>
          )}
          <Text className="orders-end">{rest.length <= 20 ? '已显示全部订单' : '按页查看历史订单'}</Text>
        </View>
      ) : (
        <Status
          kind="empty"
          title={filter === 'all' ? '暂无订单' : `暂无${filters.find((item) => item.value === filter)?.label}订单`}
          message="门店关联的消费订单会显示在这里"
          action={filter === 'all' ? '返回首页' : '查看全部订单'}
          onAction={() => {
            if (filter === 'all') void Taro.switchTab({ url: '/pages/index/index' })
            else setFilter('all')
          }}
        />
      )}
    </>
  )
}

/** 还没结清的一单：深色大卡，写应收（部分付款写还差），用完找店员结账。 */
function OpenOrder({ order }: { order: Order }) {
  const partial = order.status === 'partially_paid'
  const due = partial ? (order.outstandingCents ?? order.receivableCents - order.paidCents) : order.receivableCents
  const lines = order.lines || []
  return (
    <Button
      className="orders-open enter"
      ariaLabel={`查看${orderTitle(order)}订单，${partial ? '部分付款，还差' : '待结账，应收'}${money(due)}元`}
      onClick={() => {
        void Taro.navigateTo({ url: `/pages/customer/order-detail/index?id=${encodeURIComponent(order.id)}` })
      }}
    >
      <View className="orders-open-top">
        <Text className="orders-open-time">{order.createdAt ? dateTime(order.createdAt) : orderTitle(order)}</Text>
        <Text className="orders-open-state">{partial ? '部分付款' : '待结账'}</Text>
      </View>
      <Text className="orders-open-label">{partial ? '还差' : '应收'}</Text>
      <Text className="orders-open-amount">¥{money(due)}</Text>
      {partial && <Text className="orders-open-note">已付 ¥{money(order.paidCents)}，可以分几次付</Text>}
      <Text className="orders-open-note">用完找店员结账；会员价、储值和积分抵扣都在结账时算</Text>
      <View className="orders-open-foot">
        <Text className="orders-open-lines">
          {lines[0]?.name || '消费项目'}
          {lines.length > 1 ? ` 等 ${lines.length} 项` : ` · ${lines[0]?.quantity ?? 1} 件`}
        </Text>
        <Text className="orders-open-more">看明细 ›</Text>
      </View>
    </Button>
  )
}
