import { DatePicker, Select, Table, Tag, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import {
  catalogItemsQuery,
  movementKinds,
  stockItemsQuery,
  stockMovementsQuery,
  type MovementKind,
  type StockMovement,
} from '../../api/inventory'
import { Nowrap } from '../../components/Nowrap'
import { QueryState } from '../../components/Page'
import { dateTime } from '../../lib/format'
import { phoneQuery, useMediaQuery } from '../../lib/useMediaQuery'
import { formatDelta } from './fields'
import { movementDetail, movementKindColors, movementKindLabels, movementLabel } from './movements'
import { catalogIndex, productName, stockOptions } from './products'

const route = getRouteApi('/_authed/inventory')
const pageSize = 50

/** 库存流水：时间倒序，按商品、类型、门店日期筛选。只读，流水只追加不改写。 */
export function MovementsTab() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const stock = useQuery(stockItemsQuery())
  const catalog = useQuery(catalogItemsQuery())
  // 筛选、排序、分页都在服务端，只取当前这一页
  const movements = useQuery(
    stockMovementsQuery({
      stockItemId: search.item,
      kind: search.kind,
      from: search.from,
      to: search.to,
      page: search.page ?? 1,
      pageSize,
    }),
  )
  const names = catalogIndex(catalog.data)
  const phone = useMediaQuery(phoneQuery)
  const setDates = (dates: { from?: string; to?: string }) =>
    void navigate({ search: (prev) => ({ ...prev, ...dates, page: undefined }) })

  return (
    <>
      <div className="toolbar">
        <Select
          style={{ width: 260 }}
          filter
          showClear
          placeholder="全部商品"
          aria-label="按商品筛选"
          value={search.item}
          optionList={stockOptions(stock.data, catalog.data)}
          emptyContent="没有匹配的商品"
          onChange={(value) =>
            void navigate({ search: (prev) => ({ ...prev, item: value ? String(value) : undefined, page: undefined }) })
          }
        />
        <Select
          style={{ width: 160 }}
          showClear
          placeholder="全部类型"
          aria-label="按类型筛选"
          value={search.kind}
          optionList={movementKinds.map((kind) => ({ value: kind, label: movementKindLabels[kind] }))}
          onChange={(value) =>
            void navigate({
              search: (prev) => ({ ...prev, kind: (value as MovementKind | undefined) || undefined, page: undefined }),
            })
          }
        />
        {phone ? (
          // 日期范围面板是左右两个月并排，比手机屏宽；手机上改成开始、结束两个单月面板，两个框排在同一行
          <span className="toolbar-field">
            <DatePicker
              type="date"
              format="yyyy-MM-dd"
              placeholder="开始日期"
              aria-label="开始日期"
              style={{ width: 150 }}
              value={search.from}
              onChange={(_, text) => setDates({ from: typeof text === 'string' && text ? text : undefined })}
            />
            <DatePicker
              type="date"
              format="yyyy-MM-dd"
              placeholder="结束日期"
              aria-label="结束日期"
              style={{ width: 150 }}
              value={search.to}
              onChange={(_, text) => setDates({ to: typeof text === 'string' && text ? text : undefined })}
            />
          </span>
        ) : (
          <DatePicker
            type="dateRange"
            format="yyyy-MM-dd"
            placeholder={['开始日期', '结束日期']}
            aria-label="按日期筛选"
            style={{ width: 260 }}
            value={search.from && search.to ? [search.from, search.to] : undefined}
            onChange={(_, text) => {
              const [from, to] = Array.isArray(text) ? text.map(String) : []
              void navigate({
                search: (prev) => ({ ...prev, from: from || undefined, to: to || undefined, page: undefined }),
              })
            }}
          />
        )}
      </div>
      <QueryState query={movements}>
        {(data) => {
          const filtered = Boolean(search.item || search.kind || search.from || search.to)
          return (
            <>
              <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 8 }}>
                {filtered ? `筛选后 ${data.total} 条` : `共 ${data.total} 条`}
                ，按发生时间从新到旧；正数入库，负数出库。
              </Typography.Text>
              <Table
                size="small"
                rowKey="id"
                dataSource={data.rows}
                empty={filtered ? '没有符合条件的流水' : '还没有库存流水'}
                pagination={
                  data.total > pageSize
                    ? {
                        pageSize,
                        total: data.total,
                        currentPage: data.page,
                        onPageChange: (page) =>
                          void navigate({ search: (prev) => ({ ...prev, page: page > 1 ? page : undefined }) }),
                      }
                    : false
                }
                columns={[
                  {
                    title: '时间',
                    dataIndex: 'createdAt',
                    width: 160,
                    render: (value: string) => <Nowrap>{dateTime(value)}</Nowrap>,
                  },
                  {
                    title: '商品',
                    dataIndex: 'productId',
                    render: (productId: string) => productName(names.get(productId), productId),
                  },
                  {
                    title: '类型',
                    dataIndex: 'kind',
                    width: 120,
                    render: (kind: MovementKind, row: StockMovement) => (
                      <Tag color={movementKindColors[kind] ?? 'grey'}>{movementLabel(row)}</Tag>
                    ),
                  },
                  {
                    title: '数量变化',
                    dataIndex: 'quantityDelta',
                    align: 'right',
                    width: 110,
                    render: (delta: number) => (
                      <Typography.Text type={delta > 0 ? 'success' : 'danger'}>{formatDelta(delta)}</Typography.Text>
                    ),
                  },
                  {
                    title: '说明',
                    render: (_: unknown, row: StockMovement) => movementDetail(row) || '—',
                  },
                  {
                    title: '操作人',
                    dataIndex: 'actorName',
                    width: 140,
                    // 早期流水没有记录操作人
                    render: (name?: string) => name || '—',
                  },
                ]}
              />
            </>
          )
        }}
      </QueryState>
    </>
  )
}
