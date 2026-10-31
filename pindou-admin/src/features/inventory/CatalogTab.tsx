import { IconPlus } from '@douyinfe/semi-icons'
import { Banner, Button, Input, Modal, Space, Table, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ApiError } from '../../api/client'
import { catalogItemsQuery, inventoryApi, stockItemsQuery, type CatalogItem } from '../../api/inventory'
import { QueryState } from '../../components/Page'
import { money } from '../../lib/format'
import { catalogDefaults, catalogSchema, toCatalogInput, toCatalogPatch, type CatalogFormValues } from './catalog'
import { errorText } from './errors'
import { Field } from '../../components/Field'
import { KeywordSearch } from './KeywordSearch'
import { catalogRows, type CatalogRow } from './products'
import { askDiscard, useLeaveGuard } from './useLeaveGuard'

const route = getRouteApi('/_authed/inventory')
const pageSize = 20

/** 商品资料：所有员工可看；新增、修改只给店长、老板（后端同样校验）。 */
export function CatalogTab({ canManage }: { canManage: boolean }) {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const catalog = useQuery(catalogItemsQuery())
  const stock = useQuery(stockItemsQuery())
  // null：没在编辑；{ item: undefined }：新增
  const [editing, setEditing] = useState<{ item?: CatalogItem } | null>(null)

  return (
    <>
      <div className="toolbar">
        <KeywordSearch
          value={search.q}
          placeholder="搜商品名称或条码"
          onSearch={(q) => void navigate({ search: (prev) => ({ ...prev, q, page: undefined }), replace: true })}
        />
        {canManage ? (
          <Button icon={<IconPlus />} theme="solid" type="primary" onClick={() => setEditing({})}>
            新增商品
          </Button>
        ) : null}
      </div>
      <QueryState query={catalog}>
        {(items) => {
          const rows = catalogRows(items, stock.data, search.q)
          const lastPage = Math.max(1, Math.ceil(rows.length / pageSize))
          return (
            <Table
              size="small"
              rowKey="id"
              dataSource={rows}
              empty={search.q ? '没有符合条件的商品' : '还没有商品资料'}
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
                  title: '商品名称',
                  dataIndex: 'label',
                  render: (label: string, row: CatalogRow) =>
                    row.named ? (
                      label
                    ) : (
                      <Space>
                        <Typography.Text type="tertiary">{label}</Typography.Text>
                        <Tag size="small">待补名称</Tag>
                      </Space>
                    ),
                },
                {
                  title: '条码',
                  dataIndex: 'barcode',
                  width: 170,
                  render: (barcode: string | undefined) =>
                    barcode ? (
                      <Typography.Text>{barcode}</Typography.Text>
                    ) : (
                      <Typography.Text type="tertiary">—</Typography.Text>
                    ),
                },
                {
                  title: '参考售价',
                  dataIndex: 'unitPriceCents',
                  align: 'right',
                  width: 140,
                  render: (cents: number) => money(cents),
                },
                {
                  title: '当前库存',
                  align: 'right',
                  width: 120,
                  render: (_: unknown, row: CatalogRow) =>
                    row.stock ? row.stock.quantity : <Typography.Text type="tertiary">未入库</Typography.Text>,
                },
                {
                  title: '操作',
                  width: 160,
                  render: (_: unknown, row: CatalogRow) => (
                    <Space spacing={4}>
                      {canManage ? (
                        <Button size="small" theme="borderless" onClick={() => setEditing({ item: row })}>
                          编辑
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        theme="borderless"
                        type="tertiary"
                        onClick={() => void navigate({ search: { tab: 'purchase', product: row.id } })}
                      >
                        入库
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
          )
        }}
      </QueryState>
      {editing ? (
        <CatalogEditor item={editing.item} catalog={catalog.data ?? []} onClose={() => setEditing(null)} />
      ) : null}
    </>
  )
}

function CatalogEditor({
  item,
  catalog,
  onClose,
}: {
  item: CatalogItem | undefined
  catalog: CatalogItem[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [baseline] = useState(() => catalogDefaults(item))
  const schema = useMemo(() => catalogSchema(catalog, item), [catalog, item])

  const save = useMutation({
    mutationFn: (values: CatalogFormValues) =>
      item
        ? inventoryApi.updateCatalogItem(item.id, toCatalogPatch(values, item))
        : inventoryApi.createCatalogItem(toCatalogInput(values)),
    onSuccess: () => {
      Toast.success(item ? '商品资料已保存' : '商品已新增')
      void queryClient.invalidateQueries()
    },
  })

  const form = useForm({
    defaultValues: baseline,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      try {
        await save.mutateAsync(value)
      } catch {
        return // 失败原因显示在弹窗里，输入保留
      }
      onClose()
    },
  })
  const values = useStore(form.store, (state) => state.values)
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline)
  useLeaveGuard(dirty)
  // 条码被别的商品占用（409 barcode_taken，后端说清是哪件）或格式不对：后端的话原样挂在条码这一格上
  const barcodeError =
    save.error instanceof ApiError && (save.error.code === 'barcode_taken' || save.error.code === 'invalid_barcode')
      ? save.error.message
      : ''

  const close = async () => {
    if (!dirty || (await askDiscard())) onClose()
  }

  return (
    <Modal
      visible
      title={item ? '修改商品资料' : '新增商品'}
      maskClosable={false}
      onCancel={() => void close()}
      footer={
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <>
              <Button onClick={() => void close()}>取消</Button>
              <Button
                theme="solid"
                type="primary"
                loading={submitting || save.isPending}
                onClick={() => void form.handleSubmit()}
              >
                保存
              </Button>
            </>
          )}
        </form.Subscribe>
      }
    >
      {save.isError && !barcodeError ? (
        <Banner type="danger" closeIcon={null} description={errorText(save.error)} style={{ marginBottom: 12 }} />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="name">
          {(field) => (
            <Field label="商品名称" required errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  placeholder="例如：珠光豆 5mm 白色"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="price">
          {(field) => (
            <Field
              label="参考售价（元）"
              required
              help="结账时新加这件商品会预填这个价，可以当场改；不会改动已有订单。"
              errors={field.state.meta.errors}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  prefix="¥"
                  placeholder="0.00"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="barcode">
          {(field) => (
            <Field
              label="条码"
              help="可不填。光标放在这一格，用扫码枪扫商品包装上的条码即可；清空就是去掉条码。同一个条码只能对应一件商品。"
              errors={barcodeError ? [...field.state.meta.errors, barcodeError] : field.state.meta.errors}
            >
              {(control) => (
                <Input
                  {...control}
                  placeholder="例如：6901234567892"
                  autoComplete="off"
                  spellCheck={false}
                  value={field.state.value}
                  onChange={(value) => {
                    // 改了条码，上次被拒的原因就不再适用
                    if (barcodeError) save.reset()
                    field.handleChange(value)
                  }}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        {/* 回车提交 */}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
