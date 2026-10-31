import { IconArrowLeft, IconPrint } from '@douyinfe/semi-icons'
import { Button, Empty, Radio, RadioGroup } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { orderQuery, type Order } from '../../../api/orders'
import { Page, QueryState } from '../../../components/Page'
import {
  canPrintReceipt,
  papers,
  parseReceiptSearch,
  receiptOf,
  rememberedPaper,
  rememberPaper,
  type Paper,
} from '../../../features/checkout/receipt'
import { ReceiptSheet } from '../../../features/checkout/ReceiptSheet'
import { isOpen, orderNumber } from '../../../features/orders/orders'

// 小票：浏览器打印。纸宽（58mm、80mm 小票纸或 A4）在网址里（?paper=58），这台电脑记住上次选的。
export const Route = createFileRoute('/_authed/receipt/$orderId')({
  validateSearch: parseReceiptSearch,
  component: ReceiptPage,
})

function ReceiptPage() {
  const { orderId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [remembered] = useState(rememberedPaper)
  const paper = search.paper ?? remembered
  const order = useQuery(orderQuery(orderId))
  const router = useRouter()
  const canGoBack = useCanGoBack()

  const back = canGoBack ? (
    <Button icon={<IconArrowLeft />} onClick={() => router.history.back()}>
      返回
    </Button>
  ) : (
    <Button icon={<IconArrowLeft />} onClick={() => void navigate({ to: '/orders/$orderId', params: { orderId } })}>
      订单详情
    </Button>
  )

  const choose = (next: Paper) => {
    rememberPaper(next)
    void navigate({ search: { paper: next }, replace: true })
  }

  return (
    <div className="receipt-page">
      <Page
        title={`小票 · 订单 ${orderNumber({ id: orderId })}`}
        description="点「打印」后在打印对话框里选小票打印机和纸张（58mm、80mm 卷纸或 A4），边距选「无」。"
        extra={back}
      >
        {order.isError && order.data === undefined && (order.error as { status?: number }).status === 404 ? (
          <Empty title="没有这张订单" description="订单编号可能写错了，回到订单列表重新查找。" />
        ) : (
          <QueryState query={order}>
            {(data) =>
              canPrintReceipt(data) ? (
                <ReceiptView order={data} paper={paper} onPaper={choose} />
              ) : (
                <Empty
                  title={
                    data.status === 'draft'
                      ? '这张订单还没付款'
                      : data.status === 'partially_paid'
                        ? '这张订单还没收齐'
                        : '这张订单已撤销'
                  }
                  description={
                    data.status === 'draft'
                      ? '收款后才能打印小票。'
                      : data.status === 'partially_paid'
                        ? '分笔付款还差一部分：收齐或对剩余免单后才能打印小票。'
                        : '已撤销的订单没有小票。'
                  }
                >
                  {isOpen(data) ? (
                    <Button
                      theme="solid"
                      type="primary"
                      onClick={() => void navigate({ to: '/checkout/$orderId', params: { orderId } })}
                    >
                      去结账
                    </Button>
                  ) : null}
                </Empty>
              )
            }
          </QueryState>
        )}
      </Page>
    </div>
  )
}

function ReceiptView({ order, paper, onPaper }: { order: Order; paper: Paper; onPaper: (paper: Paper) => void }) {
  // 会员结账单印的是本单结账后的余额（订单接口由会员流水推出），不是打印时的余额，事后重印也一样
  return (
    <>
      <div className="receipt-toolbar no-print">
        <RadioGroup
          type="button"
          aria-label="纸张宽度"
          value={paper}
          onChange={(event) => onPaper(event.target.value as Paper)}
        >
          {papers.map((item) => (
            <Radio key={item.value} value={item.value}>
              {item.label}
            </Radio>
          ))}
        </RadioGroup>
        <Button theme="solid" type="primary" icon={<IconPrint />} onClick={() => window.print()}>
          打印
        </Button>
      </div>
      {/* 小票纸不留页边距（卷纸宽度就是纸宽），A4 留常规页边距；纸张大小由打印对话框决定 */}
      <style>{paper === 'a4' ? '@page { margin: 12mm; }' : '@page { margin: 0; }'}</style>
      <ReceiptSheet receipt={receiptOf(order)} paper={paper} />
    </>
  )
}
