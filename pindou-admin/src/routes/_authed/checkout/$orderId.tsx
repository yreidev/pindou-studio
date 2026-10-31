import { IconArrowLeft } from '@douyinfe/semi-icons'
import { Button, Empty } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { orderQuery } from '../../../api/orders'
import { Page, QueryState } from '../../../components/Page'
import { CheckoutWorkspace } from '../../../features/checkout/CheckoutWorkspace'

// 结账：待结账订单的明细、人工折扣、会员抵扣与收款登记，付款后打印小票。
// 入口：订单列表与详情的「去结账」、现场看板的「停止计时并去结账」。
export const Route = createFileRoute('/_authed/checkout/$orderId')({
  component: CheckoutPage,
})

function CheckoutPage() {
  const { orderId } = Route.useParams()
  const order = useQuery(orderQuery(orderId))
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()

  // 从订单页、看板点进来就退回去；直接打开的地址回到待结账列表
  const back = canGoBack ? (
    <Button icon={<IconArrowLeft />} onClick={() => router.history.back()}>
      返回
    </Button>
  ) : (
    <Button icon={<IconArrowLeft />} onClick={() => void navigate({ to: '/orders', search: { status: 'open' } })}>
      待结账列表
    </Button>
  )

  if (order.isError && order.data === undefined && (order.error as { status?: number }).status === 404) {
    return (
      <Page title="结账" extra={back}>
        <Empty title="没有这张订单" description="订单编号可能写错了，回到订单列表重新查找。" />
      </Page>
    )
  }

  return (
    <QueryState query={order}>
      {(data) => (
        // 换了一张订单就整个重来：表单初值、报价都跟着那张订单
        <CheckoutWorkspace key={data.id} latest={data} latestUpdatedAt={order.dataUpdatedAt} back={back} />
      )}
    </QueryState>
  )
}
