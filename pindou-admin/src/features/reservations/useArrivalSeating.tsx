import { Banner, Modal, Typography } from '@douyinfe/semi-ui'
import type { UseMutationResult } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useBillingEnabled } from '../../api/billing'
import { boardApi, type PackageRule, type ReservationEntry } from '../../api/board'
import { isPreviousApplied } from '../../api/client'
import type { ListedAccount } from '../../api/staff'
import { confirmDialog, dialogButtons } from '../../components/confirm'
import { CustomerPicker } from '../../components/CustomerPicker'
import { couponText } from '../../lib/coupon'
import { seatingPlan, type SeatingPlan } from '../board/board'
import { useBoardAction, type BoardTask } from '../board/useBoardAction'
import { arrivalStartText } from './reservations'

/**
 * 到店开台（按预约的套餐开按座计时）：「现场」看板的即将到店和「预约」页共用这一套。
 * - 有账户的预约：确认框写后端实际会用的现行套餐（名称、时长，系统内收费开着时还有价格），和预约时不一样另起一行说明，
 *   套餐停用了不给开；预约里记了团购的写出来，店员先验券；
 *   请求用调用方的 action 发，失败原因由调用方显示在操作旁边。
 * - 散客预约（代客登记、没有账户）：计时和结账都要绑定账户，先在弹窗里选到店顾客的账户；请求单独一份，
 *   失败时弹窗不关、原因写在弹窗里，选好的顾客不丢。
 * 返回 start（点「到店开台」时调用）和要放进页面里的弹窗。
 */
export function useArrivalSeating({
  action,
  packages,
  placeOf,
  now,
}: {
  action: UseMutationResult<unknown, Error, BoardTask>
  /** 现行发布的计时套餐：到店开台按它计时计价，确认框照它写。 */
  packages: PackageRule[]
  /** 这条预约的座位怎么写（「A3」「D1 · 整桌」）。 */
  placeOf: (entry: ReservationEntry) => string
  /** 此刻（页面每隔一会儿换一次）：开始时间是今天的只写时分。 */
  now: number
}): { start: (entry: ReservationEntry) => void; dialog: ReactNode } {
  const bind = useBoardAction()
  const billing = useBillingEnabled()
  // 关的时候只关 visible，预约留到关闭动画结束再清
  const [binding, setBinding] = useState<ReservationEntry | null>(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [customer, setCustomer] = useState<ListedAccount | null>(null)

  const done = (entry: ReservationEntry) => `${placeOf(entry)} 已到店开台，开始计时`
  // 确认框写后端实际会用的套餐（现行发布的那一版），不写预约时记下的快照；套餐停用了就说清楚、不给开
  const confirmSeat = (entry: ReservationEntry) => {
    const plan = seatingPlan(entry, packages, billing)
    void confirmDialog({
      title: '到店开台',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text>
            {arrivalStartText(entry.reservation.startAt, now)} · {placeOf(entry)} · {entry.customerName || '顾客'}
          </Typography.Text>
          <SeatingPlanText plan={plan} />
          <CouponNote entry={entry} />
          {entry.displayStatus === 'pending' ? (
            <Typography.Text type="warning">
              这条预约还没确认，开台就算到店了，不再给顾客发「预约成功」通知。
            </Typography.Text>
          ) : null}
        </div>
      ),
      okText: '到店开台',
      okDisabled: !plan.pkg,
    }).then((ok) => {
      if (!ok) return
      action.mutate({
        run: () => boardApi.reservation({ action: 'seat', targetId: entry.reservation.id }),
        done: done(entry),
      })
    })
  }

  const start = (entry: ReservationEntry) => {
    if (entry.reservation.accountId) {
      confirmSeat(entry)
      return
    }
    setCustomer(null)
    bind.reset()
    setBinding(entry)
    setBindingOpen(true)
  }

  const plan = binding ? seatingPlan(binding, packages, billing) : null
  const dialog = (
    <Modal
      title="到店开台：没关联账户的预约"
      visible={bindingOpen}
      okText={customer ? '关联账户并开台' : '当散客开台'}
      // 请求回来之前不关：成功才关，失败原因留在弹窗里，选好的顾客不丢
      confirmLoading={bind.isPending}
      okButtonProps={{ ...dialogButtons.okButtonProps, disabled: !plan?.pkg }}
      // 打开时焦点给顾客选择框（取消按钮默认会抢走焦点）；请求进行中不让关，免得失败原因没处显示
      cancelButtonProps={{ ...dialogButtons.cancelButtonProps, autoFocus: false, disabled: bind.isPending }}
      closable={!bind.isPending}
      maskClosable={!bind.isPending}
      closeOnEsc={!bind.isPending}
      onCancel={() => setBindingOpen(false)}
      afterClose={() => setBinding(null)}
      onOk={() => {
        // 不返回 Promise：失败时 Semi 会把它再抛成没人接的 rejection
        if (!binding) return
        // 不选账户就当散客开台（2026-10-20 业主定）：后端走整桌开台，按这个套餐的时长计时
        bind.mutate(
          {
            run: () =>
              boardApi.reservation(
                customer
                  ? { action: 'seat', targetId: binding.reservation.id, accountId: customer.id }
                  : { action: 'seat', targetId: binding.reservation.id },
              ),
            done: done(binding),
          },
          { onSuccess: () => setBindingOpen(false) },
        )
      }}
    >
      {binding && plan ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text>
            {arrivalStartText(binding.reservation.startAt, now)} · {placeOf(binding)} ·{' '}
            {binding.customerName || '未填写称呼'}
          </Typography.Text>
          <SeatingPlanText plan={plan} />
          <CouponNote entry={binding} />
          <Typography.Text type="tertiary" size="small">
            这是代客登记、没关联账户的预约。顾客有账户就选上再开台
            {billing ? '（会员价、储值和积分结账时能用）' : ''}；不选就当散客开台，按这个套餐的时长计时
            {billing ? '，结账时再按开台时的价建单' : ''}。
          </Typography.Text>
          {bind.error ? (
            <Banner
              type={isPreviousApplied(bind.error) ? 'warning' : 'danger'}
              closeIcon={null}
              description={bind.error.message}
            />
          ) : null}
          <CustomerPicker
            label="到店顾客的账户（可不选）"
            value={customer}
            onChange={setCustomer}
            focusOnMount
            clearable
          />
        </div>
      ) : null}
    </Modal>
  )

  return { start, dialog }
}

/** 到店开台确认框里的套餐说明：按现行套餐写；和预约时不一样另起一行提醒，套餐停用了写成错误。 */
function SeatingPlanText({ plan }: { plan: SeatingPlan }) {
  return (
    <>
      <Typography.Text type={plan.pkg ? undefined : 'danger'}>{plan.text}</Typography.Text>
      {plan.note ? <Typography.Text type="warning">{plan.note}</Typography.Text> : null}
    </>
  )
}

/** 预约里记的团购：店员先在美团开店宝验券，开台时带进这一台。 */
function CouponNote({ entry }: { entry: ReservationEntry }) {
  const coupon = entry.reservation.coupon
  const text = couponText(coupon)
  if (!text) return null
  return (
    <Typography.Text>
      团购：{coupon?.platform === 'in_store' ? text : `${text}（请先在美团开店宝验券）`}
    </Typography.Text>
  )
}
