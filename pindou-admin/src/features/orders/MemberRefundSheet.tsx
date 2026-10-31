import {
  Banner,
  Button,
  Descriptions,
  Input,
  InputNumber,
  SideSheet,
  Spin,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useForm, useStore } from '@tanstack/react-form'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  memberRefundQuoteKey,
  memberRefundQuoteQuery,
  orderQuery,
  ordersApi,
  type MemberRefundInput,
  type MemberRefundQuote,
  type Order,
} from '../../api/orders'
import { money, yuanInput } from '../../lib/format'
import { Field } from '../../components/Field'
import {
  emptyMemberRefundForm,
  memberRefundAmountHint,
  memberRefundBlocker,
  memberRefundFormSchema,
  memberRefundNotes,
  memberRefundQuoteInput,
  memberRefundSummary,
  toMemberRefundInput,
  wholeOnly,
  type MemberRefundFormValues,
} from './member-refund'
import { MemberRefundBlockedNote } from './MemberRefundBlockedNote'
import { memberRefundableCents, orderNumber } from './orders'
import {
  isVersionConflict,
  reasonLength,
  refundErrorMessage,
  restockText,
  returnableProducts,
  returnedCounts,
  returnedTotal,
} from './refund'
import { confirmDialog } from '../../components/confirm'

/**
 * 会员结账单的退款侧边栏：填这次退的金额（「全部退完」填入剩余全部），后端按原付款比例算好这次将退回的线下、
 * 本金、赠送、积分和扣回的消费积分（refund_quote），确认时照预览提交，带预览依据的订单版本。
 * 和普通退款一样：打开那一刻记下订单（base），上限、件数、版本都以它为准；页面上的订单被实时刷新成新版本、
 * 或提交时后端回 409，都只提示「订单已被修改」并保留输入，由员工点「重新读取」核对后再确认，绝不自动换版本重提。
 * 每次打开由父组件换 key 重新挂载。
 */
export function MemberRefundSheet({
  order,
  customer,
  visible,
  onClose,
}: {
  order: Order
  /** 顾客的显示名，确认弹窗里写清退给谁。 */
  customer: string
  visible: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [base, setBase] = useState(order)
  const [conflict, setConflict] = useState(false)
  const stale = order.id === base.id && order.version !== base.version
  const products = useMemo(() => returnableProducts(base), [base])
  const whole = wholeOnly(base)
  // 会员结账那一笔还能退多少（分笔付款时只算会员这一笔，别人付的走普通退款）
  const refundable = memberRefundableCents(base)
  const schema = useMemo(
    () => memberRefundFormSchema({ refundableCents: refundable, wholeOnly: whole, products }),
    [refundable, whole, products],
  )
  const blocker = memberRefundBlocker(base)
  const changed = conflict || stale

  const refund = useMutation({
    mutationFn: (input: MemberRefundInput) => ordersApi.memberRefund(input),
    onSuccess: () => {
      Toast.success('会员退款已办理')
      void queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => {
      if (isVersionConflict(error)) setConflict(true)
      // 别的原因被拒（多半是预览之后顾客又用掉了积分，扣回不够了）：按同一版本重新预览，让预览跟着说明现在能退多少
      else void queryClient.invalidateQueries({ queryKey: memberRefundQuoteKey(base.id) })
    },
  })

  const reread = useMutation({
    mutationFn: () => queryClient.fetchQuery({ ...orderQuery(base.id), staleTime: 0 }),
    onSuccess: (latest) => {
      setBase(latest)
      setConflict(false)
      refund.reset()
    },
  })

  const form = useForm({
    defaultValues: emptyMemberRefundForm(),
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      // 只按停手后、和输入框一致的那份预览提交
      if (!quoted || !quote.data || typing || quote.data.blocked || blocker) return
      const input = toMemberRefundInput(quoted, quote.data, value, products)
      const preview = quote.data
      const confirmed = await confirmDialog({
        title: preview.settlesOrder ? '确认会员退款（退完剩余全部）' : '确认会员退款',
        content: (
          <div>
            <div>
              订单 {orderNumber(base)} · {customer}
            </div>
            <div>退款金额 {money(preview.amountCents)}</div>
            <div>这次将退回：{memberRefundSummary(preview)}</div>
            <ul style={{ margin: '8px 0', paddingInlineStart: 20 }}>
              {memberRefundNotes(preview, base).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <div>{restockText(input.returnedProducts ?? {}, products)}</div>
            <div>原因：{input.reason}</div>
            <Typography.Text type="tertiary" size="small">
              办理后不能撤销；退款记录与冲正流水都会留下。
            </Typography.Text>
          </div>
        ),
        okText: '确认退款',
        okType: 'danger',
      })
      if (!confirmed) return
      try {
        await refund.mutateAsync(input)
      } catch {
        // 失败原因显示在表单上方；冲突时保留输入等员工重读
      }
    },
  })

  // ---- 预览：金额停手 300ms 再问后端这次将退回什么 ----
  const amountText = useStore(form.store, (state) => state.values.amount)
  const [debouncedAmount] = useDebouncedValue(amountText, { wait: 300 })
  const typing = !whole && debouncedAmount !== amountText
  const quoted = blocker ? null : memberRefundQuoteInput(base, debouncedAmount)
  const quote = useQuery({
    ...memberRefundQuoteQuery(quoted ?? { targetId: base.id, expectedVersion: base.version }),
    enabled: quoted !== null && !changed,
  })
  const quoteConflict = quote.isError && isVersionConflict(quote.error)
  const blocked = changed || quoteConflict || blocker !== null

  const close = () => {
    const values: MemberRefundFormValues = form.state.values
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

  const ready = quoted !== null && !typing && quote.data !== undefined && !quote.data.blocked && !quote.isFetching

  return (
    <SideSheet
      title={`会员退款 · 订单 ${orderNumber(base)}`}
      visible={visible}
      width={560}
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
                  disabled={blocked || typing || (quoted !== null && !ready)}
                  loading={submitting || refund.isPending}
                  onClick={() => void form.handleSubmit()}
                >
                  {total ? `会员退款并回补 ${total} 件` : '会员退款（不回补库存）'}
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
          { key: '顾客', value: customer },
          { key: '已付', value: money(base.paidCents) },
          { key: '已退', value: money(base.refundedCents) },
          { key: refundable === base.refundableCents ? '本单还可退' : '会员这一笔还可退', value: money(refundable) },
        ]}
        style={{ marginBottom: 16 }}
      />

      {blocker ? <Banner type="warning" closeIcon={null} description={blocker} style={{ marginBottom: 16 }} /> : null}

      {changed || quoteConflict ? (
        <Banner
          type="warning"
          closeIcon={null}
          title="订单已被修改"
          description={
            <div>
              <div>
                可能有人同时办理了退款。你填写的内容已保留，请重新读取，核对最新的可退金额和将退回的数后再确认。
              </div>
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
        {whole ? (
          <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
            这张单全用积分抵扣，实付 ¥0.00，没有金额可分，只能整单退：抵扣的积分全部退回原批次。
          </Typography.Paragraph>
        ) : (
          <form.Field name="amount">
            {(field) => (
              <Field
                label="这次退款金额（元）"
                required
                help={
                  <>
                    最多 {money(refundable)}，按原付款比例拆到线下、储值和积分。
                    <Button
                      theme="borderless"
                      size="small"
                      disabled={blocker !== null}
                      onClick={() => field.handleChange(yuanInput(refundable))}
                    >
                      全部退完
                    </Button>
                  </>
                }
                errors={field.state.meta.errors}
              >
                {(props) => (
                  <Input
                    {...props}
                    aria-label="这次退款金额（元）"
                    prefix="¥"
                    placeholder="例如 50 或 49.90"
                    disabled={blocker !== null}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </Field>
            )}
          </form.Field>
        )}

        <QuotePreview
          order={base}
          quote={quote.data}
          loading={quoted !== null && !changed && (typing || quote.isFetching)}
          error={quote.isError && !quoteConflict ? refundErrorMessage(quote.error) : null}
          hint={blocker || whole || quoted !== null ? null : memberRefundAmountHint(debouncedAmount, refundable)}
          onUseMax={(cents) => form.setFieldValue('amount', yuanInput(cents))}
        />

        {products.length ? (
          <div style={{ marginBottom: 8 }}>
            <Typography.Text strong>退回并可再售的件数</Typography.Text>
            <div>
              <Typography.Text type="tertiary" size="small">
                默认 0，不回补库存。和退款金额无关：退服务费、或材料拆封后不能再卖的不要填——钱退了不等于货回了。
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
                  placeholder="必须填写，例如：顾客临时有事未做、作品返工"
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
          储值与积分由系统按原流水退回、扣回；线下部分的钱按原付款方式退还顾客。按比例该扣回的消费积分已被顾客用掉时，系统会拒绝并说明缺多少。
        </Typography.Text>
      </form>
    </SideSheet>
  )
}

/** 这次将退回什么：后端预览的原数，不在前端推算；积分收不回时说明缺口和现在最多能退多少。 */
function QuotePreview({
  order,
  quote,
  loading,
  error,
  hint,
  onUseMax,
}: {
  order: Order
  quote: MemberRefundQuote | undefined
  loading: boolean
  error: string | null
  /** 还没填出合法的金额时的提示。 */
  hint: string | null
  onUseMax: (cents: number) => void
}) {
  if (hint)
    return (
      <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
        {hint}
      </Typography.Paragraph>
    )
  if (error) return <Banner type="danger" closeIcon={null} description={error} style={{ marginBottom: 16 }} />
  if (!quote)
    return loading ? (
      <div style={{ marginBottom: 16 }}>
        <Spin size="small" /> <Typography.Text type="tertiary">正在计算这次将退回的数…</Typography.Text>
      </div>
    ) : null
  // 改金额后、新预览回来之前，旧的数仍显示，用 Spin 盖住，免得照着旧数确认
  const max = quote.blocked?.maxRefundableCents ?? 0
  return (
    <div style={{ marginBottom: 16 }}>
      <Spin spinning={loading} tip="正在重新计算…">
        {quote.blocked ? (
          <MemberRefundBlockedNote
            blocked={quote.blocked}
            title={`这次退 ${money(quote.amountCents)} 要扣回 ${quote.pointsClawedBack.toLocaleString('zh-CN')} 积分，还缺 ${quote.blocked.pointsShort.toLocaleString('zh-CN')} 分`}
            action={
              max > 0 ? (
                <Button size="small" style={{ marginTop: 8 }} onClick={() => onUseMax(max)}>
                  改为现在最多能退的 {money(max)}
                </Button>
              ) : null
            }
          />
        ) : (
          // 金额改了、预览跟着变时读屏软件会念出新的数
          <div role="status" aria-label="这次将退回">
            <Typography.Text strong>这次将退回：{memberRefundSummary(quote)}</Typography.Text>
            <ul style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
              {memberRefundNotes(quote, order).map((note) => (
                <li key={note}>
                  <Typography.Text type="tertiary" size="small">
                    {note}
                  </Typography.Text>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Spin>
    </div>
  )
}
