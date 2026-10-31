import {
  Banner,
  Button,
  Descriptions,
  Empty,
  InputNumber,
  SideSheet,
  Space,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useBillingEnabled } from '../../api/billing'
import { boardApi, type BoardData, type SessionUpdate } from '../../api/board'
import { isPreviousApplied } from '../../api/client'
import { confirmDialog } from '../../components/confirm'
import { useSheetFocus } from '../../components/useSheetFocus'
import { couponText } from '../../lib/coupon'
import { clockTime, dateTime, money } from '../../lib/format'
import {
  draftOrderNotice,
  openable,
  remainingSeconds,
  renewChoices,
  renewMinutes,
  seatPlace,
  seatStateNames,
  sessionActions,
  timingText,
  type BoardSeat,
  type SeatState,
} from './board'
import { chargeFreshness } from '../checkout/timing'
import { SeatCustomer } from './BoardPanels'
import { minutesText } from './open'
import { SessionMore } from './SessionMore'
import { useBoardAction } from './useBoardAction'

const stateColors: Record<SeatState, 'green' | 'blue' | 'cyan' | 'orange' | 'red' | 'grey' | 'light-blue'> = {
  free: 'green',
  running: 'blue',
  companion: 'cyan',
  expiring: 'orange',
  overdue: 'red',
  paused: 'grey',
  stopped: 'light-blue',
  off: 'grey',
}

/** 计时方式：按座会话写套餐与总时长（含续时），整桌会话写分钟或自由计时；开到打烊的写明。 */
function timingMode(seat: BoardSeat): string {
  const session = seat.session
  if (!session) return '—'
  if (session.timingMode === 'free') return '自由计时（没有结束时间，不提醒）'
  const total = session.untilClose
    ? `到打烊（共 ${session.durationMinutes ?? 0} 分钟）`
    : `共 ${session.durationMinutes ?? 0} 分钟`
  if (session.admissionId) {
    const pkg = seat.admission?.admission.package
    return pkg ? `套餐「${pkg.name}」· ${total}` : `套餐计时 · ${total}`
  }
  return `整桌计时 · ${total}`
}

/**
 * 应收：按座会话看确认开台时建好的待结账订单（套餐加续时）；整桌会话看桌位接口按计时与套餐的估算，
 * 算不出来（对不上套餐、自由计时等）时后端不给，如实写「结账时填价」，不写 ¥0。
 */
function receivableText(seat: BoardSeat): string {
  const order = seat.admission?.order
  if (order?.status === 'draft') return `${money(order.receivableCents)}（待结账订单）`
  // 分笔付款收了一部分：金额已定，写还差多少，接着去结账页收
  if (order?.status === 'partially_paid')
    return `${money(order.receivableCents)}（部分付款，还差 ${money(order.outstandingCents ?? 0)}）`
  if (seat.table?.estimatedCents !== undefined) return `${money(seat.table.estimatedCents)}（估算，结账时以订单为准）`
  return '结账时填价'
}

/**
 * 计价说明：后端按发布的规则算好的那句话（超时加收几块、自由计时几块、陪客费），原样显示。
 * 按座会话看待结账订单上的，整桌会话看桌位接口的；同桌多个会话时后端不给。
 */
function chargeText(seat: BoardSeat): string | null {
  const charge = seat.admission?.order?.timing ?? seat.table?.charge
  if (!charge) return null
  const freshness = chargeFreshness(charge)
  return freshness ? `${charge.summary}。${freshness}` : `${charge.summary}。`
}

/**
 * 点开使用中的座位：会话详情与常用操作（暂停、继续、续时、去结账；系统内收费关着时没有去结账和金额，换成「结束」），
 * 下面是不常用的换桌换座、陪客、撤销误开
 * （见 SessionMore）。内容随看板的数据实时更新（seat 每次由父组件按最新数据给出），操作沿用小程序员工端的接口与权限：
 * 按座会话（扫码入座、预约到店开的）走 /loyalty/actions 并带读到的 sessionVersion，整桌会话走 /venue-sessions。
 * 「去结账」建草稿订单（已有草稿时后端返回同一张）后跳到网页结账页 /checkout/$orderId。
 */
export function SessionSheet({
  seat,
  data,
  visible,
  now,
  fetchedAt,
  onClose,
  afterClose,
}: {
  /** 关闭动画期间仍是刚才那个座位，内容不变空。 */
  seat: BoardSeat | null
  /** 看板读到的全部内容：换桌换座的候选、目标桌今天的预约。 */
  data: BoardData
  visible: boolean
  now: number
  fetchedAt: number
  onClose: () => void
  /** 关闭动画结束：这时才清掉座位。 */
  afterClose: () => void
}) {
  const title = seat ? `会话 · ${seat.code}` : '会话'
  const focus = useSheetFocus(visible, { className: 'board-session-sheet', label: title })
  return (
    <SideSheet
      className="board-session-sheet"
      visible={visible}
      title={title}
      width={440}
      closeOnEsc
      onCancel={onClose}
      afterVisibleChange={(shown) => {
        focus(shown)
        if (!shown) afterClose()
      }}
      bodyStyle={{ paddingBottom: 24 }}
    >
      {seat ? (
        <SessionDetail key={seat.code} seat={seat} data={data} now={now} fetchedAt={fetchedAt} onClose={onClose} />
      ) : null}
    </SideSheet>
  )
}

function SessionDetail({
  seat,
  data,
  now,
  fetchedAt,
  onClose,
}: {
  seat: BoardSeat
  data: BoardData
  now: number
  fetchedAt: number
  onClose: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const billing = useBillingEnabled()
  const operation = useBoardAction()
  // 换桌换座、陪客、撤销：错误显示在下面那一段里，不和计时的混在一处
  const more = useBoardAction()
  const [minutes, setMinutes] = useState<number | undefined>(undefined)

  const checkout = useMutation({
    mutationFn: async (input: { sessionId: string; stopVersion?: string }) => {
      if (input.stopVersion)
        await boardApi.loyalty({ action: 'stop', targetId: input.sessionId, expectedVersion: input.stopVersion })
      return boardApi.createOrder(input.sessionId)
    },
    onSuccess: (order) => {
      void queryClient.invalidateQueries()
      void navigate({ to: '/checkout/$orderId', params: { orderId: order.id } })
    },
    // 停止成功、建单失败时，重读后这里显示「待结账」，再点只建单
    onError: () => void queryClient.invalidateQueries(),
  })

  const session = seat.session
  const actions = sessionActions(seat, billing)
  if (!session || !actions || !openable(seat)) {
    return (
      <Empty
        title="这个座位现在没有进行中的会话"
        description="可能刚结束、结完账或被撤销了，关掉看看平面图上的最新状态。"
      />
    )
  }

  const seconds = remainingSeconds(seat, now, fetchedAt)
  const place = seatPlace(seat)
  const busy = operation.isPending || checkout.isPending || more.isPending
  const version = seat.admission?.sessionVersion ?? ''
  // 只显示最近一次操作的错误：下面换桌失败后又点了暂停，上面写暂停的结果，下面不再挂着换桌的；最近一次成功了就都不挂
  const latest = [operation, checkout, more].reduce((a, b) => (b.submittedAt > a.submittedAt ? b : a))
  const error = latest === more ? null : latest.error

  const timing = (action: 'pause' | 'resume') => {
    const done = action === 'pause' ? `${seat.code} 已暂停` : `${seat.code} 已继续计时`
    if (actions.seatBased) {
      operation.mutate({
        run: () => boardApi.loyalty({ action, targetId: session.id, expectedVersion: version }),
        done,
      })
      return
    }
    operation.mutate({
      run: () => boardApi.updateSession(session.id, { status: action === 'pause' ? 'paused' : 'active' }),
      done,
    })
  }

  const renewPackage = (option: { minutes: number; cents: number }) => {
    // 版本取弹窗打开这一刻读到的：期间别人动过，后端回 409，看过新状态再点
    const expectedVersion = version
    void confirmDialog({
      title: '续时',
      content: billing
        ? `${place}：按套餐追加 ${option.minutes} 分钟，加收 ${money(option.cents)}（记进待结账订单）？`
        : `${place}：按套餐追加 ${option.minutes} 分钟？顾客补的时间在美团、大众点评买。`,
      okText: '确认续时',
    }).then((ok) => {
      if (!ok) return
      operation.mutate({
        run: () => boardApi.loyalty({ action: 'renew', targetId: session.id, expectedVersion }),
        done: `${seat.code} 已续时 ${option.minutes} 分钟`,
      })
    })
  }

  /**
   * 整桌会话按续时方案「续 N 分钟」：先确认（同按座会话按套餐续时）。时长取点按钮这一刻看到的：
   * 期间别人续过，后端回 409，看过新时长再点。
   */
  const renewByPlan = (added: number) => {
    const plan = actions.renew?.kind === 'minutes' ? actions.renew.plan : null
    if (!plan) return
    const expectedDurationMinutes = session.durationMinutes ?? 0
    void confirmDialog({
      title: '续时',
      content: billing
        ? `${place}：追加 ${minutesText(added)}？按开台时的续时方案（每 ${plan.minutes} 分钟 ${money(plan.amountCents)}）记进待结账订单。`
        : `${place}：追加 ${minutesText(added)}？顾客补的时间在美团、大众点评买。`,
      okText: '确认续时',
    }).then((ok) => {
      if (ok) renewBy(added, expectedDurationMinutes)
    })
  }

  /** 自己填分钟续时（「其他时长」）。 */
  const renewByMinutes = () => {
    const added = renewMinutes(minutes)
    if (added === null) return
    renewBy(added, session.durationMinutes ?? 0)
  }

  const renewBy = (added: number, expectedDurationMinutes: number) => {
    // 追加分钟数并带上看到的时长：别人刚续过或页面过期时后端回 409，不会互相覆盖、把时长改短
    operation.mutate(
      {
        run: () => boardApi.updateSession(session.id, { extendMinutes: added, expectedDurationMinutes }),
        done: `${seat.code} 已续时 ${minutesText(added)}`,
      },
      {
        onSuccess: (result) => {
          setMinutes(undefined)
          const notice = draftOrderNotice(result as SessionUpdate)
          if (!notice) return
          if (notice.repriced) {
            Toast.info(notice.text)
            return
          }
          // 员工改过明细的草稿没跟着改价：说清楚，给个去结账页的入口
          void confirmDialog({
            variant: 'warning',
            title: '请核对待结账订单',
            content: notice.text,
            okText: '去结账页核对',
          }).then((ok) => {
            if (ok) void navigate({ to: '/checkout/$orderId', params: { orderId: notice.orderId } })
          })
        },
      },
    )
  }

  /**
   * 整桌会话停止计时（同按座会话）：先确认，写清停了以后计价冻结、座位保留到结账、不能再暂停继续续时。
   * 后端要幂等键（updateSession 都带）；别人刚停过时后端回 409「已停止计时」，重读后这里只剩去结账。
   */
  const stopTiming = () => {
    void confirmDialog({
      title: '停止计时',
      content: `${place}：停止计时后座位保留到结账，计时费按停止这一刻算、不再变；之后不能再暂停、继续或续时。`,
      okText: '停止计时',
    }).then((ok) => {
      if (!ok) return
      operation.mutate({
        run: () => boardApi.updateSession(session.id, { stop: true }),
        done: `${seat.code} 已停止计时，待结账`,
      })
    })
  }

  /**
   * 结束（系统内收费关着时）：结束计时、座位立刻空出来，不建单不收款；之前建的、还没收款的订单一并作废。
   * 按座会话带读到的 sessionVersion，整桌会话走 PATCH end；都带幂等键。别人刚动过时后端回 409，重读后再点。
   */
  const endSession = () => {
    const expectedVersion = version
    void confirmDialog({
      title: '结束',
      content: `${place}：结束计时，座位立刻空出来。不建单、不收款（钱在美团、大众点评收）；结束后不能恢复。`,
      okText: '结束并放座',
      okType: 'danger',
    }).then((ok) => {
      if (!ok) return
      operation.mutate(
        {
          run: () =>
            actions.seatBased
              ? boardApi.loyalty({ action: 'end', targetId: session.id, expectedVersion })
              : boardApi.updateSession(session.id, { end: true }),
          done: `${seat.code} 已结束，座位已空出`,
        },
        { onSuccess: onClose },
      )
    })
  }

  const goCheckout = () => {
    if (!actions.stopFirst) {
      checkout.mutate({ sessionId: session.id })
      return
    }
    const stopVersion = version
    void confirmDialog({
      title: '停止计时并去结账',
      content: `${place}：停止计时后座位保留到结账，接着打开结账页收款。`,
      okText: '停止并去结账',
    }).then((ok) => {
      if (ok) checkout.mutate({ sessionId: session.id, stopVersion })
    })
  }

  const endsAt = seat.table?.endsAt
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <Space>
          <Tag color={stateColors[seat.state]} size="large">
            {seatStateNames[seat.state]}
          </Tag>
          {/* 陪客快到点、超时时座位状态写那两个，这里另标一个「陪客中」 */}
          {session.status === 'companion' && seat.state !== 'companion' ? (
            <Tag color={stateColors.companion} size="large">
              {seatStateNames.companion}
            </Tag>
          ) : null}
        </Space>
        <div className="board-time" data-timing>
          {timingText(seat, seconds)}
        </div>
        {endsAt && session.timingMode !== 'free' && seat.state !== 'paused' && seat.state !== 'stopped' ? (
          <Typography.Text type="tertiary" size="small">
            到点时间 {clockTime(endsAt).slice(0, 5)}
          </Typography.Text>
        ) : null}
      </div>

      <Descriptions
        align="left"
        data={[
          { key: '座位', value: place },
          { key: '顾客', value: <SeatCustomer seat={seat} /> },
          { key: '开始时间', value: dateTime(session.startedAt) },
          { key: '计时方式', value: timingMode(seat) },
          ...(couponText(seat.admission?.admission.coupon)
            ? [{ key: '团购', value: couponText(seat.admission?.admission.coupon) }]
            : []),
          // 系统内收费关着时不建单不结账，不写应收和计价
          ...(billing ? [{ key: '应收', value: receivableText(seat) }] : []),
          ...(billing && chargeText(seat) ? [{ key: '计价', value: chargeText(seat) }] : []),
        ]}
      />

      {seat.sessionCount > 1 ? (
        <Banner
          type="info"
          closeIcon={null}
          description={`这张桌上有 ${seat.sessionCount} 个进行中的会话，这里只显示最早到期的一个；其余的请在小程序桌位页处理。`}
        />
      ) : null}
      {actions.waiting ? (
        <Banner type="info" closeIcon={null} description="正在读取这次体验的计时信息，稍等片刻再操作。" />
      ) : null}
      {/* 上一次没收到结果的操作其实已经生效（这次没提交）：不是失败，用提醒的样子 */}
      {error ? (
        <Banner type={isPreviousApplied(error) ? 'warning' : 'danger'} closeIcon={null} description={error.message} />
      ) : null}
      {session.status === 'companion' ? (
        <Typography.Text type="tertiary" size="small">
          陪客不计时，不能暂停或继续。
        </Typography.Text>
      ) : null}
      {!actions.seatBased && session.stoppedAt ? (
        <Typography.Text type="tertiary" size="small">
          {billing ? '计时已停止，座位保留到结账；不能再暂停、继续或续时。' : '计时已停止；用完点「结束」放座。'}
        </Typography.Text>
      ) : null}
      {session.untilClose ? (
        <Typography.Text type="tertiary" size="small">
          这一台开到打烊，用到打烊为止：不能暂停、续时，也不能标陪客。
        </Typography.Text>
      ) : null}

      {actions.pause || actions.resume || actions.renew || actions.stop ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text strong>计时</Typography.Text>
          <Space wrap>
            {actions.pause ? (
              <Button
                disabled={busy || actions.waiting || Boolean(actions.pauseBlocked)}
                onClick={() => timing('pause')}
              >
                暂停
              </Button>
            ) : null}
            {actions.resume ? (
              <Button disabled={busy || actions.waiting} onClick={() => timing('resume')}>
                继续
              </Button>
            ) : null}
            {actions.renew?.kind === 'package' ? (
              <Button
                disabled={busy || actions.waiting}
                onClick={() => actions.renew?.kind === 'package' && renewPackage(actions.renew)}
              >
                续时 {actions.renew.minutes} 分钟{billing ? `（${money(actions.renew.cents)}）` : ''}
              </Button>
            ) : null}
            {actions.stop ? (
              <Button disabled={busy} onClick={stopTiming}>
                停止计时
              </Button>
            ) : null}
          </Space>
          {actions.pauseBlocked ? (
            <Typography.Text type="tertiary" size="small">
              {actions.pauseBlocked}
            </Typography.Text>
          ) : null}
          {actions.renew?.kind === 'minutes' ? (
            <>
              {actions.renew.plan ? (
                <Space wrap>
                  {renewChoices(actions.renew.plan).map((added) => (
                    <Button key={added} disabled={busy} onClick={() => renewByPlan(added)}>
                      续 {minutesText(added)}
                    </Button>
                  ))}
                </Space>
              ) : null}
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <InputNumber
                  aria-label="续时分钟"
                  placeholder={actions.renew.plan ? '其他分钟' : '续时分钟'}
                  min={1}
                  max={1440}
                  precision={0}
                  value={minutes}
                  onChange={(value) => setMinutes(typeof value === 'number' ? value : undefined)}
                  style={{ width: 140 }}
                  suffix="分钟"
                />
                <Button disabled={busy || renewMinutes(minutes) === null} onClick={renewByMinutes}>
                  续时
                </Button>
              </div>
              {billing ? (
                <Typography.Text type="tertiary" size="small">
                  {actions.renew.plan
                    ? `按开台时的续时方案：每 ${actions.renew.plan.minutes} 分钟 ${money(actions.renew.plan.amountCents)}。自己填的分钟对不上套餐加续时的，结账时要填计时费。`
                    : '这一台的时长对不上有续时方案的套餐：续多久自己填，结账时要填计时费。'}
                </Typography.Text>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {actions.checkout ? (
        <Button
          type="primary"
          theme="solid"
          size="large"
          block
          loading={checkout.isPending}
          disabled={busy || (actions.stopFirst && actions.waiting)}
          onClick={goCheckout}
        >
          {actions.checkoutLabel}
        </Button>
      ) : null}
      {actions.end ? (
        <Button
          type="primary"
          theme="solid"
          size="large"
          block
          disabled={busy || (actions.seatBased && actions.waiting)}
          onClick={endSession}
        >
          结束
        </Button>
      ) : null}

      <SessionMore
        seat={seat}
        session={session}
        actions={actions}
        data={data}
        version={version}
        now={now}
        busy={operation.isPending || checkout.isPending}
        task={more}
        error={latest === more ? more.error : null}
        onClose={onClose}
      />
    </div>
  )
}
