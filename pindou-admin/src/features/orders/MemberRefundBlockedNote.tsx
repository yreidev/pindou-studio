import { Banner } from '@douyinfe/semi-ui'
import { Link } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'
import type { MemberRefundBlocked } from '../../api/orders'
import { pointSpendText } from './member-refund'
import { orderNumber } from './orders'

/**
 * 按比例该扣回的本单所送积分已被用掉、收不回：缺多少、后端给的原话（含现在最多能退多少），以及被哪些流水用掉
 * （会员结账抵扣的给那张订单的链接——先把它退掉，积分会回到本单的批次）。订单详情与退款侧边栏共用。
 */
export function MemberRefundBlockedNote({
  blocked,
  title,
  action,
  style,
}: {
  blocked: MemberRefundBlocked
  title: string
  /** 说明下面的操作，例如「改为最多可退」。 */
  action?: ReactNode
  style?: CSSProperties
}) {
  return (
    <Banner
      type="warning"
      closeIcon={null}
      style={style}
      title={title}
      description={
        <>
          <div>{blocked.reason}。</div>
          {blocked.spentBy.map((spend) => (
            <div key={`${spend.kind}-${spend.sourceId}-${spend.createdAt}`}>
              {pointSpendText(spend)}
              {spend.kind === 'checkout' ? (
                <>
                  {'，订单 '}
                  <Link to="/orders/$orderId" params={{ orderId: spend.sourceId }}>
                    {orderNumber({ id: spend.sourceId })}
                  </Link>
                </>
              ) : null}
            </div>
          ))}
          {action}
        </>
      }
    />
  )
}
