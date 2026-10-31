import { IconDelete, IconPlus } from '@douyinfe/semi-icons'
import { Banner, Button, Card, Input, InputNumber, Table, Tag, Typography } from '@douyinfe/semi-ui'
import { useMemo } from 'react'
import type { CatalogItem } from '../../api/inventory'
import type { Order, OrderLine } from '../../api/orders'
import { errorMessages, Field } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import { money } from '../../lib/format'
import { productOptions } from '../inventory/products'
import { lineName } from '../orders/orders'
import type { LinesForm } from './forms'
import { blankLine, orderLines, productLine } from './lines'
import { TimingNote } from './TimingNote'

// 下拉框里「自定义服务」的值；商品编号都是 UUID，不会撞上
const customValue = 'custom'

/**
 * 订单明细。待结账、又不是套餐订单时可以加商品、改数量和单价、删行，改完先保存再收款；
 * 会员扫码入座的套餐订单按购买快照结算，只读；部分付款（分笔付款收了第一笔）的单明细已冻结，只读。
 */
export function LinesCard({
  order,
  form,
  catalog,
  editable,
  packageOrder,
  disabled,
  dirty,
  saving,
  error,
  errorType = 'danger',
}: {
  order: Order
  form: LinesForm
  catalog: CatalogItem[] | undefined
  editable: boolean
  packageOrder: boolean
  /** 正在提交、或订单已被修改等人重读时，不能再改。 */
  disabled: boolean
  dirty: boolean
  saving: boolean
  /** 上次保存失败的原因（版本冲突由页面顶部统一提示）。 */
  error: string | null
  /** 「上一次其实已经生效」这类不是失败的说明用 warning。 */
  errorType?: 'danger' | 'warning'
}) {
  const options = useMemo(() => productOptions(catalog), [catalog])
  const byId = useMemo(() => new Map((catalog ?? []).map((item) => [item.id, item])), [catalog])

  if (!editable) {
    return (
      <Card title="订单明细">
        <TimingNote order={order} style={{ marginBottom: 12 }} />
        {order.status === 'partially_paid' ? (
          <Banner
            type="info"
            closeIcon={null}
            style={{ marginBottom: 12 }}
            description="已经收了第一笔：明细和金额定在收第一笔时，计时也停在那一刻，不能再改明细、打折或换顾客，接着收下一笔或对剩余免单。"
          />
        ) : packageOrder ? (
          <Banner
            type="info"
            closeIcon={null}
            style={{ marginBottom: 12 }}
            description="这是会员扫码入座的套餐订单：按购买时的套餐快照结算，明细和价格不能改，也不能人工折扣。"
          />
        ) : null}
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
    )
  }

  return (
    <Card title="订单明细">
      {error ? <Banner type={errorType} closeIcon={null} description={error} style={{ marginBottom: 12 }} /> : null}
      <TimingNote order={order} style={{ marginBottom: 12 }} />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!disabled) void form.handleSubmit()
        }}
      >
        <form.Field name="lines" mode="array">
          {(linesField) => (
            <div className="checkout-lines">
              <div className="checkout-line checkout-line-head">
                <Typography.Text type="tertiary">商品或服务</Typography.Text>
                <Typography.Text type="tertiary">名称</Typography.Text>
                <Typography.Text type="tertiary">数量</Typography.Text>
                <Typography.Text type="tertiary">单价（元）</Typography.Text>
                <span />
              </div>
              {linesField.state.value.map((_, index) => (
                <div className="checkout-line" key={index} data-line={index + 1}>
                  {/* 数组字段只在行数变化时重绘，这一格要单独订阅本行的商品编号，换商品后才跟着变 */}
                  <form.Field name={`lines[${index}].productId`}>
                    {(field) => (
                      <Field compact help={field.state.value ? '商品：收款时扣库存' : null}>
                        {(control) => (
                          <NamedSelect
                            {...control}
                            label={`第 ${index + 1} 项商品或服务`}
                            style={{ width: '100%' }}
                            filter
                            disabled={disabled}
                            value={field.state.value || customValue}
                            optionList={[{ value: customValue, label: '自定义服务（不扣库存）' }, ...options]}
                            emptyContent="没有匹配的商品"
                            onChange={(value) => {
                              const item = byId.get(String(value ?? ''))
                              const current = form.getFieldValue(`lines[${index}]`)
                              // 换成商品：名称、单价预填商品资料的；换回自定义服务：名称、单价清空让人重填。数量不动（和小程序一样）
                              const next = item ? productLine(item) : blankLine()
                              form.setFieldValue(`lines[${index}]`, { ...next, quantity: current.quantity })
                            }}
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name={`lines[${index}].name`}>
                    {(field) => (
                      <Field compact errors={field.state.meta.errors}>
                        {(control) => (
                          <Input
                            {...control}
                            aria-label={`第 ${index + 1} 项名称`}
                            placeholder="商品或服务名称"
                            disabled={disabled}
                            value={field.state.value}
                            onChange={(value) => field.handleChange(value)}
                            onBlur={field.handleBlur}
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name={`lines[${index}].quantity`}>
                    {(field) => (
                      <Field compact errors={field.state.meta.errors}>
                        {(control) => (
                          <InputNumber
                            {...control}
                            aria-label={`第 ${index + 1} 项数量`}
                            min={1}
                            step={1}
                            style={{ width: '100%' }}
                            disabled={disabled}
                            value={field.state.value}
                            onChange={(value) => field.handleChange(String(value))}
                            onBlur={field.handleBlur}
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name={`lines[${index}].unitPriceYuan`}>
                    {(field) => (
                      <Field compact errors={field.state.meta.errors}>
                        {(control) => (
                          <Input
                            {...control}
                            aria-label={`第 ${index + 1} 项单价（元）`}
                            inputMode="decimal"
                            prefix="¥"
                            placeholder="0.00"
                            disabled={disabled}
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
                    aria-label={`删除第 ${index + 1} 项`}
                    disabled={disabled}
                    onClick={() => linesField.removeValue(index)}
                  />
                </div>
              ))}
              {!linesField.state.value.length ? (
                <Typography.Text type="tertiary">还没有明细，请添加商品或自定义服务。</Typography.Text>
              ) : null}
              {/* 「至少一项」：一行都没有时没有输入框可挂，直接写出来 */}
              {errorMessages(linesField.state.meta.errors) ? (
                <Typography.Text type="danger" size="small" className="field-error">
                  {errorMessages(linesField.state.meta.errors)}
                </Typography.Text>
              ) : null}
              <div className="checkout-line-actions">
                <NamedSelect
                  label="添加商品"
                  style={{ width: 260 }}
                  filter
                  placeholder="添加商品（可搜索）"
                  disabled={disabled || !options.length}
                  value={undefined}
                  optionList={options}
                  emptyContent="没有匹配的商品"
                  onChange={(value) => {
                    const item = byId.get(String(value ?? ''))
                    if (item) linesField.pushValue(productLine(item))
                  }}
                />
                <Button icon={<IconPlus />} disabled={disabled} onClick={() => linesField.pushValue(blankLine())}>
                  添加自定义服务
                </Button>
              </div>
            </div>
          )}
        </form.Field>

        <div className="checkout-lines-footer">
          {dirty ? (
            <>
              <Typography.Text type="warning">明细已改动，尚未保存。保存后按新明细重新计算应收。</Typography.Text>
              <div className="checkout-actions">
                <Button disabled={saving} onClick={() => form.reset({ lines: orderLines(order) })}>
                  撤销修改
                </Button>
                <Button htmlType="submit" theme="solid" type="primary" loading={saving} disabled={disabled}>
                  保存明细
                </Button>
              </div>
            </>
          ) : (
            <Typography.Text type="tertiary">明细已保存</Typography.Text>
          )}
        </div>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 8 }}>
          计时或服务费请选择自定义服务（不扣库存）；商品在收款时扣减库存，请先登记采购入库。店员按商品资料的售价记账，改价请找店长或老板。
        </Typography.Paragraph>
      </form>
    </Card>
  )
}
