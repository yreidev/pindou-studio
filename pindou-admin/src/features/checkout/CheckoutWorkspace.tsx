import { Banner, Button, Card, Input, Radio, RadioGroup, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useStore } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { useCurrentAccount } from '../../account'
import {
  checkoutApi,
  quoteQuery,
  venueSessionQuery,
  type DiscountInput,
  type OfflineMethod,
  type OrderLineInput,
} from '../../api/checkout'
import { isPreviousApplied } from '../../api/client'
import { catalogItemsQuery } from '../../api/inventory'
import { loyaltyAccountQuery } from '../../api/members'
import { orderQuery, type Order } from '../../api/orders'
import type { ListedAccount } from '../../api/staff'
import { Field } from '../../components/Field'
import { Page } from '../../components/Page'
import { dateTime, money } from '../../lib/format'
import { useLeaveGuard } from '../inventory/useLeaveGuard'
import { customerLabel, discountText, orderNumber, statusColors, statusNames } from '../orders/orders'
import { customerChangeBlocker, customerChangedText } from './customer'
import { CustomerCard } from './CustomerCard'
import { CollectedPayments } from './CollectedPayments'
import { canComp } from './comp'
import { CompCard } from './CompCard'
import { canDiscount, discountDirty, discountZeroesOrder, zeroReceivableMessage } from './discount'
import { DiscountCard } from './DiscountCard'
import { useDiscountForm, useLinesForm } from './forms'
import { hasUnsavedLines, orderLines } from './lines'
import { LinesCard } from './LinesCard'
import { MemberCard } from './MemberCard'
import { PaidSummary } from './PaidSummary'
import { useMemberScan } from './useMemberScan'
import {
  amountDue,
  cashTender,
  checkoutErrorMessage,
  collectAmount,
  collectedText,
  defaultMethod,
  isLoyaltyConflict,
  isMemberCheckoutStep,
  isOrderConflict,
  memberCollectProblem,
  offlineMethods,
  parseBalanceCap,
  parsePoints,
  paymentBlocker,
  payButtonText,
} from './payment'
import './checkout.css'
import { confirmDialog } from '../../components/confirm'

/**
 * 一次收款请求的内容：会员结账（第一笔）按报价确认，其余按这一笔的金额登记。版本都是员工确认时看到的那一版。
 * 会员结账只收一部分线下补付时带 offlineCents（分笔付款，余下的之后接着收）。
 */
interface PayRequest {
  expectedVersion: string
  method: OfflineMethod
  member?: { quoteVersion: string; points: number; useBalance: boolean; balanceCents?: number; offlineCents?: number }
  amountCents: number
  /** 现金时选填的实收现金（整数分），后端据此记找零。 */
  cashReceivedCents?: number
}

/**
 * 结账页，规则照搬小程序结账页（pages/staff/checkout）：
 * - 订单是表单初值：打开时记下（base），之后的写请求都带这一版的 version；实时刷新到别处改过的新版本、
 *   或提交回 409，都只提示「订单已被修改」并保留输入，由员工重新读取、核对后再确认，绝不自动换版本重提；
 * - 写请求的幂等键由接口客户端管：同样内容重试沿用旧键，内容（含版本）变了换新键；
 * - 改明细先保存，人工折扣与收款都在保存后的明细上由后端算；页面上的金额全部来自接口；
 * - 一单可以分几笔收（多人合付）：每笔金额默认还差的全部、可以改小；收了第一笔没收齐时订单是部分付款，明细冻结只读，
 *   页面列出已收的几笔和还差多少，接着「收下一笔」，店长、老板也可以对剩余免单。
 */
export function CheckoutWorkspace({
  latest,
  latestUpdatedAt,
  back,
}: {
  /** 查询里最新的订单（实时事件会让它重读）。 */
  latest: Order
  latestUpdatedAt: number
  back: ReactNode
}) {
  const queryClient = useQueryClient()
  const me = useCurrentAccount()
  const [base, setBase] = useState(latest)
  // 采用 base 时查询里那份订单的读取时刻：查询在这之后又读到不同的版本，说明别处改了这张单
  const [acceptedAt, setAcceptedAt] = useState(latestUpdatedAt)
  const [conflict, setConflict] = useState(false)
  const stale = latest.id === base.id && latest.version !== base.version && latestUpdatedAt > acceptedAt
  const blocked = conflict || stale
  const draft = base.status === 'draft'
  // 分笔付款收了一部分：明细冻结，只能接着收下一笔或对剩余免单
  const partial = base.status === 'partially_paid'
  // 这一笔走会员结账：关联了顾客、还没收过钱（会员结账只能是第一笔）
  const member = isMemberCheckoutStep(base)

  const catalog = useQuery({ ...catalogItemsQuery(), enabled: draft })
  const session = useQuery({
    ...venueSessionQuery(base.venueSessionId ?? ''),
    enabled: draft && Boolean(base.venueSessionId),
  })
  // 会员扫码入座的套餐会话：订单按购买快照结算，后端拒绝改明细和打折，这里提前说明、不给入口。
  // 会话还没读到时先不给改（免得套餐单先闪出可编辑的明细）；读失败就照常给，后端照样会拦
  const packageOrder = Boolean(session.data?.admissionId)
  const sessionPending = Boolean(base.venueSessionId) && session.isPending
  const editable = !packageOrder && !sessionPending
  const discountAllowed = canDiscount(me) && editable

  // ---- 会员抵扣：积分输入停手 300ms 再报价 ----
  const [pointsText, setPointsText] = useState('0')
  const [useBalance, setUseBalance] = useState(false)
  const [debouncedPoints] = useDebouncedValue(pointsText, { wait: 300 })
  const points = parsePoints(debouncedPoints)
  const typing = debouncedPoints !== pointsText
  const pointsError = parsePoints(pointsText) === null ? '积分须为不小于 0 的整数' : null
  // 这次用多少储值（元）：会员只用储值付自己那份时填，空着就是能用多少用多少；同样停手 300ms 再报价
  const [balanceText, setBalanceText] = useState('')
  const [debouncedBalance] = useDebouncedValue(balanceText, { wait: 300 })
  const balanceCap = useBalance ? parseBalanceCap(debouncedBalance) : {}
  const balanceTyping = useBalance && debouncedBalance !== balanceText
  const balanceError = useBalance ? (parseBalanceCap(balanceText).error ?? null) : null
  const quote = useQuery({
    ...quoteQuery(base, points ?? 0, useBalance, balanceCap.cents),
    enabled: member && draft && points !== null && !balanceCap.error && !blocked,
  })
  const memberAssets = useQuery({ ...loyaltyAccountQuery(base.accountId ?? ''), enabled: member && draft })
  const [requoted, setRequoted] = useState(false)

  const [method, setMethod] = useState<OfflineMethod>(defaultMethod)
  // 这一笔收多少（元）：空着就是全部（还差的数，会员结账是报价的线下补付）；多人分开付时填这一笔的金额
  const [amountText, setAmountText] = useState('')
  // 现金时选填的实收现金（元）：切到微信、支付宝时不带，切回来还在
  const [cashText, setCashText] = useState('')
  // 原生单选框按 name 分组：Semi 的单选组不给 name 时都叫 default，同一页上两组会被浏览器当成一组
  const methodGroupName = useId()

  // ---- 顾客账户：选了谁还没确认（离开保护要知道）；版本冲突后保留，重新读取后由员工再确认 ----
  const [customerEditing, setCustomerEditing] = useState(false)
  const [customerChoice, setCustomerChoice] = useState<ListedAccount | null>(null)

  /** 换成接口给的新订单（自己写成功、或重新读取）：明细表单回到这一版，冲突解除。 */
  const adopt = (order: Order) => {
    setBase(order)
    setAcceptedAt(latestUpdatedAt)
    setConflict(false)
    linesForm.reset({ lines: orderLines(order) })
  }
  /** 自己的写请求成功：页面换成响应里的订单，再让全部查询重读（库存、会员资产等会跟着变）。 */
  const accept = (order: Order) => {
    adopt(order)
    queryClient.setQueryData(orderQuery(order.id).queryKey, order)
    void queryClient.invalidateQueries()
  }

  const saveLines = useMutation({
    mutationFn: ({ lines, expectedVersion }: { lines: OrderLineInput[]; expectedVersion: string }) =>
      checkoutApi.saveLines(base.id, lines, expectedVersion),
    onSuccess: (order) => {
      accept(order)
      Toast.success('明细已保存，请核对金额')
    },
    onError: (error) => {
      if (isOrderConflict(error)) setConflict(true)
    },
  })
  const discount = useMutation({
    mutationFn: async (input: DiscountInput) => {
      // 会把应收减到 0 的折扣先拦下：应收为 0 收不了款，整单不收钱要用免单（后端也拒绝）
      if (discountZeroesOrder(input, base.receivableCents)) throw new Error(zeroReceivableMessage)
      return checkoutApi.discount(base.id, input)
    },
    onSuccess: (order) => {
      accept(order)
      Toast.success('折扣已应用')
    },
    onError: (error) => {
      if (isOrderConflict(error)) setConflict(true)
    },
  })
  const pay = useMutation({
    mutationFn: async (request: PayRequest): Promise<Order> => {
      if (request.member) {
        const result = await checkoutApi.memberCheckout({
          targetId: base.id,
          expectedVersion: request.expectedVersion,
          quoteVersion: request.member.quoteVersion,
          points: request.member.points,
          useBalance: request.member.useBalance,
          balanceCents: request.member.balanceCents,
          method: request.method,
          cashReceivedCents: request.cashReceivedCents,
          offlineCents: request.member.offlineCents,
        })
        return result.order
      }
      return checkoutApi.pay(base.id, {
        method: request.method,
        amountCents: request.amountCents,
        expectedVersion: request.expectedVersion,
        cashReceivedCents: request.cashReceivedCents,
      })
    },
    onMutate: () => setRequoted(false),
    onSuccess: (order) => {
      accept(order)
      // 没收齐（部分付款）：下一笔从还差的全部开始，实收重新填
      setAmountText('')
      setCashText('')
      Toast.success(collectedText(order))
    },
    onError: async (error, request) => {
      if (isOrderConflict(error)) {
        setConflict(true)
        return
      }
      if (!request.member || !isLoyaltyConflict(error)) return
      // 会员结账被拒（会员资产或权益在报价后变了、订单变了、余额积分或库存不足）：先核对订单还是不是这一版，
      // 是就重算报价，让员工核对新金额后再确认（和小程序一样）；订单变了就提示重读
      const fresh = await queryClient.fetchQuery({ ...orderQuery(base.id), staleTime: 0 }).catch(() => undefined)
      if (fresh && fresh.version !== request.expectedVersion) {
        setConflict(true)
        return
      }
      const again = await queryClient
        .fetchQuery({
          ...quoteQuery(base, request.member.points, request.member.useBalance, request.member.balanceCents),
          staleTime: 0,
        })
        .catch(() => undefined)
      setRequoted(Boolean(again && again.version !== request.member.quoteVersion))
    },
  })
  const setCustomer = useMutation({
    mutationFn: ({ accountId, expectedVersion }: { accountId: string | null; expectedVersion: string }) =>
      checkoutApi.setCustomer(base.id, { accountId, expectedVersion }),
    onSuccess: (order, { accountId }) => {
      const before = base.accountId
      accept(order)
      setCustomerEditing(false)
      setCustomerChoice(null)
      // 新顾客从「不用积分、不用余额」重新报价（报价绑着订单版本，换人后旧报价作废）
      setPointsText('0')
      setUseBalance(false)
      setBalanceText('')
      setRequoted(false)
      Toast.success(customerChangedText(before, accountId))
    },
    onError: (error) => {
      if (isOrderConflict(error)) setConflict(true)
    },
  })
  const reread = useMutation({
    mutationFn: () => queryClient.fetchQuery({ ...orderQuery(base.id), staleTime: 0 }),
    onSuccess: adopt,
  })

  const linesForm = useLinesForm(orderLines(base), (lines) =>
    saveLines.mutateAsync({ lines, expectedVersion: base.version }),
  )
  const discountForm = useDiscountForm((input) => discount.mutateAsync({ ...input, expectedVersion: base.version }))
  const lines = useStore(linesForm.store, (state) => state.values.lines)
  const discountValues = useStore(discountForm.store, (state) => state.values)
  const linesDirty = draft && hasUnsavedLines(base, lines)
  useLeaveGuard(draft && (linesDirty || discountDirty(discountValues) || (customerEditing && customerChoice !== null)))

  const busy = saveLines.isPending || discount.isPending || pay.isPending || reread.isPending || setCustomer.isPending
  // 失败原因只对当时那一版订单有效：重读、保存成功后旧的失败说明自然不再显示；版本冲突由页面顶部统一提示
  const failure = (
    mutation: { error: unknown; isError: boolean },
    version: string | undefined,
    what: string,
  ): string | null =>
    mutation.isError && version === base.version && !isOrderConflict(mutation.error)
      ? checkoutErrorMessage(mutation.error, what)
      : null
  // 报价失败（积分不够整份、超过上限、断网等）：照后端的说明显示，改积分、余额会重算，也可以点「重新计算」
  const quoteError = member && quote.isError && !isOrderConflict(quote.error) ? quote.error.message : null
  // 这一笔最多收多少（会员结账是报价的线下补付，其余是还差的数）；金额空着就是它
  const due = amountDue(base, quote.data)
  const dueCents = linesDirty || !due ? null : due.cents
  // 会员单由余额和积分付清（线下补付 0）时没有线下款要收，不给填金额
  const collecting = !(due && due.cents === 0)
  const amount = collecting ? collectAmount(amountText, dueCents, member) : dueCents === null ? {} : { cents: dueCents }
  const thisCents = amount.error ? null : (amount.cents ?? null)
  const amountProblem =
    amount.error ?? (member ? memberCollectProblem(quote.data, thisCents ?? undefined) : null) ?? undefined
  // 现金才填实收；这一笔不收线下款（0）时没有现金要收。找零按这一笔算
  const cashing = method === 'cash' && collecting && thisCents !== 0
  const cash = cashing ? cashTender(cashText, linesDirty ? null : thisCents) : {}
  const blocker = paymentBlocker({
    order: base,
    dirty: linesDirty,
    conflict: blocked,
    quote: quote.data,
    quoting: typing || balanceTyping || quote.isFetching,
    memberProblem:
      pointsError ?? balanceError ?? (quoteError ? '会员优惠算不出来，请先按提示修改积分或余额' : undefined),
    amountProblem,
    cashProblem: cash.error,
  })
  const payError = failure(pay, pay.variables?.expectedVersion, '收款')
  // 上一次没收到结果的同一操作其实已经生效、这次没提交（见 api/client.ts）：不是失败，用提醒的样子
  const failureType = (mutation: { error: unknown }) => (isPreviousApplied(mutation.error) ? 'warning' : 'danger')
  const customerBlocker = customerChangeBlocker({
    order: base,
    packageOrder,
    sessionPending,
    dirty: linesDirty,
    conflict: blocked,
  })
  // 手机「扫码给电脑」转来的会员码：打开「顾客账户」并选好这位，员工核对后再确认
  useMemberScan({
    enabled: draft,
    blocker: customerBlocker,
    current: base.accountId,
    onChoose: (account) => {
      setCustomerEditing(true)
      setCustomerChoice(account)
    },
  })

  const submitPayment = () => {
    if (busy || blocker || thisCents === null) return
    if (member) {
      if (!quote.data || points === null) return
      pay.mutate({
        expectedVersion: base.version,
        method,
        amountCents: thisCents,
        member: {
          quoteVersion: quote.data.version,
          points,
          useBalance,
          balanceCents: balanceCap.cents,
          // 收全部时不带，和以前一样一次收齐；少收时带上，余下的之后分笔收
          offlineCents: thisCents < quote.data.offlineCents ? thisCents : undefined,
        },
        cashReceivedCents: cash.receivedCents,
      })
    } else {
      pay.mutate({
        expectedVersion: base.version,
        method,
        amountCents: thisCents,
        cashReceivedCents: cash.receivedCents,
      })
    }
  }

  const askReread = () => {
    if (!linesDirty) {
      reread.mutate()
      return
    }
    // 会替换掉没保存的明细：确认按钮用危险样式
    void confirmDialog({
      title: '重新读取订单',
      content: '当前未保存的明细修改将被替换。读取后请核对明细和金额。',
      okText: '重新读取',
      okType: 'danger',
    }).then((ok) => {
      if (ok) reread.mutate()
    })
  }

  return (
    <Page
      title={`结账 · 订单 ${orderNumber(base)}`}
      description={`${dateTime(base.createdAt)} · ${customerLabel(base)}`}
      extra={
        <>
          <Tag color={statusColors[base.status]}>{statusNames[base.status]}</Tag>
          {back}
        </>
      }
    >
      {blocked ? (
        <Banner
          type="warning"
          closeIcon={null}
          fullMode={false}
          title="订单已被修改"
          style={{ marginBottom: 16 }}
          description={
            <div>
              <div>
                {conflict
                  ? '提交时发现这张订单已经变了（有人改了明细、换了顾客、打了折或已收款，或计时费随时间进了下一块）。你填写的内容已保留，请重新读取，核对明细和金额后再确认。'
                  : '这张订单刚有了变化（别处改了明细、换了顾客、打了折或已收款，或计时费随时间进了下一块）。请重新读取，核对后再操作。'}
              </div>
              <Button size="small" style={{ marginTop: 8 }} loading={reread.isPending} onClick={askReread}>
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
        />
      ) : null}

      {!draft && !partial ? (
        <PaidSummary order={base} />
      ) : (
        <div className="checkout-grid">
          <div className="checkout-column">
            <LinesCard
              order={base}
              form={linesForm}
              catalog={catalog.data}
              editable={editable && draft}
              packageOrder={packageOrder}
              disabled={busy || blocked}
              dirty={linesDirty}
              saving={saveLines.isPending}
              error={failure(saveLines, saveLines.variables?.expectedVersion, '保存明细')}
              errorType={failureType(saveLines)}
            />
          </div>
          <div className="checkout-column">
            {partial ? <CollectedPayments order={base} /> : null}
            {draft ? (
              <CustomerCard
                order={base}
                packageOrder={packageOrder}
                editing={customerEditing}
                choice={customerChoice}
                blocker={customerBlocker}
                disabled={busy}
                saving={setCustomer.isPending}
                error={failure(setCustomer, setCustomer.variables?.expectedVersion, '更换顾客')}
                errorType={failureType(setCustomer)}
                onEdit={() => setCustomerEditing(true)}
                onChoice={setCustomerChoice}
                onCancel={() => {
                  setCustomerEditing(false)
                  setCustomerChoice(null)
                }}
                onSubmit={(accountId) => setCustomer.mutate({ accountId, expectedVersion: base.version })}
              />
            ) : null}
            {member ? (
              <MemberCard
                order={base}
                member={memberAssets}
                points={pointsText}
                onPoints={setPointsText}
                pointsError={pointsError}
                useBalance={useBalance}
                onUseBalance={setUseBalance}
                balance={balanceText}
                onBalance={setBalanceText}
                balanceError={balanceError}
                quote={quote}
                quoteError={quoteError}
                onRequote={() => void quote.refetch()}
                linesDirty={linesDirty}
                disabled={busy || blocked}
              />
            ) : null}
            {discountAllowed && draft ? (
              <DiscountCard
                form={discountForm}
                disabled={busy || blocked}
                linesDirty={linesDirty}
                applying={discount.isPending}
                receivableCents={base.receivableCents}
                error={failure(discount, discount.variables?.expectedVersion, '折扣')}
                errorType={failureType(discount)}
              />
            ) : null}
            {canComp(me) ? (
              <CompCard
                order={base}
                disabled={busy}
                dirty={linesDirty}
                conflict={blocked}
                onComped={accept}
                onConflict={() => setConflict(true)}
              />
            ) : null}
            <Card title={partial ? '收下一笔' : '收款登记'}>
              {base.discounts?.length ? (
                <div className="checkout-discounts">
                  {base.discounts.map((item) => (
                    <Typography.Text key={item.id} type="tertiary">
                      已减免 · {discountText(item)} · {item.reason}
                    </Typography.Text>
                  ))}
                </div>
              ) : null}
              <Field label="线下收款方式" labelMode="radiogroup" help="核实实际到账后再确认，此操作只登记收款。">
                {() => (
                  <RadioGroup
                    type="button"
                    name={`${methodGroupName}-method`}
                    disabled={busy || blocked}
                    value={method}
                    onChange={(event) => setMethod(event.target.value as OfflineMethod)}
                  >
                    {offlineMethods.map((item) => (
                      <Radio key={item.value} value={item.value}>
                        {item.label}
                      </Radio>
                    ))}
                  </RadioGroup>
                )}
              </Field>
              {collecting ? (
                // 分笔付款（多人合付）：空着就是全部；填了是这一笔的金额，余下的之后接着收
                <Field
                  label={member ? '这次收的线下款（元）' : partial ? '这一笔收多少（元）' : '收款金额（元）'}
                  errors={amount.error ? [amount.error] : undefined}
                  help={
                    member
                      ? '空着就是报价的线下补付全部。会员这一笔可以少收或填 0（用了储值时），余下的之后由别人分笔付；积分只按会员这一笔收到的钱送。'
                      : '空着就是还差的全部。几个人分开付时填这一笔的金额，余下的之后接着收。'
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      prefix="¥"
                      placeholder={dueCents === null ? '金额' : `全部 ${money(dueCents)}`}
                      style={{ width: 200 }}
                      disabled={busy || blocked}
                      value={amountText}
                      onChange={setAmountText}
                    />
                  )}
                </Field>
              ) : null}
              {cashing ? (
                // 输入框下面那行（填错的原因、应找零或说明）挂在输入框上，读屏聚焦输入框时一起念
                <Field
                  label="实收现金（元）"
                  errors={cash.error ? [cash.error] : undefined}
                  help={
                    cash.error ? null : cash.changeCents !== undefined ? (
                      <Typography.Text strong>应找零 {money(cash.changeCents)}</Typography.Text>
                    ) : (
                      '填了就按它算找零，和实收一起记在付款记录上、印在小票上；不填只登记收款金额。'
                    )
                  }
                >
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="decimal"
                      prefix="¥"
                      placeholder="选填，顾客给的现金"
                      style={{ width: 200 }}
                      disabled={busy || blocked}
                      value={cashText}
                      onChange={setCashText}
                    />
                  )}
                </Field>
              ) : null}

              <div className="checkout-due">
                <Typography.Text>{linesDirty ? '应收（保存明细后显示）' : (due?.label ?? '线下补付')}</Typography.Text>
                <Typography.Title heading={3} style={{ margin: 0 }} className="checkout-due-amount">
                  {linesDirty || !due ? '—' : money(due.cents)}
                </Typography.Title>
              </div>
              {member && due && due.cents === 0 && !linesDirty ? (
                <Typography.Text type="tertiary" size="small" className="field-help">
                  本单由储值余额和积分付清，不用再收线下款。
                </Typography.Text>
              ) : null}
              {payError ? (
                <Banner
                  type={failureType(pay)}
                  closeIcon={null}
                  style={{ margin: '12px 0' }}
                  description={
                    requoted
                      ? `${payError.replace(/[。.]$/, '')}。会员优惠已按最新情况重新计算，金额有变化，请核对后再确认收款。`
                      : payError
                  }
                />
              ) : null}
              <Button
                block
                theme="solid"
                type="primary"
                size="large"
                style={{ marginTop: 12 }}
                loading={pay.isPending}
                disabled={busy || Boolean(blocker)}
                onClick={submitPayment}
              >
                {pay.isPending
                  ? '正在提交'
                  : member && collecting && thisCents === 0
                    ? '确认会员结账（这次不收线下款）'
                    : payButtonText(linesDirty || thisCents === null ? null : { cents: thisCents })}
              </Button>
              {blocker ? (
                <Typography.Text type="tertiary" size="small" className="field-help">
                  {blocker}
                </Typography.Text>
              ) : null}
            </Card>
          </div>
        </div>
      )}
    </Page>
  )
}
