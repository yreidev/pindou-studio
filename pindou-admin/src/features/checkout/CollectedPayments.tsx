import { Card, Descriptions, Table, Typography } from '@douyinfe/semi-ui'
import type { Order, Payment } from '../../api/orders'
import { Nowrap } from '../../components/Nowrap'
import { dateTime, money } from '../../lib/format'
import { cashTenderText, hasComp, moneyPayments, paymentLabel, paymentNumbers } from '../orders/orders'
import { outstandingOf } from './payment'

/**
 * 分笔付款（多人合付）已经收到的几笔：应收、已收、还差，每笔的方式、金额、时间与现金实收找零，会员结账那几条标出来。
 * 数字全部照接口（paidCents、outstandingCents、每条付款记录），前端不加减。部分付款的结账页上用。
 */
export function CollectedPayments({ order }: { order: Order }) {
  const payments = order.payments ?? []
  const numbers = paymentNumbers(order)
  const count = Math.max(1, ...numbers.values())
  return (
    <Card title={moneyPayments(order).length ? `已收 ${count} 笔` : '还没收到钱'}>
      <Descriptions
        row
        size="small"
        style={{ marginBottom: 12 }}
        data={[
          { key: '应收', value: money(order.receivableCents) },
          { key: '已收', value: money(order.paidCents) },
          ...(hasComp(order) ? [{ key: '免单', value: money(order.compCents ?? 0) }] : []),
          {
            key: '还差',
            value: <Typography.Text type="warning">{money(outstandingOf(order))}</Typography.Text>,
          },
        ]}
      />
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        empty="还没有收到钱"
        dataSource={payments}
        columns={[
          {
            title: '第几笔',
            // 会员结账那一笔（储值与随会员结账收的线下款）算一笔
            render: (_: unknown, row: Payment) =>
              row.method === 'comp' ? '免单' : `第 ${numbers.get(row.id) ?? 1} 笔`,
          },
          { title: '时间', dataIndex: 'createdAt', render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap> },
          { title: '方式', render: (_: unknown, row: Payment) => paymentLabel(row) },
          { title: '金额', align: 'right', dataIndex: 'amountCents', render: (value: number) => money(value) },
          {
            title: '实收与找零',
            render: (_: unknown, row: Payment) => <Nowrap>{cashTenderText(row) ?? '—'}</Nowrap>,
          },
        ]}
      />
    </Card>
  )
}
