import { IconPrint } from '@douyinfe/semi-icons'
import { Banner, Button, Card, Descriptions } from '@douyinfe/semi-ui'
import { useNavigate } from '@tanstack/react-router'
import type { Order } from '../../api/orders'
import { money } from '../../lib/format'
import { memberCheckoutRows } from '../orders/member-refund'
import { compReason, hasComp, isComped, isMemberCheckout, paymentRows, statusNames } from '../orders/orders'
import { balanceAfterItems, canPrintReceipt } from './receipt'

/** 结账页上已经不是待结账的订单：收款成功后、或打开时已被收过款。显示实收与付款，给打印小票的入口。 */
export function PaidSummary({ order }: { order: Order }) {
  const navigate = useNavigate()
  if (!canPrintReceipt(order)) {
    return (
      <Banner
        type="warning"
        closeIcon={null}
        fullMode={false}
        title={`这张订单${statusNames[order.status]}`}
        description="已撤销的订单不能结账，也没有小票。"
      />
    )
  }
  return (
    <Card>
      <Banner
        type="success"
        closeIcon={null}
        fullMode={false}
        title={
          isComped(order)
            ? '已免单结清'
            : hasComp(order)
              ? `${statusNames[order.status]}（剩余免单）`
              : statusNames[order.status]
        }
        description={
          hasComp(order)
            ? `免单 ${money(order.compCents ?? 0)}，实收 ${money(order.paidCents)}。原因：${compReason(order)}`
            : `实收 ${money(order.paidCents)}`
        }
        style={{ marginBottom: 16 }}
      />
      <Descriptions
        align="left"
        data={[
          { key: '应收', value: money(order.receivableCents) },
          { key: '实收', value: money(order.paidCents) },
          // 每笔一行（分几笔收的写第几笔）；现金填了实收的，同一行写上实收与找零（后端记下的数），员工照着找钱
          ...paymentRows(order),
          ...(isMemberCheckout(order) && order.memberCheckout ? memberCheckoutRows(order.memberCheckout) : []),
          ...(isMemberCheckout(order) ? balanceAfterItems(order.memberCheckout) : []),
        ]}
      />
      {/* 按钮直接跳转，不包在链接里（<a><button> 是两个可聚焦的元素套在一起，读屏和键盘都会走两次） */}
      <div className="checkout-actions" style={{ marginTop: 16 }}>
        <Button
          theme="solid"
          type="primary"
          icon={<IconPrint />}
          onClick={() => void navigate({ to: '/receipt/$orderId', params: { orderId: order.id } })}
        >
          打印小票
        </Button>
        <Button onClick={() => void navigate({ to: '/orders/$orderId', params: { orderId: order.id } })}>
          查看订单详情
        </Button>
        <Button onClick={() => void navigate({ to: '/orders', search: { status: 'open' } })}>回到待结账列表</Button>
      </div>
    </Card>
  )
}
