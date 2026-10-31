import {
  Banner,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Radio,
  RadioGroup,
  SideSheet,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useState } from 'react'
import { orderQuery, ordersApi, type Order, type RefundInput } from '../../api/orders'
import { money, yuanInput } from '../../lib/format'
import { Field } from '../../components/Field'
import { orderNumber, refundablePayments } from './orders'
import {
  emptyRefundForm,
  initialRefundPayment,
  isVersionConflict,
  refundChoiceText,
  reasonLength,
  refundErrorMessage,
  refundFormSchema,
  restockText,
  returnableProducts,
  returnedCounts,
  returnedTotal,
  toRefundInput,
  type RefundFormValues,
} from './refund'
import { confirmDialog } from '../../components/confirm'

/**
 * 办理退款的侧边栏。打开那一刻记下订单（base），金额与件数上限、提交带的 expectedVersion 都以它为准；
 * 页面上的订单被实时刷新成新版本、或提交时后端回 409，都只提示「订单已被修改」并保留输入，
 * 由员工点「重新读取」核对后再确认，绝不自动换版本重提。
 * 每次打开由父组件换 key 重新挂载，所以 base 就是打开时的订单。
 *
 * 按笔退（分笔付款、多人合付）：先选退哪一笔现金、微信、支付宝付款（只有一笔能退时直接是它），金额上限是这一笔还可退的；
 * 会员结账那一笔走会员退款，免单那一笔不能退，都不在这里列。paymentId 是页面上点「退这笔」时指定的那一笔。
 */
export function RefundSheet({
  order,
  paymentId,
  visible,
  onClose,
}: {
  order: Order
  paymentId?: string
  visible: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [base, setBase] = useState(order)
  const [conflict, setConflict] = useState(false)
  // 页面上的订单已经是新版本（别人同时退了款、实时刷新到了），这张表单的上限就不可信了
  const stale = order.id === base.id && order.version !== base.version
  const products = useMemo(() => returnableProducts(base), [base])
  const choices = useMemo(() => refundablePayments(base), [base])
  const [selected, setSelected] = useState(() => initialRefundPayment(choices, paymentId))
  const [pickMissing, setPickMissing] = useState(false)
  const choice = choices.find((item) => item.payment.id === selected)
  const limit = choice?.refundableCents ?? 0
  const paymentGroupName = useId()
  // 还没选哪一笔时不按金额拦（提交时先提示选哪一笔）
  const schema = useMemo(
    () => refundFormSchema({ refundableCents: choice ? limit : Number.MAX_SAFE_INTEGER, products }),
    [choice, limit, products],
  )

  const refund = useMutation({
    mutationFn: (input: RefundInput) => ordersApi.refund(base.id, input),
    onSuccess: () => {
      Toast.success('退款已登记')
      void queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => {
      if (isVersionConflict(error)) setConflict(true)
    },
  })

  const reread = useMutation({
    mutationFn: () => queryClient.fetchQuery({ ...orderQuery(base.id), staleTime: 0 }),
    onSuccess: (latest) => {
      setBase(latest)
      setConflict(false)
      // 选过的那一笔还能退就留着，退完了（别人刚退过）就重新选
      setSelected((previous) => initialRefundPayment(refundablePayments(latest), previous))
      refund.reset()
    },
  })

  const form = useForm({
    defaultValues: emptyRefundForm(),
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (!choice) {
        setPickMissing(true)
        return
      }
      // 接口给了这一笔的可退（现在的后端都给）就带上是哪一笔；重放旧响应没给时只有一笔收到的钱，不用带
      const input = toRefundInput(
        value,
        products,
        choice.payment.refundableCents !== undefined ? choice.payment.id : undefined,
      )
      const counts = input.returnedProducts ?? {}
      const picked = refundChoiceText(choice)
      const confirmed = await confirmDialog({
        title: '确认登记退款',
        content: (
          <div>
            <div>订单 {orderNumber(base)}</div>
            <div>退哪一笔：{picked.title}</div>
            <div>退款金额：{money(input.amountCents)}</div>
            <div>{restockText(counts, products)}</div>
            <div>原因：{input.reason}</div>
            <Typography.Text type="tertiary" size="small">
              系统只登记退款，钱按原付款方式线下退还顾客。
            </Typography.Text>
          </div>
        ),
        okText: '确认退款',
        okType: 'danger',
      })
      if (!confirmed) return
      try {
        await refund.mutateAsync({ ...input, expectedVersion: base.version })
      } catch {
        // 失败原因显示在表单上方；冲突时保留输入等员工重读
      }
    },
  })

  const blocked = conflict || stale

  const close = () => {
    const values: RefundFormValues = form.state.values
    const dirty =
      values.amount.trim() !== '' ||
      values.reason.trim() !== '' ||
      Object.values(values.returned).some((count) => count.trim() !== '' && count.trim() !== '0')
    if (!dirty || refund.isPending) {
      if (!refund.isPending) onClose()
      return
    }
    // 会丢掉填写的内容：确认按钮用危险样式
    void confirmDialog({
      title: '放弃这次退款？',
      content: '填写的金额、件数和原因不会保存。',
      okText: '放弃',
      cancelText: '继续填写',
      okType: 'danger',
    }).then((ok) => {
      if (ok) onClose()
    })
  }

  return (
    <SideSheet
      title={`办理退款 · 订单 ${orderNumber(base)}`}
      visible={visible}
      width={520}
      onCancel={close}
      closeOnEsc
      maskClosable={false}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={close} disabled={refund.isPending}>
            取消
          </Button>
          <form.Subscribe selector={(state) => [state.values.returned, state.isSubmitting] as const}>
            {([returned, submitting]) => {
              const total = returnedTotal(returnedCounts(returned, products))
              return (
                <Button
                  theme="solid"
                  type="danger"
                  disabled={blocked || choices.length === 0}
                  loading={submitting || refund.isPending}
                  onClick={() => void form.handleSubmit()}
                >
                  {total ? `登记退款并回补 ${total} 件` : '登记退款（不回补库存）'}
                </Button>
              )
            }}
          </form.Subscribe>
        </div>
      }
    >
      <Descriptions
        row
        size="small"
        data={[
          { key: '已付', value: money(base.paidCents) },
          { key: '已退', value: money(base.refundedCents) },
          { key: '本单还可退', value: money(base.refundableCents) },
        ]}
        style={{ marginBottom: 16 }}
      />

      {blocked ? (
        <Banner
          type="warning"
          closeIcon={null}
          title="订单已被修改"
          description={
            <div>
              <div>可能有人同时办理了退款。你填写的内容已保留，请重新读取，核对最新的可退金额和件数后再确认。</div>
              <Button size="small" style={{ marginTop: 8 }} loading={reread.isPending} onClick={() => reread.mutate()}>
                重新读取
              </Button>
              {reread.isError ? (
                <div>
                  <Typography.Text type="danger" size="small">
                    {reread.error.message}
                  </Typography.Text>
                </div>
              ) : null}
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {refund.isError && !isVersionConflict(refund.error) ? (
        <Banner
          type="danger"
          closeIcon={null}
          description={refundErrorMessage(refund.error)}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!blocked) void form.handleSubmit()
        }}
      >
        {choices.length > 1 ? (
          // 分几笔收的单：按笔选，每笔最多退这笔金额减已退
          <Field
            label="退哪一笔"
            labelMode="radiogroup"
            required
            help="分几笔收的单按笔退，每笔最多退这笔还可退的；会员结账那一笔请用会员退款。"
            errors={pickMissing && !choice ? ['请选择退哪一笔'] : undefined}
          >
            {() => (
              <RadioGroup
                type="card"
                direction="vertical"
                name={`${paymentGroupName}-payment`}
                value={selected}
                onChange={(event) => {
                  setSelected(String(event.target.value))
                  setPickMissing(false)
                }}
              >
                {choices.map((item) => {
                  const text = refundChoiceText(item)
                  return (
                    <Radio key={item.payment.id} value={item.payment.id} extra={text.extra} style={{ width: '100%' }}>
                      {text.title}
                    </Radio>
                  )
                })}
              </RadioGroup>
            )}
          </Field>
        ) : choice ? (
          <Typography.Paragraph style={{ marginBottom: 16 }}>
            退的是：{refundChoiceText(choice).title}（{refundChoiceText(choice).extra}）
          </Typography.Paragraph>
        ) : (
          <Banner
            type="warning"
            closeIcon={null}
            description="这张订单没有还能按普通退款退的付款：会员结账那一笔请用会员退款，免单那一笔没有收到钱。"
            style={{ marginBottom: 16 }}
          />
        )}
        <form.Field name="amount">
          {(field) => (
            <Field
              label="退款金额（元）"
              required
              help={
                <>
                  这一笔最多 {money(limit)}。
                  <Button
                    theme="borderless"
                    size="small"
                    disabled={!choice}
                    onClick={() => field.handleChange(yuanInput(limit))}
                  >
                    填入全部可退
                  </Button>
                </>
              }
              errors={field.state.meta.errors}
            >
              {(props) => (
                <Input
                  {...props}
                  aria-label="退款金额（元）"
                  prefix="¥"
                  placeholder="例如 50 或 49.90"
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>

        {products.length ? (
          <div style={{ marginBottom: 8 }}>
            <Typography.Text strong>退回并可再售的件数</Typography.Text>
            <div>
              <Typography.Text type="tertiary" size="small">
                默认 0，不回补库存。退服务费、或材料拆封后不能再卖的不要填——金额退了不等于货回了。
              </Typography.Text>
            </div>
          </div>
        ) : (
          <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
            本单没有可以退回库存的商品（只有服务费，或商品已全部退回），这次退款不回补库存。
          </Typography.Paragraph>
        )}
        {products.map((product) => (
          <form.Field key={product.productId} name={`returned.${product.productId}`}>
            {(field) => (
              <Field
                label={`${product.name}（售出 ${product.sold} 件${product.returned ? `，已退回 ${product.returned} 件` : ''}，还可退 ${product.remaining} 件）`}
                errors={field.state.meta.errors}
              >
                {(props) => (
                  <InputNumber
                    {...props}
                    aria-label={`${product.name} 退回件数`}
                    min={0}
                    step={1}
                    placeholder="0"
                    style={{ width: 160 }}
                    value={field.state.value ?? ''}
                    onChange={(value) => field.handleChange(String(value))}
                    onBlur={field.handleBlur}
                  />
                )}
              </Field>
            )}
          </form.Field>
        ))}

        <form.Field name="reason">
          {(field) => (
            <Field label="退款原因" required errors={field.state.meta.errors}>
              {(props) => (
                <TextArea
                  {...props}
                  aria-label="退款原因"
                  placeholder="必须填写，例如：未拆封退货、服务未提供"
                  maxCount={200}
                  getValueLength={reasonLength}
                  autosize={{ minRows: 2, maxRows: 5 }}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <Typography.Text type="tertiary" size="small">
          系统只登记退款记录，钱按原付款方式线下退还顾客（见订单的付款记录）。
        </Typography.Text>
      </form>
    </SideSheet>
  )
}
