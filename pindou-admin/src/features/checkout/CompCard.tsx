import { Banner, Button, Card, TextArea, Toast, Typography } from '@douyinfe/semi-ui'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { checkoutApi } from '../../api/checkout'
import { isPreviousApplied } from '../../api/client'
import type { Order } from '../../api/orders'
import { Field } from '../../components/Field'
import { confirmDialog } from '../../components/confirm'
import { money } from '../../lib/format'
import { compAmount, compBlocker, compConfirmContent, compFormSchema, compReasonLimit } from './comp'
import { checkoutErrorMessage, isOrderConflict } from './payment'

/**
 * 免单（店长、老板）：这一单不收钱、直接结清，必须写原因，确认后不能改回、免掉的部分不能退款。
 * 分笔付款收了一部分的单是「对剩余免单」：免掉的是还差的数，收到的钱照常记着。
 * 免掉的是这一版订单还差的数（带读到的版本）；订单被改过、别人刚收了一笔或计时费随时间变了（409）交给结账页提示重读，输入保留。
 */
export function CompCard({
  order,
  disabled,
  dirty,
  conflict,
  onComped,
  onConflict,
}: {
  order: Order
  /** 结账页正在提交别的请求。 */
  disabled: boolean
  /** 明细改过还没保存。 */
  dirty: boolean
  /** 订单已被修改，要先重新读取。 */
  conflict: boolean
  onComped: (order: Order) => void
  onConflict: () => void
}) {
  const comp = useMutation({
    mutationFn: (input: { reason: string; expectedVersion: string }) => checkoutApi.comp(order.id, input),
    onSuccess: (comped) => {
      onComped(comped)
      Toast.success(
        comped.paidCents > 0
          ? `已对剩余免单 ${money(comped.compCents ?? 0)}，已收 ${money(comped.paidCents)}`
          : `已免单 ${money(comped.compCents ?? comped.receivableCents)}`,
      )
    },
    onError: (error) => {
      if (isOrderConflict(error)) onConflict()
    },
  })
  const form = useForm({
    defaultValues: { reason: '' },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: compFormSchema },
    onSubmit: async ({ value }) => {
      const reason = value.reason.trim()
      const ok = await confirmDialog({
        variant: 'warning',
        title: remainder ? `对剩余 ${money(compAmount(order))} 免单？` : `免单 ${money(compAmount(order))}？`,
        content: compConfirmContent(order, reason),
        okText: '确认免单',
        okType: 'danger',
      })
      if (!ok) return
      try {
        await comp.mutateAsync({ reason, expectedVersion: order.version })
      } catch {
        // 失败原因显示在卡片上，原因保留
      }
    },
  })

  const blocker = compBlocker({ order, dirty, conflict })
  // 分笔付款收了一部分：免的是剩下没付的部分
  const remainder = order.status === 'partially_paid'
  const locked = disabled || comp.isPending || Boolean(blocker)
  // 失败说明只对当时那一版订单有效；版本冲突由结账页顶部统一提示
  const failure =
    comp.isError && comp.variables?.expectedVersion === order.version && !isOrderConflict(comp.error)
      ? checkoutErrorMessage(comp.error, '免单')
      : null

  return (
    <Card title={remainder ? '对剩余免单' : '免单'}>
      {failure ? (
        <Banner
          type={isPreviousApplied(comp.error) ? 'warning' : 'danger'}
          closeIcon={null}
          description={failure}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!locked) void form.handleSubmit()
        }}
      >
        <form.Field name="reason">
          {(field) => (
            <Field
              label="免单原因"
              required
              help={
                remainder
                  ? `剩下没付的 ${money(compAmount(order))} 不收了、直接结清：记为免单，免掉的部分不能退款；已收的 ${money(order.paidCents)} 照常记账。`
                  : '这一单不收钱、直接结清：应收照旧记账，记为免单，实收 0，不能退款。和人工折扣不同，折扣不能把应收减到 0。'
              }
              errors={field.state.meta.errors}
            >
              {(control) => (
                <TextArea
                  {...control}
                  autosize={{ minRows: 2, maxRows: 4 }}
                  maxCount={compReasonLimit}
                  placeholder="例如：老顾客生日，店长同意免单"
                  disabled={disabled || comp.isPending}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <Button htmlType="submit" type="danger" loading={comp.isPending} disabled={locked}>
          {remainder ? '对剩余免单' : '免单结清'}
        </Button>
        {blocker ? (
          <Typography.Text type="tertiary" size="small" className="field-help">
            {blocker}
          </Typography.Text>
        ) : null}
      </form>
    </Card>
  )
}
