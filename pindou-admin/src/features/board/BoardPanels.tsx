import { Badge, Banner, Button, Card, List, Modal, Tag, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { accountQuery } from '../../api/accounts'
import { useBillingEnabled } from '../../api/billing'
import { isPreviousApplied } from '../../api/client'
import {
  boardApi,
  type AdmissionView,
  type PackageRule,
  type ReservationEntry,
  type ServiceTable,
} from '../../api/board'
import { confirmDialog, dialogButtons } from '../../components/confirm'
import { CouponFields } from '../../components/CouponFields'
import { couponDraftOf, couponInput, couponProblem, couponText, sameCoupon, type CouponDraft } from '../../lib/coupon'
import { clockTime } from '../../lib/format'
import { packageLine } from '../../lib/packages'
import {
  arrivalListMinutes,
  customerText,
  lateMinutes,
  pendingAdmissions,
  reminders,
  reminderText,
  tablePlace,
  upcomingReservations,
  type BoardSeat,
} from './board'
import { useArrivalSeating } from '../reservations/useArrivalSeating'
import { useBoardAction } from './useBoardAction'

const hm = (value: string) => clockTime(value).slice(0, 5)

/** 侧栏卡片比默认的紧凑些：柜台屏上一眼多看几行。呼叫店员面板也用这套留白。 */
export const panelHeader = { padding: '12px 16px' }
export const panelBody = { padding: '12px 16px' }

/**
 * 侧栏卡片的标题：Card 的 title 传字符串时 Semi 套 6 级标题，传节点就原样放、不再是标题；
 * 这里带了个数，所以自己包 6 级标题（同结账页会员卡片），读屏按标题能跳到各个侧栏。
 */
function PanelTitle({ text, count, type = 'warning' }: { text: string; count: number; type?: 'warning' | 'danger' }) {
  return (
    <span className="board-row-head" style={{ justifyContent: 'flex-start' }}>
      <Typography.Title heading={6} style={{ margin: 0 }}>
        {text}
      </Typography.Title>
      {count > 0 ? <Badge count={count} type={type} /> : null}
    </span>
  )
}

function Panel({ title, error, children }: { title: ReactNode; error?: Error | null; children: ReactNode }) {
  return (
    <Card className="board-panel" title={title} headerStyle={panelHeader} bodyStyle={panelBody}>
      {error ? (
        <Banner
          type={isPreviousApplied(error) ? 'warning' : 'danger'}
          closeIcon={null}
          description={error.message}
          style={{ marginBottom: 8 }}
        />
      ) : null}
      {children}
    </Card>
  )
}

/** 侧栏列表没有内容时的说明。 */
function emptyText(text: ReactNode) {
  return (
    <Typography.Text type="tertiary" size="small">
      {text}
    </Typography.Text>
  )
}

/**
 * 待确认的扫码入座：确认开台（开始计时）或拒绝。申请 30 分钟不确认自动失效。顾客填了团购记录的列出来，
 * 店员去美团开店宝验券；确认时可以改或清掉。
 */
export function AdmissionsPanel({
  admissions,
  tables,
}: {
  admissions: AdmissionView[]
  tables: Map<string, ServiceTable>
}) {
  const action = useBoardAction()
  const billing = useBillingEnabled()
  const pending = pendingAdmissions(admissions)
  // 关的时候只关 visible，申请留到关闭动画结束再清
  const [confirming, setConfirming] = useState<AdmissionView | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [coupon, setCoupon] = useState<CouponDraft>(couponDraftOf(undefined))

  const confirm = (entry: AdmissionView) => {
    setCoupon(couponDraftOf(entry.admission.coupon))
    setConfirming(entry)
    setConfirmOpen(true)
  }
  const submitConfirm = () => {
    if (!confirming || couponProblem(coupon)) return
    const entry = confirming
    const place = tablePlace(tables.get(entry.admission.serviceTableId), entry.admission.seatNumber)
    const next = couponInput(coupon)
    // 没改不带（保留申请里的）；改成不填时带空串清掉
    const changed = !sameCoupon(next, entry.admission.coupon)
    setConfirmOpen(false)
    action.mutate({
      run: () =>
        boardApi.loyalty({
          action: 'confirm',
          targetId: entry.admission.id,
          ...(changed ? { coupon: next ?? { platform: '', code: '' } } : {}),
        }),
      done: `${place} 已开台，开始计时`,
    })
  }
  const reject = (entry: AdmissionView) => {
    const place = tablePlace(tables.get(entry.admission.serviceTableId), entry.admission.seatNumber)
    void confirmDialog({
      title: '拒绝入座申请',
      content: `${place} · ${entry.customer?.nickname ?? '顾客'}：拒绝后顾客需要重新扫码选座。`,
      okText: '拒绝申请',
      okType: 'danger',
    }).then((ok) => {
      if (!ok) return
      action.mutate({
        run: () => boardApi.loyalty({ action: 'reject', targetId: entry.admission.id }),
        done: '已拒绝申请',
      })
    })
  }

  return (
    <Panel title={<PanelTitle text="待确认入座" count={pending.length} />} error={action.error}>
      {/* 侧栏窄，操作按钮放在每一行文字下面（main 里），不放右边的 extra */}
      <List
        size="small"
        className="board-list"
        dataSource={pending}
        emptyContent={emptyText('没有等待确认的申请。顾客扫桌码选好座位和套餐后出现在这里，过了时限不确认自动失效。')}
        renderItem={(entry) => {
          const pkg = entry.admission.package
          return (
            <List.Item
              key={entry.admission.id}
              data-admission={entry.admission.id}
              main={
                <div className="board-row">
                  <div className="board-row-head">
                    <Typography.Text strong>
                      {tablePlace(tables.get(entry.admission.serviceTableId), entry.admission.seatNumber)} ·{' '}
                      {entry.customer?.nickname ?? '顾客'}
                    </Typography.Text>
                    <Typography.Text type="tertiary" size="small">
                      {hm(entry.admission.createdAt)} 申请
                      {entry.expiresAt ? `，${hm(entry.expiresAt)} 前不确认自动失效` : ''}
                    </Typography.Text>
                  </div>
                  <Typography.Text type="secondary" size="small">
                    {packageLine(pkg, billing)}
                  </Typography.Text>
                  {entry.admission.coupon ? (
                    <Typography.Text type="secondary" size="small">
                      团购：{couponText(entry.admission.coupon)}
                    </Typography.Text>
                  ) : null}
                  <div className="board-row-actions">
                    <Button size="small" theme="solid" disabled={action.isPending} onClick={() => confirm(entry)}>
                      确认开台
                    </Button>
                    <Button size="small" type="danger" disabled={action.isPending} onClick={() => reject(entry)}>
                      拒绝
                    </Button>
                  </div>
                </div>
              }
            />
          )
        }}
      />
      <Modal
        title="确认开台"
        visible={confirmOpen}
        okText="确认开台"
        okButtonProps={{ ...dialogButtons.okButtonProps, disabled: Boolean(couponProblem(coupon)) }}
        cancelButtonProps={dialogButtons.cancelButtonProps}
        onOk={submitConfirm}
        onCancel={() => setConfirmOpen(false)}
        afterClose={() => setConfirming(null)}
      >
        {confirming ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <Typography.Text>
              {tablePlace(tables.get(confirming.admission.serviceTableId), confirming.admission.seatNumber)} ·{' '}
              {customerText(confirming.customer) || '顾客'}
            </Typography.Text>
            <Typography.Text>{packageLine(confirming.admission.package, billing)}</Typography.Text>
            <Typography.Text type="tertiary">
              {billing
                ? '确认后开始计时，并生成这份套餐的待结账订单。'
                : '确认后开始计时。顾客的团购请在美团开店宝验券，系统只记下来。'}
            </Typography.Text>
            <CouponFields value={coupon} onChange={setCoupon} />
          </div>
        ) : null}
      </Modal>
    </Panel>
  )
}

/**
 * 60 分钟内要到店的预约（含已到开始时间、还在宽限期里的）：待确认的先确认，已确认的到店开台
 * （按预约的套餐开按座计时）。散客预约（没有账户）开台前要先选顾客账户。
 */
export function ArrivalsPanel({
  reservations,
  packages,
  tables,
  now,
}: {
  reservations: ReservationEntry[]
  /** 现行发布的计时套餐：到店开台按它计时（收费开着时也按它计价），确认框照它写。 */
  packages: PackageRule[]
  tables: Map<string, ServiceTable>
  now: number
}) {
  const action = useBoardAction()
  const entries = upcomingReservations(reservations, now, arrivalListMinutes)

  const placeOf = (entry: ReservationEntry) =>
    tablePlace(tables.get(entry.reservation.serviceTableId), entry.reservation.seatNumber)
  // 到店开台（确认框、散客先选账户的弹窗）和「预约」页共用，见 features/reservations/useArrivalSeating.tsx
  const seating = useArrivalSeating({ action, packages, placeOf, now })
  const confirmBooking = (entry: ReservationEntry) =>
    action.mutate({
      run: () => boardApi.reservation({ action: 'confirm', targetId: entry.reservation.id }),
      done: '预约已确认',
    })

  return (
    <Panel
      title={<PanelTitle text={`即将到店 · ${arrivalListMinutes} 分钟内`} count={entries.length} />}
      error={action.error}
    >
      <List
        size="small"
        className="board-list"
        dataSource={entries}
        emptyContent={emptyText(`接下来 ${arrivalListMinutes} 分钟没有要到店的预约。`)}
        renderItem={(entry) => {
          const x = entry.reservation
          const late = lateMinutes(entry, now)
          return (
            <List.Item
              key={x.id}
              data-reservation={x.id}
              main={
                <div className="board-row">
                  <div className="board-row-head">
                    <Typography.Text strong>
                      {hm(x.startAt)}–{hm(entry.endAt)} · {placeOf(entry)}
                    </Typography.Text>
                    <Tag color={entry.displayStatus === 'confirmed' ? 'blue' : 'grey'}>
                      {entry.displayStatus === 'confirmed' ? '已确认' : '待确认'}
                    </Tag>
                  </div>
                  <Typography.Text type="secondary" size="small">
                    {entry.customerName || '未填写称呼'}
                    {entry.phoneMasked ? `（${entry.phoneMasked}）` : x.accountId ? '' : ' · 尚无账户'} ·{' '}
                    {x.packageName}
                  </Typography.Text>
                  {x.coupon ? (
                    <Typography.Text type="secondary" size="small">
                      团购：{couponText(x.coupon)}
                    </Typography.Text>
                  ) : null}
                  {late > 0 ? (
                    <Typography.Text type="warning" size="small">
                      已过开始时间 {late} 分钟
                    </Typography.Text>
                  ) : null}
                  <div className="board-row-actions">
                    {entry.displayStatus === 'pending' ? (
                      <Button size="small" disabled={action.isPending} onClick={() => confirmBooking(entry)}>
                        确认预约
                      </Button>
                    ) : null}
                    {/* 待确认的顾客人到了也能直接开台（2026-10-27 起），确认框里说明不再发「预约成功」 */}
                    <Button size="small" theme="solid" disabled={action.isPending} onClick={() => seating.start(entry)}>
                      到店开台
                    </Button>
                  </div>
                </div>
              }
            />
          )
        }}
      />
      {seating.dialog}
    </Panel>
  )
}

/** 顾客称呼：按座会话的申请里带着；整桌会话按账户编号读一次（缓存），散客写「散客」。 */
export function SeatCustomer({ seat }: { seat: BoardSeat }) {
  const accountId = seat.admission ? '' : (seat.session?.accountId ?? '')
  const account = useQuery({ ...accountQuery(accountId), enabled: accountId !== '' })
  if (seat.admission) return <>{customerText(seat.admission.customer) || '顾客'}</>
  if (!seat.session?.accountId) return <>散客</>
  if (account.data) return <>{customerText(account.data)}</>
  return <>已关联顾客 · {seat.session.accountId.slice(0, 8)}</>
}

/** 快到点与已超时：按剩余时间排，超时最久的在最前；点一行打开会话详情。 */
export function RemindersPanel({
  seats,
  now,
  fetchedAt,
  onOpen,
}: {
  seats: BoardSeat[]
  now: number
  fetchedAt: number
  onOpen: (seat: BoardSeat) => void
}) {
  const items = reminders(seats, now, fetchedAt)
  const overdue = items.filter((item) => item.seat.state === 'overdue').length
  return (
    <Panel title={<PanelTitle text="快到点与超时" count={items.length} type={overdue ? 'danger' : 'warning'} />}>
      {items.length === 0 ? (
        emptyText('没有快到点或超时的座位。剩余 10 分钟以内的会出现在这里，暂停中、已停止计时的不提醒。')
      ) : (
        <div>
          {items.map((item) => (
            <button
              key={item.seat.code}
              type="button"
              className="board-reminder"
              data-reminder={item.seat.code}
              onClick={() => onOpen(item.seat)}
            >
              <span>
                <Typography.Text strong>{item.seat.code}</Typography.Text>{' '}
                <Typography.Text type="secondary" size="small">
                  <SeatCustomer seat={item.seat} />
                </Typography.Text>
              </span>
              <Tag color={item.seat.state === 'overdue' ? 'red' : 'orange'} size="large">
                {reminderText(item)}
              </Tag>
            </button>
          ))}
        </div>
      )}
    </Panel>
  )
}
