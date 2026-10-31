import { IconDelete, IconPlus } from '@douyinfe/semi-icons'
import { Banner, Button, Card, Empty, Input, Toast, Typography } from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  catalogItemsQuery,
  inventoryApi,
  purchasePrefillQuery,
  stockItemsQuery,
  type CatalogItem,
  type PurchaseInput,
  type StockItem,
} from '../../api/inventory'
import { QueryState } from '../../components/Page'
import { money } from '../../lib/format'
import { errorText } from './errors'
import { Field } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import { isBarcode, useScanRelay } from '../../realtime/scans'
import { catalogIndex, findByBarcode, productFilter, productName, productOptions } from './products'
import {
  addScannedProduct,
  emptyPurchaseLine,
  lastCosts,
  prefillPurchase,
  purchaseDefaults,
  purchaseSchema,
  toPurchaseInput,
  unitCostAfterProductChange,
} from './purchase'
import { useLeaveGuard } from './useLeaveGuard'
import { confirmDialog } from '../../components/confirm'

const route = getRouteApi('/_authed/inventory')

/** 采购入库：所有员工都能登记（店员也在网页录采购），后端校验权限与内容。 */
export function PurchaseTab({ canManage }: { canManage: boolean }) {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const catalog = useQuery(catalogItemsQuery())
  const stock = useQuery(stockItemsQuery())

  return (
    <QueryState query={catalog}>
      {(items) =>
        items.length ? (
          <PurchaseForm
            catalog={items}
            stock={stock.data}
            initialProduct={items.some((item) => item.id === search.product) ? search.product : undefined}
          />
        ) : (
          <Empty
            title="还没有商品资料"
            description={
              canManage
                ? '先在「商品资料」里新增商品，再登记采购入库。'
                : '请店长或老板先在「商品资料」里新增商品，再登记采购入库。'
            }
          >
            {canManage ? (
              <Button onClick={() => void navigate({ search: { tab: 'catalog' } })}>去新增商品</Button>
            ) : null}
          </Empty>
        )
      }
    </QueryState>
  )
}

function confirmPurchase(input: PurchaseInput, catalog: Map<string, CatalogItem>): Promise<boolean> {
  return confirmDialog({
    title: '确认采购入库',
    width: 520,
    content: (
      <div>
        <div>供应商：{input.supplierName}</div>
        {input.note ? <div>备注：{input.note}</div> : null}
        <ul style={{ paddingLeft: 20, margin: '8px 0' }}>
          {input.items.map((item) => (
            <li key={item.productId}>
              {productName(catalog.get(item.productId), item.productId)}：入库 {item.quantity} 件，单价{' '}
              {money(item.unitCostCents)}
            </li>
          ))}
        </ul>
        <Typography.Text type="tertiary" size="small">
          提交后库存立即增加并记入流水，不能删除；录错了请店长或老板盘点调整。
        </Typography.Text>
      </div>
    ),
    okText: '确认入库',
  })
}

function PurchaseForm({
  catalog,
  stock,
  initialProduct,
}: {
  catalog: CatalogItem[]
  stock: StockItem[] | undefined
  initialProduct: string | undefined
}) {
  const queryClient = useQueryClient()
  // 判断「有没有没提交的输入」的基准：从库存表点「入库」进来时预选的商品不算输入
  const [baseline, setBaseline] = useState(() => purchaseDefaults(initialProduct))
  const names = useMemo(() => catalogIndex(catalog), [catalog])
  const options = useMemo(() => productOptions(catalog), [catalog])
  // 名称包含，或正好是条码（扫码枪对着搜索框扫一下再回车就选中那件）
  const filterProducts = useMemo(() => productFilter(catalog), [catalog])
  const stockByProduct = useMemo(() => new Map((stock ?? []).map((item) => [item.productId, item])), [stock])
  // 上次的供应商和进价由后端给；读不到就不预填，照常手填
  const prefill = useQuery(purchasePrefillQuery())
  const costs = useMemo(() => lastCosts(prefill.data), [prefill.data])
  // 表单开始的时刻（打开页面为 0，提交成功清空后为清空的时刻）：只用这之后读到的预填值套一次，
  // 清空后要等入库后的重读，拿到的才是刚用过的供应商；套过之后为 null，员工清空的格不会被再填回去
  const prefillAfter = useRef<number | null>(0)

  const receive = useMutation({
    mutationFn: (input: PurchaseInput) => inventoryApi.receiveStock(input),
    onSuccess: () => {
      Toast.success('采购入库成功')
      void queryClient.invalidateQueries()
    },
  })

  const form = useForm({
    defaultValues: baseline,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: purchaseSchema },
    onSubmit: async ({ value, formApi }) => {
      const input = toPurchaseInput(value)
      if (!(await confirmPurchase(input, names))) return
      try {
        await receive.mutateAsync(input)
      } catch {
        return // 失败原因显示在表单上方，输入保留，改好或直接重试（同内容沿用同一个幂等键）
      }
      const next = purchaseDefaults()
      prefillAfter.current = Date.now()
      setBaseline(next)
      formApi.reset(next)
    },
  })
  const values = useStore(form.store, (state) => state.values)
  useLeaveGuard(JSON.stringify(values) !== JSON.stringify(baseline))

  // 手机「扫码给电脑」转来的商品条码（2026-10-06）：认得的商品加进明细（已有的那一行数量 +1），
  // 没登记的条码只提示；会员码之类不是条码的不认领，交给全站提示
  useScanRelay((code) => {
    if (!isBarcode(code)) return false
    const product = findByBarcode(catalog, code)
    if (!product) {
      Toast.warning(`条码 ${code.trim()} 还没登记到商品，请店长或老板在「商品资料」里登记后再扫`)
      return true
    }
    const added = addScannedProduct(form.state.values.lines, product.id, costs)
    form.setFieldValue('lines', added.lines)
    const name = productName(product, product.id)
    Toast.success(
      added.merged ? `「${name}」数量 +1（第 ${added.index + 1} 行）` : `已加入「${name}」（第 ${added.index + 1} 行）`,
    )
    return true
  })

  useEffect(() => {
    const since = prefillAfter.current
    if (since === null || !prefill.data || prefill.dataUpdatedAt < since) return
    prefillAfter.current = null
    const current = form.state.values
    const next = prefillPurchase(current, prefill.data)
    if (next.supplierName !== current.supplierName) form.setFieldValue('supplierName', next.supplierName)
    next.lines.forEach((line, index) => {
      if (line.unitCost !== current.lines[index].unitCost) form.setFieldValue(`lines[${index}].unitCost`, line.unitCost)
    })
    // 预填进来的不算员工的输入，离开时不用确认
    setBaseline((base) => prefillPurchase(base, prefill.data))
  }, [form, prefill.data, prefill.dataUpdatedAt])

  return (
    <Card title="登记采购入库" className="inventory-form">
      {receive.isError ? (
        <Banner type="danger" closeIcon={null} description={errorText(receive.error)} style={{ marginBottom: 12 }} />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="supplierName">
          {(field) => (
            <Field label="供应商" required errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  placeholder="例如：义乌豆子批发"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="note">
          {(field) => (
            <Field label="备注" errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  placeholder="选填，例如发票号、到货情况"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>

        <form.Field name="lines" mode="array">
          {(linesField) => (
            // 整张明细是一组：标题与「至少一行」这类错误挂在组上，每一格自己的错误挂在那一格上
            <Field label="采购明细" required labelMode="group" errors={linesField.state.meta.errors}>
              {() => (
                <div className="purchase-lines">
                  <div className="purchase-line purchase-line-head">
                    <Typography.Text type="tertiary">商品</Typography.Text>
                    <Typography.Text type="tertiary">数量（件）</Typography.Text>
                    <Typography.Text type="tertiary">采购单价（元）</Typography.Text>
                    <span />
                  </div>
                  {linesField.state.value.map((_, index) => (
                    <div className="purchase-line" key={index} data-line={index + 1}>
                      <form.Field name={`lines[${index}].productId`}>
                        {(field) => {
                          const current = field.state.value ? stockByProduct.get(field.state.value) : undefined
                          const cost = field.state.value ? costs.get(field.state.value) : undefined
                          return (
                            <Field
                              compact
                              help={
                                field.state.value
                                  ? `${current ? `当前库存 ${current.quantity} 件` : '还没入过库'}${
                                      cost === undefined ? '' : ` · 上次进价 ${money(cost)}`
                                    }`
                                  : null
                              }
                              errors={field.state.meta.errors}
                            >
                              {(control) => (
                                <NamedSelect
                                  {...control}
                                  label={`第 ${index + 1} 行商品`}
                                  style={{ width: '100%' }}
                                  filter={filterProducts}
                                  placeholder="选择商品（可搜名称或扫条码）"
                                  value={field.state.value || undefined}
                                  optionList={options}
                                  emptyContent="没有匹配的商品"
                                  onChange={(value) => {
                                    const next = String(value ?? '')
                                    const unitCost = form.getFieldValue(`lines[${index}].unitCost`)
                                    // 进价空着（或还是上一件商品预填的）就填这件商品上次的进价，员工填过的不动
                                    const nextCost = unitCostAfterProductChange(
                                      unitCost,
                                      field.state.value,
                                      next,
                                      costs,
                                    )
                                    field.handleChange(next)
                                    if (nextCost !== unitCost) form.setFieldValue(`lines[${index}].unitCost`, nextCost)
                                  }}
                                />
                              )}
                            </Field>
                          )
                        }}
                      </form.Field>
                      <form.Field name={`lines[${index}].quantity`}>
                        {(field) => (
                          <Field compact errors={field.state.meta.errors}>
                            {(control) => (
                              <Input
                                {...control}
                                aria-label={`第 ${index + 1} 行数量`}
                                inputMode="numeric"
                                value={field.state.value}
                                onChange={(value) => field.handleChange(value)}
                                onBlur={field.handleBlur}
                              />
                            )}
                          </Field>
                        )}
                      </form.Field>
                      <form.Field name={`lines[${index}].unitCost`}>
                        {(field) => (
                          <Field compact errors={field.state.meta.errors}>
                            {(control) => (
                              <Input
                                {...control}
                                aria-label={`第 ${index + 1} 行单价`}
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
                      <Button
                        type="danger"
                        theme="borderless"
                        icon={<IconDelete />}
                        aria-label={`删除第 ${index + 1} 行`}
                        disabled={linesField.state.value.length <= 1}
                        onClick={() => linesField.removeValue(index)}
                      />
                    </div>
                  ))}
                  <div>
                    <Button icon={<IconPlus />} onClick={() => linesField.pushValue(emptyPurchaseLine())}>
                      再加一种商品
                    </Button>
                  </div>
                </div>
              )}
            </Field>
          )}
        </form.Field>

        <div className="form-actions">
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button htmlType="submit" theme="solid" type="primary" loading={submitting || receive.isPending}>
                登记入库
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </Card>
  )
}
