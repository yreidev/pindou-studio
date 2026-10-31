import { IconPrint, IconSearch } from '@douyinfe/semi-icons'
import {
  Button,
  Checkbox,
  Input,
  Pagination,
  Radio,
  RadioGroup,
  Space,
  Table,
  Tag,
  Typography,
} from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ordersQuery, type Order } from '../../../api/orders'
import { Nowrap } from '../../../components/Nowrap'
import { Page, QueryState } from '../../../components/Page'
import { dateTime, money } from '../../../lib/format'
import {
  customerLabel,
  hasComp,
  isComped,
  isMemberCheckout,
  isPartiallyRefunded,
  isOpen,
  lineSummary,
  orderNumber,
  pageSize,
  parseOrderListSearch,
  statusColors,
  statusFilters,
  statusNames,
  type OrderStatusFilter,
} from '../../../features/orders/orders'
import { useSearchText } from '../../../features/orders/useSearchText'
import { canPrintReceipt } from '../../../features/checkout/receipt'

export const Route = createFileRoute('/_authed/orders/')({
  validateSearch: parseOrderListSearch,
  component: OrdersPage,
})

function OrdersPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  // 筛选、排序、分页都在服务端，这里只取当前这一页
  const orders = useQuery(
    ordersQuery({
      q: search.q,
      status: search.status,
      settlement: search.settlement,
      page: search.page ?? 1,
      pageSize,
    }),
  )
  const filtered = Boolean(search.q || search.status || search.settlement)
  const [text, setText] = useSearchText(
    search.q ?? '',
    (q) =>
      void navigate({ search: (previous) => ({ ...previous, q: q || undefined, page: undefined }), replace: true }),
  )

  const setStatus = (status: OrderStatusFilter | undefined) =>
    void navigate({ search: (previous) => ({ ...previous, status, page: undefined }) })
  const setPage = (page: number) =>
    void navigate({ search: (previous) => ({ ...previous, page: page > 1 ? page : undefined }) })

  return (
    <Page
      title="订单与退款"
      description="查订单、看明细、办理退款（店长、老板；会员结账的订单按原付款比例退回储值与积分，可分多次）。待结账的订单点「去结账」收款（小程序结账页也能收），已付款的可打印小票。"
    >
      <div className="toolbar">
        <Input
          aria-label="查找订单"
          prefix={<IconSearch />}
          showClear
          placeholder="订单编号、商品或服务名称、顾客昵称"
          style={{ width: 320 }}
          value={text}
          onChange={setText}
        />
        <RadioGroup
          type="button"
          aria-label="订单状态"
          value={search.status ?? 'all'}
          onChange={(event) => {
            const value = String(event.target.value)
            setStatus(value === 'all' ? undefined : (value as OrderStatusFilter))
          }}
        >
          <Radio value="all">全部</Radio>
          {/* 「待结账」含部分付款（分笔付款还没收齐的），「部分付款」只看收了一部分的 */}
          {statusFilters.map((filter) => (
            <Radio key={filter.value} value={filter.value}>
              {filter.label}
            </Radio>
          ))}
        </RadioGroup>
        {/* 免单单独可查：对账时和收款分开看 */}
        <Checkbox
          checked={search.settlement === 'comp'}
          onChange={(event) =>
            void navigate({
              search: (previous) => ({
                ...previous,
                settlement: event.target.checked ? ('comp' as const) : undefined,
                page: undefined,
              }),
            })
          }
        >
          只看免单
        </Checkbox>
      </div>
      <QueryState query={orders}>
        {({ rows, page, total }) => {
          return (
            <>
              <Typography.Text type="tertiary">
                {filtered ? `符合条件的订单 ${total} 单` : `共 ${total} 单`}
              </Typography.Text>
              <Table
                style={{ marginTop: 8 }}
                size="small"
                rowKey="id"
                dataSource={rows}
                pagination={false}
                empty={filtered ? '没有符合条件的订单' : '暂无订单'}
                onRow={(row?: Order) => ({
                  onClick: () => {
                    if (row) void navigate({ to: '/orders/$orderId', params: { orderId: row.id } })
                  },
                  style: { cursor: 'pointer' },
                })}
                columns={[
                  {
                    title: '编号',
                    dataIndex: 'id',
                    render: (_: unknown, row: Order) => (
                      <Link
                        to="/orders/$orderId"
                        params={{ orderId: row.id }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {orderNumber(row)}
                      </Link>
                    ),
                  },
                  {
                    title: '创建时间',
                    dataIndex: 'createdAt',
                    render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                  },
                  { title: '顾客', render: (_: unknown, row: Order) => customerLabel(row) },
                  {
                    title: '项目',
                    render: (_: unknown, row: Order) => <div className="cell-wide">{lineSummary(row)}</div>,
                  },
                  {
                    title: '应收',
                    align: 'right',
                    dataIndex: 'receivableCents',
                    render: (value: number) => money(value),
                  },
                  { title: '已付', align: 'right', dataIndex: 'paidCents', render: (value: number) => money(value) },
                  {
                    title: '已退',
                    align: 'right',
                    dataIndex: 'refundedCents',
                    render: (value: number) => (value ? money(value) : '—'),
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    render: (_: unknown, row: Order) => (
                      <Space spacing={4}>
                        <Tag color={statusColors[row.status]}>{statusNames[row.status]}</Tag>
                        {isPartiallyRefunded(row) ? <Tag color="orange">部分退款</Tag> : null}
                        {isMemberCheckout(row) ? <Tag color="violet">会员结账</Tag> : null}
                        {isComped(row) ? (
                          <Tag color="amber">免单</Tag>
                        ) : hasComp(row) ? (
                          <Tag color="amber">部分免单</Tag>
                        ) : null}
                        {row.status === 'partially_paid' && row.outstandingCents !== undefined ? (
                          <Nowrap>
                            <Typography.Text type="warning" size="small">
                              还差 {money(row.outstandingCents)}
                            </Typography.Text>
                          </Nowrap>
                        ) : null}
                      </Space>
                    ),
                  },
                  {
                    title: '操作',
                    render: (_: unknown, row: Order) => <OrderAction order={row} />,
                  },
                ]}
              />
              {total > pageSize ? (
                <Pagination
                  style={{ marginTop: 16, justifyContent: 'flex-end' }}
                  total={total}
                  pageSize={pageSize}
                  currentPage={page}
                  onPageChange={setPage}
                />
              ) : null}
            </>
          )
        }}
      </QueryState>
    </Page>
  )
}

/** 列表行上的快捷入口：待结账、部分付款的去结账（接着收），收齐的打印小票。点它不进详情。 */
function OrderAction({ order }: { order: Order }) {
  const navigate = useNavigate()
  if (isOpen(order))
    return (
      <Button
        size="small"
        theme="solid"
        type="primary"
        onClick={(event) => {
          event.stopPropagation()
          void navigate({ to: '/checkout/$orderId', params: { orderId: order.id } })
        }}
      >
        去结账
      </Button>
    )
  if (canPrintReceipt(order))
    return (
      <Button
        size="small"
        icon={<IconPrint />}
        onClick={(event) => {
          event.stopPropagation()
          void navigate({ to: '/receipt/$orderId', params: { orderId: order.id } })
        }}
      >
        打印小票
      </Button>
    )
  return null
}
