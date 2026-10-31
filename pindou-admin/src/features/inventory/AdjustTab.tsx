import {
  Banner,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  Radio,
  RadioGroup,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { useId, useMemo, useState } from 'react'
import {
  catalogItemsQuery,
  inventoryApi,
  stockItemsQuery,
  type AdjustmentInput,
  type CatalogItem,
  type StockItem,
} from '../../api/inventory'
import { QueryState } from '../../components/Page'
import {
  adjustmentDefaults,
  adjustmentPlan,
  adjustmentRequest,
  adjustmentSchema,
  isStockChanged,
  type AdjustmentMode,
  type AdjustmentPlan,
} from './adjustment'
import { errorText } from './errors'
import { formatDelta } from './fields'
import { Field } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import { stockOptions } from './products'
import { useLeaveGuard } from './useLeaveGuard'
import { confirmDialog } from '../../components/confirm'

const route = getRouteApi('/_authed/inventory')

/** 盘点：只给店长、老板（标签页对店员隐藏，后端同样拒绝）。 */
export function AdjustTab() {
  const search = route.useSearch()
  const stock = useQuery(stockItemsQuery())
  const catalog = useQuery(catalogItemsQuery())
  return (
    <QueryState query={stock}>
      {(items) =>
        items.length ? (
          <AdjustForm
            stock={items}
            catalog={catalog.data}
            initialItem={items.some((item) => item.id === search.item) ? search.item : undefined}
          />
        ) : (
          <Empty title="还没有库存记录" description="商品采购入库后才能盘点。" />
        )
      }
    </QueryState>
  )
}

function confirmAdjustment(
  name: string,
  plan: Extract<AdjustmentPlan, { ok: true }>,
  reason: string,
): Promise<boolean> {
  return confirmDialog({
    title: '确认盘点调整',
    content: (
      <div>
        <div>商品：{name}</div>
        <div>当前库存：{plan.current} 件</div>
        <div>盘点后：{plan.target} 件</div>
        <div>变化量：{formatDelta(plan.delta)}</div>
        <div>原因：{reason}</div>
        <Typography.Text type="tertiary" size="small">
          提交后写入库存流水，不能撤销；录错了只能再盘点一次调回。
        </Typography.Text>
      </div>
    ),
    okText: '确认调整',
  })
}

function AdjustForm({
  stock,
  catalog,
  initialItem,
}: {
  stock: StockItem[]
  catalog: CatalogItem[] | undefined
  initialItem: string | undefined
}) {
  const queryClient = useQueryClient()
  const [baseline, setBaseline] = useState(() => adjustmentDefaults(initialItem))
  const quantities = useMemo(() => new Map(stock.map((item) => [item.id, item.quantity])), [stock])
  const schema = useMemo(() => adjustmentSchema((id) => quantities.get(id)), [quantities])
  const options = useMemo(() => stockOptions(stock, catalog), [stock, catalog])
  const nameOf = (id: string) => options.find((option) => option.value === id)?.label ?? '这个商品'
  // 选中商品时看到的库存；之后接口读到的数不一样（有人结账或入库了），提醒重新核对
  const [seen, setSeen] = useState<number | undefined>(() => (initialItem ? quantities.get(initialItem) : undefined))
  // 原生单选框按 name 分组：不给 name 时 Semi 都叫 default
  const modeGroupName = useId()

  const adjust = useMutation({
    mutationFn: (input: AdjustmentInput) => inventoryApi.adjustStock(input),
    onSuccess: (result, input) => {
      // 调整后的数量用接口返回的，不用前端算的
      Toast.success(`库存已调整：${nameOf(input.stockItemId)} 现为 ${result.quantity} 件`)
      void queryClient.invalidateQueries()
    },
  })

  const form = useForm({
    defaultValues: baseline,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value, formApi }) => {
      const current = quantities.get(value.stockItemId)
      const plan = current === undefined ? null : adjustmentPlan(current, value)
      if (!plan?.ok) return
      const reason = value.reason.trim()
      if (!(await confirmAdjustment(nameOf(value.stockItemId), plan, reason))) return
      try {
        // 带上确认框里的「当前库存」：确认之后有人结账或入库，后端发现对不上就整笔拒绝
        await adjust.mutateAsync(adjustmentRequest(value.stockItemId, plan, reason))
      } catch (error) {
        // 失败原因显示在上方，输入保留。库存变了就重读（等读完再放开提交按钮），
        // 右侧核对与变化量随之按最新库存更新，由人核对后再提交、再确认一次
        if (isStockChanged(error)) await queryClient.invalidateQueries()
        return
      }
      const next = adjustmentDefaults()
      setBaseline(next)
      setSeen(undefined)
      formApi.reset(next)
    },
  })
  const values = useStore(form.store, (state) => state.values)
  useLeaveGuard(JSON.stringify(values) !== JSON.stringify(baseline))

  const current = values.stockItemId ? quantities.get(values.stockItemId) : undefined
  const plan = current === undefined ? null : adjustmentPlan(current, values)
  const selected = stock.find((item) => item.id === values.stockItemId)

  return (
    <div className="adjust-layout">
      <Card title="盘点调整" className="inventory-form">
        {adjust.isError && isStockChanged(adjust.error) ? (
          <Banner
            type="warning"
            closeIcon={null}
            title={errorText(adjust.error)}
            description="这次盘点没有提交。已重新读取库存，右侧的当前库存、盘点后数量和变化量已按最新库存更新；核对实盘数量后再点「提交盘点」重新确认。"
            style={{ marginBottom: 12 }}
          />
        ) : adjust.isError ? (
          <Banner type="danger" closeIcon={null} description={errorText(adjust.error)} style={{ marginBottom: 12 }} />
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <form.Field name="stockItemId">
            {(field) => (
              <Field label="商品" required labelMode="labelledby" errors={field.state.meta.errors}>
                {(control) => (
                  <NamedSelect
                    {...control}
                    label="盘点商品"
                    style={{ width: '100%' }}
                    filter
                    placeholder="选择要盘点的商品（可搜索）"
                    value={field.state.value || undefined}
                    optionList={options}
                    emptyContent="没有匹配的商品"
                    onChange={(value) => {
                      const id = String(value ?? '')
                      field.handleChange(id)
                      setSeen(quantities.get(id))
                    }}
                  />
                )}
              </Field>
            )}
          </form.Field>
          <form.Field name="mode">
            {(field) => (
              <Field label="填写方式" labelMode="radiogroup">
                {() => (
                  <RadioGroup
                    type="button"
                    name={`${modeGroupName}-mode`}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value as AdjustmentMode)}
                  >
                    <Radio value="count">按实盘数量</Radio>
                    <Radio value="delta">按变化量</Radio>
                  </RadioGroup>
                )}
              </Field>
            )}
          </form.Field>
          {values.mode === 'count' ? (
            <form.Field name="counted">
              {(field) => (
                <Field
                  label="实盘数量"
                  required
                  help="数出来的实际件数，系统按「实盘 − 当前库存」提交变化量。"
                  errors={field.state.meta.errors}
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="numeric"
                      suffix="件"
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ) : (
            <form.Field name="delta">
              {(field) => (
                <Field
                  label="变化量"
                  required
                  help="增加填正数，减少填负数，例如 -2。"
                  errors={field.state.meta.errors}
                >
                  {(control) => (
                    <Input
                      {...control}
                      suffix="件"
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          )}
          <form.Field name="reason">
            {(field) => (
              <Field label="调整原因" required errors={field.state.meta.errors}>
                {(control) => (
                  <TextArea
                    {...control}
                    placeholder="例如：月底盘点，破损 3 包"
                    autosize={{ minRows: 2, maxRows: 4 }}
                    maxCount={200}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </Field>
            )}
          </form.Field>
          <div className="form-actions">
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) => (
                <Button htmlType="submit" theme="solid" type="primary" loading={submitting || adjust.isPending}>
                  提交盘点
                </Button>
              )}
            </form.Subscribe>
          </div>
        </form>
      </Card>
      <Card title="核对">
        {selected && current !== undefined ? (
          <>
            {seen !== undefined && seen !== current ? (
              <Banner
                type="warning"
                closeIcon={null}
                style={{ marginBottom: 12 }}
                description={
                  <span>
                    填写期间库存从 {seen} 件变成了 {current}{' '}
                    件（可能刚有结账或入库），变化量已按最新库存重算，请核对实盘数量。{' '}
                    <Button size="small" theme="borderless" onClick={() => setSeen(current)}>
                      已核对
                    </Button>
                  </span>
                }
              />
            ) : null}
            <Descriptions
              className="adjust-preview"
              data={[
                { key: '商品', value: nameOf(selected.id) },
                { key: '当前库存', value: `${current} 件` },
                { key: '预警线', value: `${selected.alertAt} 件` },
                { key: '盘点后', value: plan?.ok ? `${plan.target} 件` : '—' },
                {
                  key: '变化量',
                  value: plan?.ok ? (
                    <Typography.Text type={plan.delta > 0 ? 'success' : 'danger'}>
                      {formatDelta(plan.delta)}
                    </Typography.Text>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
            <Typography.Text type="tertiary" size="small">
              当前库存是系统刚读到的数；盘点后的数量以提交后系统返回为准。
            </Typography.Text>
          </>
        ) : (
          <Typography.Text type="tertiary">选择商品后在这里核对当前库存、盘点后数量和变化量。</Typography.Text>
        )}
      </Card>
    </div>
  )
}
