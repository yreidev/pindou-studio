import { Button, Checkbox, Space, Table, Tag, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { catalogItemsQuery, stockItemsQuery } from '../../api/inventory'
import { QueryState } from '../../components/Page'
import { AlertCell } from './AlertCell'
import { KeywordSearch } from './KeywordSearch'
import { stockRows, type StockRow } from './products'

const route = getRouteApi('/_authed/inventory')
const pageSize = 20

/** 库存：商品、当前数量、预警线、是否偏低。搜索与「只看预警」、页码都在网址里。店长、老板可就地改预警线。 */
export function StockTab({ canManage }: { canManage: boolean }) {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const stock = useQuery(stockItemsQuery())
  const catalog = useQuery(catalogItemsQuery())
  // 正在改预警线的库存项目；同一时间只改一行
  const [editingAlert, setEditingAlert] = useState<string | null>(null)

  return (
    <>
      <div className="toolbar">
        <KeywordSearch
          value={search.q}
          placeholder="搜商品名称或条码"
          onSearch={(q) => void navigate({ search: (prev) => ({ ...prev, q, page: undefined }), replace: true })}
        />
        <Checkbox
          checked={Boolean(search.low)}
          onChange={(event) =>
            void navigate({
              search: (prev) => ({ ...prev, low: event.target.checked || undefined, page: undefined }),
            })
          }
        >
          只看预警
        </Checkbox>
      </div>
      <QueryState query={stock}>
        {(items) => {
          // 商品资料读失败时仍显示库存，只是名称退回「未命名商品 · 编号」
          const rows = stockRows(items, catalog.data, { keyword: search.q, lowOnly: search.low })
          const lowCount = items.filter((item) => item.lowStock).length
          const lastPage = Math.max(1, Math.ceil(rows.length / pageSize))
          return (
            <>
              <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 8 }}>
                共 {items.length} 种商品有库存记录，其中 {lowCount} 种不高于预警线
                {search.q || search.low ? `；筛选后 ${rows.length} 种` : ''}
              </Typography.Text>
              <Table
                size="small"
                rowKey="id"
                dataSource={rows}
                empty={search.q || search.low ? '没有符合条件的商品' : '还没有库存记录，采购入库后会出现在这里'}
                pagination={
                  rows.length > pageSize
                    ? {
                        pageSize,
                        currentPage: Math.min(search.page ?? 1, lastPage),
                        onPageChange: (page) =>
                          void navigate({ search: (prev) => ({ ...prev, page: page > 1 ? page : undefined }) }),
                      }
                    : false
                }
                columns={[
                  {
                    title: '商品',
                    dataIndex: 'name',
                    render: (name: string, row: StockRow) =>
                      row.named ? name : <Typography.Text type="tertiary">{name}</Typography.Text>,
                  },
                  {
                    title: '条码',
                    dataIndex: 'barcode',
                    width: 170,
                    render: (barcode: string | undefined) =>
                      barcode ? barcode : <Typography.Text type="tertiary">—</Typography.Text>,
                  },
                  { title: '当前数量', dataIndex: 'quantity', align: 'right', width: 120 },
                  {
                    title: '预警线',
                    dataIndex: 'alertAt',
                    align: 'right',
                    width: canManage ? 250 : 100,
                    render: (_: number, row: StockRow) => (
                      <AlertCell
                        key={row.id}
                        row={row}
                        canManage={canManage}
                        editing={editingAlert === row.id}
                        onEdit={() => setEditingAlert(row.id)}
                        onDone={() => setEditingAlert(null)}
                      />
                    ),
                  },
                  {
                    title: '状态',
                    dataIndex: 'lowStock',
                    width: 110,
                    render: (low: boolean) => (low ? <Tag color="red">库存偏低</Tag> : <Tag color="green">正常</Tag>),
                  },
                  {
                    title: '操作',
                    width: 220,
                    render: (_: unknown, row: StockRow) => (
                      <Space spacing={4}>
                        <Button
                          size="small"
                          theme="borderless"
                          onClick={() => void navigate({ search: { tab: 'purchase', product: row.productId } })}
                        >
                          入库
                        </Button>
                        {canManage ? (
                          <Button
                            size="small"
                            theme="borderless"
                            onClick={() => void navigate({ search: { tab: 'adjust', item: row.id } })}
                          >
                            盘点
                          </Button>
                        ) : null}
                        <Button
                          size="small"
                          theme="borderless"
                          type="tertiary"
                          onClick={() => void navigate({ search: { tab: 'movements', item: row.id } })}
                        >
                          流水
                        </Button>
                      </Space>
                    ),
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
