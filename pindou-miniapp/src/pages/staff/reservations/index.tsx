import { useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import { DateField, StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { type AccountChoice } from '../../../components/staff/account-search'
import { CustomerPick, StaffSheet, minutesText } from '../../../components/staff/table-sheet'
import { PageControls } from '../../../components/pagination'
import { useBillingEnabled } from '../../../hooks/billing'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { keepPreviousData, useRefreshAll } from '../../../hooks/query'
import { couponReminder, couponText } from '../../../services/coupon'
import { money } from '../../../services/format'
import { navigateApp } from '../../../services/navigation'
import { StaffError } from '../../../services/staff'
import {
  isoDate,
  relativeDayLabel,
  reservationStatusNames,
  reservations,
  storeClock,
  storeDate,
  storeDayLabel,
  storeStamp,
  type ReservationEntry,
  type ReservationView,
} from '../../../services/reservations'
import './index.scss'

// 预约到店（2026-10-20 重做，docs/plan-page-redesign.md 第 2 节第 7、8 条）：分今天 / 明天 / 以后，按开始时间排成时间线；
// 过了时间没来的置顶成红卡（标记爽约 / 顾客说不来了）；每条只留一个主按钮（确认预约，或到店开台），取消、爽约收进「⋯」；
// 「代客登记」是右下角的按钮，单独一页（pages/staff/booking）。
// 只写了称呼、没关联账户的预约到店时可以当散客开台（业主 10-20 定），顾客愿意注册的仍可以顺手关联。
// 系统内收费关着时不写「到店应收」；预约上的团购记录照常显示。
// 2026-10-27 起：「确认预约」「到店了，开台」先问一句（确认会给顾客发微信通知，开台就开始计时）；
// 待确认的预约顾客人到了，「⋯」里能直接开台，不用先确认（不发「预约成功」通知）。

const waiting = (entry: ReservationEntry) => entry.displayStatus === 'pending'
const upcoming = (entry: ReservationEntry) => entry.displayStatus === 'confirmed'
// 过了到店时间加宽限还没人处理的：已存状态仍是待确认/已确认，座位已释放，等店员标记爽约或取消。
const overdue = (entry: ReservationEntry) => entry.displayStatus === 'expired'
// 后端只收开始时间到了之后的爽约（「预约尚未开始，不能标记爽约」），没到时不给这个选项
const started = (entry: ReservationEntry) => Date.parse(entry.reservation.startAt) <= Date.now()
/** 「⋯」里的几项：待确认的顾客人到了能直接开台；取消照常；开始时间到了之后还能标记爽约。 */
const moreItems = (entry: ReservationEntry) => [
  ...(waiting(entry) ? ['到店了，开台'] : []),
  '取消预约',
  ...(started(entry) ? ['标记爽约'] : []),
]

type Day = 'today' | 'tomorrow' | 'later'
// 按完整的门店日期比（YYYY-MM-DD）：只比「月-日」的话跨年那几天会分错。早于今天还没处理的也算今天。
const dayOf = (entry: ReservationEntry): Day => {
  const day = isoDate(storeDate(0, new Date(entry.reservation.startAt)))
  return day <= isoDate(storeDate(0)) ? 'today' : day === isoDate(storeDate(1)) ? 'tomorrow' : 'later'
}

/** 「B3」：桌位编码；读不到时退回桌号。多座按座卖的桌带座号。 */
function placeOf(view: ReservationView | null, entry: ReservationEntry) {
  const table = view?.tables.find((t) => t.id === entry.reservation.serviceTableId)
  const code = table?.code || (entry.tableNumber ? `${entry.tableNumber} 号桌` : '桌位待核对')
  if (table?.wholeTable) return `${code} 整桌`
  return table && table.seatCount > 1 ? `${code} ${entry.reservation.seatNumber} 号座` : code
}

export default function StaffReservations() {
  const billing = useBillingEnabled()
  // ★ 列表分两次读：还要处理的（scope=open，全量，不会越积越多）和处理完的（scope=ended，只取当前一页）。
  const live = useStaffEvents(5000)
  const data = useStaffQuery(['reservations', 'open'], reservations.staffOpen, {
    refetchInterval: live.refetchInterval,
  })
  const [day, setDay] = useState<Day>('today')
  const [showEnded, setShowEnded] = useState(false)
  // 已结束的按门店日期（到店那天，YYYY-MM-DD；空串是不限日期，默认不限）交给服务端筛，总数与翻页只算这一天。
  const today = isoDate(storeDate(0))
  const [endedDate, setEndedDate] = useState('')
  const [endedPage, setEndedPage] = useState(1)
  const [keepEnded, setKeepEnded] = useState(false)
  const ended = useStaffQuery(
    ['reservations', 'ended', endedDate || 'all', endedPage],
    () => reservations.staffEnded(endedPage, endedDate),
    {
      enabled: showEnded,
      refetchInterval: live.refetchInterval,
      placeholderData: keepEnded ? keepPreviousData : undefined,
    },
  )
  const refreshAll = useRefreshAll()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // 到店开台的弹层：没关联账户的预约在这里选账户，或者当散客开台
  const [arrival, setArrival] = useState<ReservationEntry | null>(null)
  const [account, setAccount] = useState<AccountChoice | null>(null)
  const pending = useRef(false)
  useLeaveGuard(false, busy)

  const view = data.data
  const settings = view?.settings
  const packages = view?.packages || []

  const run = async (input: Parameters<typeof reservations.action>[0], done?: () => void) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await reservations.action(input)
      done?.()
      void refreshAll()
    } catch (e) {
      setError(e instanceof StaffError ? e.message : '操作失败，请重新读取后确认')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  /**
   * 取消 / 爽约前当场问一句原因（弹窗的输入框，基础库 2.17.1 起）——原因跟着这一次操作走。
   * 弹窗起不来时不能把操作也一起卡死：退回不带原因直接执行，原因是给对账看的说明，不是必填项。
   */
  const askReason = async (title: string, targetId: string, action: 'cancel' | 'no_show') => {
    if (pending.current) return
    let reason = ''
    try {
      // editable / placeholderText 与结果里的 content 是微信基础库 2.17.1 起就有的，@tarojs/taro 的类型还没跟上
      const answer = (await Taro.showModal({
        title,
        editable: true,
        placeholderText: '原因（可不填），会记进这条预约',
        confirmText: title,
      } as Taro.showModal.Option)) as Taro.showModal.SuccessCallbackResult & { content?: string }
      if (!answer.confirm) return
      reason = (answer.content || '').slice(0, 200)
    } catch {
      /* 弹不出输入框就按不填处理 */
    }
    await run({ action, targetId, reason })
  }
  const more = async (entry: ReservationEntry) => {
    const items = moreItems(entry)
    let index: number
    try {
      index = (await Taro.showActionSheet({ itemList: items })).tapIndex
    } catch {
      return
    }
    if (items[index] === '到店了，开台') await seatNow(entry)
    else if (items[index] === '取消预约') await askReason('取消预约', entry.reservation.id, 'cancel')
    else await askReason('标记爽约', entry.reservation.id, 'no_show')
  }
  /** 先问一句，点了确认才做；弹窗起不来就不做（不像原因，这两步不能跳过确认）。 */
  const sure = async (title: string, content: string, confirmText: string) => {
    try {
      return (await Taro.showModal({ title, content, confirmText, cancelText: '再看看' })).confirm
    } catch {
      return false
    }
  }
  const confirmNow = async (entry: ReservationEntry) => {
    if (pending.current) return
    const ok = await sure(
      '确认这条预约？',
      `${placeOf(view || null, entry)} · ${storeStamp(entry.reservation.startAt)} · ${who(entry)}。确认后顾客那边显示「已确认」，开了微信提醒的会收到「预约成功」通知。`,
      '确认',
    )
    if (ok) await run({ action: 'confirm', targetId: entry.reservation.id })
  }
  const seatNow = async (entry: ReservationEntry) => {
    if (pending.current) return
    // 已关联账户的问一句就开；没关联的弹出来选账户，或当散客（弹层里的按钮就是确认）
    if (!entry.reservation.accountId) {
      setAccount(null)
      setArrival(entry)
      return
    }
    const ok = await sure(
      '到店开台？',
      `给 ${who(entry)} 在 ${placeOf(view || null, entry)} 开台，按「${entry.reservation.packageName}」从现在开始计时。${
        waiting(entry) ? '这条预约还没确认，开台就算到店了，不再发「预约成功」通知。' : ''
      }`,
      '开台',
    )
    if (ok) await run({ action: 'seat', targetId: entry.reservation.id })
  }
  const packageOf = (entry: ReservationEntry) => packages.find((rule) => rule.id === entry.reservation.packageId)
  const lengthOf = (entry: ReservationEntry) =>
    packageOf(entry)?.untilClose
      ? entry.reservation.packageName || '到打烊'
      : minutesText(entry.reservation.durationMinutes)
  const who = (entry: ReservationEntry) => entry.customerName || '未填写称呼'
  const metaOf = (entry: ReservationEntry) =>
    [
      entry.phoneMasked ? `尾号 ${entry.phoneMasked.slice(-4)}` : '电话登记 · 还没有账号',
      lengthOf(entry),
      entry.reservation.coupon ? couponText(entry.reservation.coupon) : '没填团购',
      billing ? `到店应收 ¥${money(entry.reservation.amountCents)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')

  const all = view?.reservations || []
  const missed = all.filter(overdue)
  const current = all.filter((entry) => !overdue(entry))
  const counts = { today: 0, tomorrow: 0, later: 0 }
  current.forEach((entry) => counts[dayOf(entry)]++)
  const shown = current
    .filter((entry) => dayOf(entry) === day)
    .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))

  const card = (entry: ReservationEntry) => {
    const x = entry.reservation
    const reminder = (waiting(entry) || upcoming(entry)) && couponReminder(x.coupon)
    return (
      <View className="booking-card" key={x.id}>
        <View className="booking-card-head">
          <View className="booking-card-copy">
            <Text className="booking-card-title">
              {placeOf(view || null, entry)} · {who(entry)}
            </Text>
            <Text className="booking-card-meta">{metaOf(entry)}</Text>
          </View>
          <Text className={`booking-state booking-state-${entry.displayStatus}`}>
            {waiting(entry) ? '等确认' : reservationStatusNames[entry.displayStatus]}
          </Text>
        </View>
        {reminder && <Text className="booking-card-note">{reminder}</Text>}
        {!!x.note && <Text className="booking-card-note">备注：{x.note}</Text>}
        {(waiting(entry) || upcoming(entry)) && (
          <View className="booking-card-actions">
            {waiting(entry) ? (
              <Button
                className="booking-button booking-button-dark"
                disabled={busy}
                onClick={() => void confirmNow(entry)}
              >
                确认预约
              </Button>
            ) : (
              <Button
                className="booking-button booking-button-dark"
                disabled={busy}
                onClick={() => void seatNow(entry)}
              >
                到店了，开台
              </Button>
            )}
            <Button
              className="booking-button booking-more"
              ariaLabel={`更多：${moreItems(entry).join('、')}`}
              disabled={busy}
              onClick={() => void more(entry)}
            >
              ⋯
            </Button>
          </View>
        )}
      </View>
    )
  }

  const endedDay = endedDate ? relativeDayLabel(endedDate) : ''
  return (
    <StaffScreen
      title="预约"
      loading={data.loading}
      error={data.error}
      stale={!!view}
      onRetry={() => void refreshAll()}
      live={live}
      updatedAt={data.updatedAt}
    >
      {view && settings && (
        <>
          <View className="booking-days" role="tablist">
            {(
              [
                ['today', '今天'],
                ['tomorrow', '明天'],
                ['later', '以后'],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                className={`booking-day ${day === key ? 'booking-day-on' : ''}`}
                ariaLabel={`${label} ${counts[key]} 条${day === key ? '，已选中' : ''}`}
                onClick={() => setDay(key)}
              >
                {label} · {counts[key]}
              </Button>
            ))}
          </View>
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          {missed.map((entry) => (
            <View className="booking-missed" key={entry.reservation.id} role="alert">
              <Text className="booking-missed-title">
                {storeClock(entry.reservation.startAt)} · {placeOf(view, entry)} · {who(entry)} 没来
              </Text>
              <Text className="booking-missed-meta">
                {isoDate(storeDate(0, new Date(entry.reservation.startAt))) === today
                  ? ''
                  : `${storeStamp(entry.reservation.startAt)} 的预约，`}
                过了到店时间加 {settings.graceMinutes} 分钟宽限，座位已经放出来了
              </Text>
              <View className="booking-missed-actions">
                {started(entry) && (
                  <Button
                    className="booking-button booking-button-danger"
                    disabled={busy}
                    onClick={() => void askReason('标记爽约', entry.reservation.id, 'no_show')}
                  >
                    标记爽约
                  </Button>
                )}
                <Button
                  className="booking-button"
                  disabled={busy}
                  onClick={() => void askReason('取消预约', entry.reservation.id, 'cancel')}
                >
                  顾客说不来了
                </Button>
              </View>
            </View>
          ))}
          <View className="booking-timeline">
            {shown.map((entry) => {
              const start = new Date(entry.reservation.startAt)
              const night = Number(storeClock(start).slice(0, 2)) >= 18
              return (
                <View className="booking-slot" key={entry.reservation.id}>
                  <View className="booking-time">
                    <Text className="booking-time-start">
                      {dayOf(entry) === 'later' ? `${storeDayLabel(start)} ` : ''}
                      {storeClock(start)}
                    </Text>
                    <Text className="booking-time-end">
                      {packageOf(entry)?.untilClose ? '打烊' : night ? '夜校' : `–${storeClock(entry.endAt)}`}
                    </Text>
                  </View>
                  {card(entry)}
                </View>
              )
            })}
            {shown.length === 0 && (
              <Text className="booking-empty">
                {day === 'today' ? '今天' : day === 'tomorrow' ? '明天' : '以后'}
                还没有预约。电话或当面约的点右下角「代客登记」。
              </Text>
            )}
          </View>

          <Button className="booking-ended-toggle" onClick={() => setShowEnded((value) => !value)}>
            {showEnded ? '收起已结束的预约' : '已结束的预约（到店、取消、爽约）'}
          </Button>
          {showEnded && (
            <View className="booking-ended">
              <DateField
                label="到店日期"
                value={endedDate}
                text={endedDay}
                openAt={today}
                presets={[
                  { text: '今天', value: today },
                  { text: '昨天', value: isoDate(storeDate(-1)) },
                ]}
                disabled={busy}
                onChange={(value) => {
                  setEndedDate(value)
                  setEndedPage(1)
                  setKeepEnded(false)
                }}
              />
              {ended.loading ? (
                <Text className="field-help">正在读取已结束的预约…</Text>
              ) : (
                <>
                  {!!ended.error && (
                    <View className="staff-notice" role="alert">
                      <Text>{ended.data ? '刷新失败，显示的是上次读取的内容。' : '已结束的预约读取失败。'}</Text>
                      <Button className="text-button" onClick={ended.refresh}>
                        重新加载
                      </Button>
                    </View>
                  )}
                  {ended.data && (
                    <>
                      {ended.data.items.map((entry) => (
                        <View className="booking-ended-row" key={entry.reservation.id}>
                          <Text className="booking-card-title">
                            {storeStamp(entry.reservation.startAt)} · {placeOf(view, entry)} · {who(entry)}
                          </Text>
                          <Text className="booking-card-meta">
                            {reservationStatusNames[entry.displayStatus]}
                            {entry.reservation.reason ? ` · 原因：${entry.reservation.reason}` : ''}
                          </Text>
                        </View>
                      ))}
                      {ended.data.items.length === 0 && (
                        <Text className="field-help">
                          {endedDate ? `${endedDay} 没有已结束的预约。` : '还没有已结束的预约记录。'}
                        </Text>
                      )}
                      <PageControls
                        page={ended.data.page - 1}
                        total={ended.data.total}
                        disabled={busy}
                        onChange={(next) => {
                          setEndedPage(next + 1)
                          setKeepEnded(true)
                        }}
                      />
                    </>
                  )}
                </>
              )}
            </View>
          )}
          <Button
            className="booking-fab"
            ariaLabel="代客登记：电话或当面约的"
            onClick={() => void navigateApp('/pages/staff/booking/index')}
          >
            + 代客登记
          </Button>
        </>
      )}
      {arrival && (
        <StaffSheet
          title={placeOf(view || null, arrival)}
          pill="到店开台"
          meta={`${who(arrival)} · ${lengthOf(arrival)} · 没关联账户的预约`}
          busy={busy}
          onClose={() => setArrival(null)}
          footer={
            <Button
              className="table-sheet-primary"
              disabled={busy}
              onClick={() =>
                void run(
                  { action: 'seat', targetId: arrival.reservation.id, ...(account ? { accountId: account.id } : {}) },
                  () => setArrival(null),
                )
              }
            >
              {account ? '关联账户并开台' : '当散客开台'}
            </Button>
          }
        >
          <Text className="table-sheet-hint">
            这是代客登记、没关联账户的预约。顾客有账户就选上再开台{billing ? '（会员价、储值和积分结账时能用）' : ''}
            ；不选就当散客开台，按预约的套餐时长计时。
          </Text>
          <View className="table-sheet-section">
            <Text className="table-sheet-label">到店顾客的账户（可不选）</Text>
            <CustomerPick value={account} onChange={setAccount} disabled={busy} />
          </View>
        </StaffSheet>
      )}
    </StaffScreen>
  )
}
