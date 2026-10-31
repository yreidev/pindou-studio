import { Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import Taro, { useRouter } from '@tarojs/taro'
import {
  AuthBoundary,
  Failure,
  RefreshNotice,
  OrderBadge,
  Screen,
  Skeleton,
  Status,
} from '../../../components/customer'
import { useCustomerQuery } from '../../../hooks/query'
import { customer } from '../../../services/platform'
import { dateTime, money, orderAmount, orderTitle, paymentLabels } from '../../../services/format'
import './index.scss'

export default function OrderDetail() {
  const { params } = useRouter()
  const resource = useCustomerQuery(['sales-orders', params.id || ''], () => customer.getOrder(params.id || ''), {
    live: true,
  })
  const order = resource.data
  return (
    <Screen title="订单详情" back className="detail-screen">
      <AuthBoundary>
        {!!resource.error && resource.data !== null && (
          <RefreshNotice
            retry={() => {
              void resource.refresh()
            }}
          />
        )}
        {resource.loading ? (
          <Skeleton />
        ) : resource.error && !resource.data ? (
          <Failure
            error={resource.error}
            retry={() => {
              void resource.refresh()
            }}
          />
        ) : !order ? (
          <Status
            kind="empty"
            title="订单不存在"
            message="这个订单可能已被撤销，或者链接已失效。"
            action="查看全部订单"
            onAction={() => {
              void Taro.switchTab({ url: '/pages/orders/index' })
            }}
          />
        ) : (
          <>
            {/* 画稿 BOrderDetail（2026-10-20）：深色头卡写已付和还差，下面明细、优惠、付款、退款各一张卡 */}
            <View className="detail-head">
              <View className="detail-head-top">
                <Text className="detail-head-time">
                  {order.createdAt ? dateTime(order.createdAt) : orderTitle(order)}
                </Text>
                <OrderBadge status={order.status} />
              </View>
              <Text className="detail-title">{orderTitle(order)}</Text>
              <Text className="detail-head-label">{orderAmount(order).label}</Text>
              <Text className="detail-amount">¥{money(orderAmount(order).cents)}</Text>
              {order.status === 'partially_paid' && (
                <Text className="detail-head-note">可以分几次付，收齐之前店员会留着这一单</Text>
              )}
              {order.status === 'draft' && (
                <Text className="detail-head-note">用完找店员结账；会员价、储值和积分抵扣都在结账时算</Text>
              )}
            </View>
            <View className="detail-card">
              <Text className="section-title">消费明细</Text>
              {(order.lines || []).length ? (
                order.lines?.map((line, index) => (
                  <View className="detail-line" key={index}>
                    <View className="detail-line-copy">
                      <Text className="strong">{line.name || '消费项目'}</Text>
                      <Text className="field-help">
                        单价 ¥{money(line.unitPriceCents)} · ×{line.quantity}
                      </Text>
                    </View>
                    <Text className="detail-line-amount">¥{money(line.unitPriceCents * line.quantity)}</Text>
                  </View>
                ))
              ) : (
                <Text className="muted">暂无消费明细</Text>
              )}
              <View className="detail-totals">
                <View className="detail-total">
                  <Text>应收金额</Text>
                  <Text>¥{money(order.receivableCents)}</Text>
                </View>
                <View className="detail-total detail-paid">
                  <Text className="strong">实付金额</Text>
                  <Text className="money">¥{money(order.paidCents)}</Text>
                </View>
                {/* 分笔付款还没收齐：还差多少以接口的 outstandingCents 为准 */}
                {order.status === 'partially_paid' && order.outstandingCents !== undefined && (
                  <View className="detail-total">
                    <Text>还差</Text>
                    <Text className="money">¥{money(order.outstandingCents)}</Text>
                  </View>
                )}
              </View>
            </View>
            {Boolean(order.discounts?.length) && (
              <View className="detail-card">
                <Text className="section-title">优惠记录</Text>
                {order.discounts?.map((discount) => (
                  <View className="detail-line" key={discount.id}>
                    <View className="detail-line-copy">
                      <Text className="strong">{discount.kind === 'fixed' ? '固定金额优惠' : '比例折扣'}</Text>
                      <Text className="field-help">
                        {discount.reason} · {dateTime(discount.createdAt)}
                      </Text>
                    </View>
                    <Text className="detail-line-amount">
                      {discount.kind === 'fixed'
                        ? `¥${money(discount.amountCents || 0)}`
                        : `${money(discount.rateBasisPoints || 0)}%`}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            <View className="detail-card">
              <Text className="section-title">付款记录</Text>
              {order.payments?.length ? (
                order.payments.map((payment) => (
                  <View className="detail-line" key={payment.id}>
                    <View className="detail-line-copy">
                      <Text>{paymentLabels[payment.method]}</Text>
                      <Text className="field-help">{dateTime(payment.createdAt)}</Text>
                    </View>
                    <Text className="detail-line-amount">¥{money(payment.amountCents)}</Text>
                  </View>
                ))
              ) : (
                <Text className="muted">暂无付款记录</Text>
              )}
            </View>
            {Boolean(order.refunds?.length) && (
              <View className="detail-card">
                <Text className="section-title">退款记录</Text>
                <Text className="field-help">付款与退款分别保留记录，上面的付款记录照样留着，两边一起核对。</Text>
                {order.refunds?.map((refund) => (
                  <View className="detail-line" key={refund.id}>
                    <View className="detail-line-copy">
                      <Text>{refund.reason}</Text>
                      <Text className="field-help">{dateTime(refund.createdAt)}</Text>
                    </View>
                    <Text className="detail-line-amount">¥{money(refund.amountCents)}</Text>
                  </View>
                ))}
              </View>
            )}
            <View className="detail-card detail-id">
              <View className="detail-id-copy">
                <Text className="info-label">订单编号</Text>
                <Text className="info-value" selectable>
                  {order.id}
                </Text>
              </View>
              <Button
                className="detail-copy"
                onClick={() => {
                  void Taro.setClipboardData({ data: order.id })
                }}
              >
                复制编号
              </Button>
            </View>
          </>
        )}
      </AuthBoundary>
    </Screen>
  )
}
