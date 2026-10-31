import { IconArrowLeft, IconPrint } from '@douyinfe/semi-icons'
import { Banner, Button, Card, Descriptions, Empty, Space, Table, Tag, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { useCurrentAccount } from '../../../account'
import {
  orderQuery,
  type Order,
  type OrderDiscount,
  type OrderLine,
  type Payment,
  type Refund,
} from '../../../api/orders'
import { Nowrap } from '../../../components/Nowrap'
import { Page, QueryState } from '../../../components/Page'
import { dateTime, money } from '../../../lib/format'
import {
  memberCheckoutRows,
  memberRefundBlockedTitle,
  memberRefundedRows,
} from '../../../features/orders/member-refund'
import { MemberRefundBlockedNote } from '../../../features/orders/MemberRefundBlockedNote'
import { MemberRefundSheet } from '../../../features/orders/MemberRefundSheet'
import {
  cashTenderText,
  compReason,
  customerLabel,
  discountText,
  hasComp,
  hasOtherPayers,
  isComped,
  isMemberCheckout,
  isOpen,
  isPartiallyRefunded,
  lineName,
  memberRefundableCents,
  memberRefundAvailable,
  moneyPayments,
  orderNumber,
  paymentLabel,
  refundablePayments,
  refundEntry,
  returnedText,
  statusColors,
  statusNames,
} from '../../../features/orders/orders'
import { RefundSheet } from '../../../features/orders/RefundSheet'
import { balanceAfterItems, canPrintReceipt } from '../../../features/checkout/receipt'

export const Route = createFileRoute('/_authed/orders/$orderId')({
  component: OrderDetailPage,
})

function OrderDetailPage() {
  const { orderId } = Route.useParams()
  const order = useQuery(orderQuery(orderId))
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()

  // 从列表点进来就退回列表（带着原来的搜索、筛选、页码）；直接打开的地址回到列表首页
  const back = canGoBack ? (
    <Button icon={<IconArrowLeft />} onClick={() => router.history.back()}>
      返回列表
    </Button>
  ) : (
    <Button icon={<IconArrowLeft />} onClick={() => void navigate({ to: '/orders' })}>
      返回列表
    </Button>
  )

  if (order.isError && order.data === undefined && (order.error as { status?: number }).status === 404) {
    return (
      <Page title="订单详情" extra={back}>
        <Empty title="没有这张订单" description="订单编号可能写错了，回到列表重新查找。" />
      </Page>
    )
  }

  return <QueryState query={order}>{(data) => <OrderDetail order={data} back={back} />}</QueryState>
}

function OrderDetail({ order, back }: { order: Order; back: ReactNode }) {
  const me = useCurrentAccount()
  // 每次打开退款换一个 key，让侧边栏重新记下打开那一刻的订单。kind 是走哪条退款：会员结账那一笔按比例退（member），
  // 其余现金、微信、支付宝按笔退（standard，paymentId 是在付款记录里点的那一笔）
  const [refundSheet, setRefundSheet] = useState<{
    open: boolean
    round: number
    kind: 'member' | 'standard'
    paymentId?: string
  }>({ open: false, round: 0, kind: 'standard' })
  const openRefund = (kind: 'member' | 'standard', paymentId?: string) =>
    setRefundSheet((previous) => ({ open: true, round: previous.round + 1, kind, paymentId }))
  const entry = refundEntry(order, me)
  const member = isMemberCheckout(order)
  // 能办哪种退款：会员结账那一笔还有可退的；别人分笔付的（或普通订单的）现金、微信、支付宝还有可退的
  const memberRefundable = entry === 'available' && memberRefundAvailable(order)
  const standardChoices = entry === 'available' ? refundablePayments(order) : []
  const customer = customerLabel(order)
  const navigate = useNavigate()

  return (
    <Page
      title={`订单 ${orderNumber(order)}`}
      description={`${dateTime(order.createdAt)} · ${customer}`}
      extra={
        <>
          {back}
          {isOpen(order) ? (
            <Button
              theme="solid"
              type="primary"
              onClick={() => void navigate({ to: '/checkout/$orderId', params: { orderId: order.id } })}
            >
              {order.status === 'partially_paid' ? '去结账（接着收）' : '去结账'}
            </Button>
          ) : null}
          {canPrintReceipt(order) ? (
            <Button
              icon={<IconPrint />}
              onClick={() => void navigate({ to: '/receipt/$orderId', params: { orderId: order.id } })}
            >
              打印小票
            </Button>
          ) : null}
          {memberRefundable ? (
            <Button type="danger" theme="solid" onClick={() => openRefund('member')}>
              办理会员退款
            </Button>
          ) : null}
          {standardChoices.length ? (
            // 会员结账单里别人分笔付的几笔走普通退款；普通订单就是「办理退款」
            <Button type="danger" theme={member ? 'light' : 'solid'} onClick={() => openRefund('standard')}>
              {member ? '退别人付的一笔' : '办理退款'}
            </Button>
          ) : null}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        {entry === 'no-permission' ? (
          <Banner type="info" closeIcon={null} description="退款需店长或老板办理。" />
        ) : null}
        {isComped(order) ? (
          <Banner
            type="info"
            closeIcon={null}
            title={`已免单 ${money(order.compCents ?? 0)}`}
            description={`原因：${compReason(order)}。免单是店长、老板把这一单直接结清、不收钱，没有收到钱，所以不能退款；需要冲正的商品请按盘点处理。`}
          />
        ) : hasComp(order) ? (
          <Banner
            type="info"
            closeIcon={null}
            title={`剩余 ${money(order.compCents ?? 0)} 已免单`}
            description={`原因：${compReason(order)}。分笔付款收了 ${money(order.paidCents)} 之后，剩下的由店长、老板免单结清；免掉的部分不能退款，收到的几笔照常可以按笔退。`}
          />
        ) : null}
        {order.status === 'draft' ? (
          <Banner
            type="info"
            closeIcon={null}
            description="这张订单还没结账：点右上角「去结账」改明细、打折、收款（小程序结账页也能办）。"
          />
        ) : null}
        {order.status === 'partially_paid' ? (
          <Banner
            type="warning"
            closeIcon={null}
            title={`部分付款，还差 ${money(order.outstandingCents ?? 0)}`}
            description="已经收了一部分（分笔付款）：明细和金额已定，计时已停。点右上角「去结账（接着收）」收下一笔，或由店长、老板对剩余免单；收齐之前不能退款。"
          />
        ) : null}

        <Card title="状态与金额">
          <Descriptions
            align="left"
            data={[
              {
                key: '状态',
                value: (
                  <Space spacing={4}>
                    <Tag color={statusColors[order.status]}>{statusNames[order.status]}</Tag>
                    {isPartiallyRefunded(order) ? <Tag color="orange">部分退款</Tag> : null}
                    {member ? <Tag color="violet">会员结账</Tag> : null}
                    {isComped(order) ? (
                      <Tag color="amber">免单</Tag>
                    ) : hasComp(order) ? (
                      <Tag color="amber">部分免单</Tag>
                    ) : null}
                  </Space>
                ),
              },
              { key: '应收', value: money(order.receivableCents) },
              ...(hasComp(order) ? [{ key: '免单', value: money(order.compCents ?? 0) }] : []),
              { key: '已付', value: money(order.paidCents) },
              {
                key: '还差',
                value: money(order.outstandingCents ?? 0),
                hidden: order.status !== 'partially_paid',
              },
              { key: '已退', value: money(order.refundedCents) },
              {
                key: '还可退',
                value:
                  entry === 'fully-refunded'
                    ? `${money(order.refundableCents)}（已全部退款）`
                    : member
                      ? hasOtherPayers(order)
                        ? `${money(order.refundableCents)}（会员这一笔 ${money(memberRefundableCents(order))} 按原付款比例退，别人付的按笔退）`
                        : `${money(order.refundableCents)}（按原付款比例退，可分多次）`
                      : moneyPayments(order).length > 1
                        ? `${money(order.refundableCents)}（分几笔收的，按笔退）`
                        : money(order.refundableCents),
                hidden: order.status !== 'paid' && order.status !== 'refunded',
              },
              { key: '顾客', value: customer },
              { key: '创建时间', value: dateTime(order.createdAt) },
              {
                key: '订单编号',
                value: <Typography.Text copyable={{ content: order.id }}>{order.id}</Typography.Text>,
              },
            ]}
          />
        </Card>

        {member && order.memberCheckout ? (
          <Card title="会员结账">
            <Descriptions
              align="left"
              data={[...memberCheckoutRows(order.memberCheckout), ...balanceAfterItems(order.memberCheckout)]}
            />
            {order.memberCheckout.refunded ? (
              <>
                <Typography.Title heading={6} style={{ margin: '12px 0 4px' }}>
                  已退回（{order.refunds?.length ?? 0} 次累计）
                </Typography.Title>
                <Descriptions align="left" data={memberRefundedRows(order.memberCheckout.refunded)} />
              </>
            ) : null}
            <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 8 }}>
              这张订单用会员结账收款。可以分多次退：每次的金额按原付款比例拆到线下补付、储值本金、赠送余额，抵扣的积分按同一比例回到原批次，本单送出的积分按同一比例扣回；零头在最后退满那次结清。线下部分按原付款方式退还顾客。
            </Typography.Paragraph>
            {order.status === 'paid' && order.memberCheckout.refundBlocked ? (
              <MemberRefundBlockedNote
                blocked={order.memberCheckout.refundBlocked}
                style={{ marginTop: 12 }}
                title={memberRefundBlockedTitle(order.memberCheckout.refundBlocked)}
              />
            ) : null}
          </Card>
        ) : null}

        {order.refunds?.length ? (
          <Card title={`退款记录（${order.refunds.length} 笔）`}>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={order.refunds}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                },
                { title: '金额', align: 'right', dataIndex: 'amountCents', render: (value: number) => money(value) },
                {
                  title: '原因',
                  dataIndex: 'reason',
                  render: (value: string) => <div className="cell-wide">{value}</div>,
                },
                { title: '回补库存', render: (_: unknown, row: Refund) => returnedText(row, order) },
              ]}
            />
          </Card>
        ) : null}

        <Card title="消费明细">
          <Table
            size="small"
            rowKey="index"
            pagination={false}
            empty="暂无消费明细"
            dataSource={(order.lines ?? []).map((line, index) => ({ ...line, index }))}
            columns={[
              { title: '项目', render: (_: unknown, row: OrderLine) => lineName(row) },
              {
                title: '类型',
                render: (_: unknown, row: OrderLine) =>
                  row.productId ? <Tag color="blue">商品</Tag> : <Tag color="grey">服务</Tag>,
              },
              { title: '数量', align: 'right', dataIndex: 'quantity' },
              { title: '单价', align: 'right', dataIndex: 'unitPriceCents', render: (value: number) => money(value) },
            ]}
          />
        </Card>

        {order.discounts?.length ? (
          <Card title="折扣与优惠">
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={order.discounts}
              columns={[
                {
                  title: '时间',
                  dataIndex: 'createdAt',
                  render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                },
                { title: '方式', render: (_: unknown, row: OrderDiscount) => discountText(row) },
                { title: '原因', dataIndex: 'reason' },
              ]}
            />
          </Card>
        ) : null}

        <Card
          title={moneyPayments(order).length > 1 ? `付款记录（分 ${moneyPayments(order).length} 笔收）` : '付款记录'}
        >
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            empty="暂无付款记录"
            dataSource={order.payments ?? []}
            columns={[
              { title: '时间', dataIndex: 'createdAt', render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap> },
              { title: '方式', render: (_: unknown, row: Payment) => paymentLabel(row, order) },
              { title: '金额', align: 'right', dataIndex: 'amountCents', render: (value: number) => money(value) },
              {
                title: '实收与找零',
                render: (_: unknown, row: Payment) => <Nowrap>{cashTenderText(row) ?? '—'}</Nowrap>,
              },
              {
                title: '已退 / 还可退',
                align: 'right',
                // 普通退款按笔退的上限（接口给的这一笔的数）；会员结账那一笔看上面「会员结账」卡片，免单没有可退的
                render: (_: unknown, row: Payment) =>
                  row.refundableCents !== undefined ? (
                    <Nowrap>
                      {money(row.refundedCents ?? 0)} / {money(row.refundableCents)}
                    </Nowrap>
                  ) : (
                    '—'
                  ),
              },
              {
                title: '说明',
                // 免单记的是免掉的金额，不是收到的钱
                render: (_: unknown, row: Payment) =>
                  row.method === 'comp' ? (
                    <div className="cell-wide">免单原因：{row.reason}（不能退款）</div>
                  ) : row.member && hasOtherPayers(order) ? (
                    '会员结账那一笔，按原付款比例退'
                  ) : (
                    '—'
                  ),
              },
              ...(entry === 'available'
                ? [
                    {
                      title: '操作',
                      render: (_: unknown, row: Payment) =>
                        row.member && memberRefundable && hasOtherPayers(order) ? (
                          <Button size="small" type="danger" onClick={() => openRefund('member')}>
                            会员退款
                          </Button>
                        ) : standardChoices.some((choice) => choice.payment.id === row.id) ? (
                          <Button size="small" type="danger" onClick={() => openRefund('standard', row.id)}>
                            退这笔
                          </Button>
                        ) : null,
                    },
                  ]
                : []),
            ]}
          />
        </Card>
      </div>

      {refundSheet.round > 0 ? (
        refundSheet.kind === 'member' ? (
          <MemberRefundSheet
            key={refundSheet.round}
            order={order}
            customer={customer}
            visible={refundSheet.open}
            onClose={() => setRefundSheet((previous) => ({ ...previous, open: false }))}
          />
        ) : (
          <RefundSheet
            key={refundSheet.round}
            order={order}
            paymentId={refundSheet.paymentId}
            visible={refundSheet.open}
            onClose={() => setRefundSheet((previous) => ({ ...previous, open: false }))}
          />
        )
      ) : null}
    </Page>
  )
}
