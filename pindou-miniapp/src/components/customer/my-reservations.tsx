import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { Button } from '../button'
import { CancelReservationSheet } from './cancel-reservation-sheet'
import { Failure, RefreshNotice, SectionEmpty, Skeleton } from './index'
import { storeContactActions } from './store-contact'
import { useBillingEnabled } from '../../hooks/billing'
import { useNow } from '../../hooks/clock'
import { useCustomerQuery } from '../../hooks/query'
import { couponText } from '../../services/coupon'
import { askNotices, missingNotices, saveNotices } from '../../services/notices'
import { moneyText } from '../../services/format'
import { nightSchoolFromHour, nightSchoolName } from '../../brand'
import {
  reservations,
  storeClock,
  storeContact,
  storeDate,
  weekdayLabel,
  isoDate,
  type ReservationEntry,
} from '../../services/reservations'
import { zoneOf, type SeatZone } from '../../services/seatmap'
import { untilLabel } from '../../services/storefront'
import { scanTableCode } from '../../services/table-code'
import type { Table } from '../../services/membership'
import './my-reservations.scss'

// 我的预约：分包里的「我的预约」页和系统内收费关着时底部第三格（原「订单」）都用这一份。
// 2026-10-20 重做（画稿 CMyReservations）：最近一条做成大卡（还有多久开始、几点前到、到店扫码入座、取消预约），
// 其余还要来的是小卡；以前的只列最近 3 条，其余点「全部」；最下面是没到店的提示。
// 微信提醒（2026-10-20 起）：还要来的预约缺哪种通知就给「开启微信提醒」（代客登记的、提交时没允许的），都开了写「已开启」；
// 门店没开顾客通知时都不显示。
// 取消（2026-10-27 起）：点「取消预约」「取消」先从底下弹出来，选了原因再确认（cancel-reservation-sheet）。
// 「到店扫码入座」只在预约当天给：别的日子扫了也入不了这条预约的座。

const openEntry = (entry: ReservationEntry) => entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed'
const experience = '/pages/customer/experience/index'

// 以前的那几条怎么写：顾客看的说法（已到店、没到店），不是员工页的「已开台」「未到店」
const pastNames: Record<string, string> = {
  seated: '已到店',
  cancelled: '已取消',
  no_show: '没到店',
  expired: '已过期',
}

const hoursText = (minutes: number) => (minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`)

/** 「今天 · 10 月 20 日 周二」；不是今明后天的只写日期和周几。哪天算今天按门店时区。 */
function dayHeading(startAt: string, now: number) {
  const date = storeDate(0, new Date(startAt))
  const offset = [0, 1, 2].findIndex((n) => isoDate(storeDate(n, new Date(now))) === isoDate(date))
  const day = `${date.month} 月 ${date.day} 日 ${weekdayLabel(date)}`
  return offset >= 0 ? `${['今天', '明天', '后天'][offset]} · ${day}` : day
}

/** 座位写给顾客看：「B3」「C1-2」；读不到布局时退回「3 号桌 1 号座」。 */
function seatText(entry: ReservationEntry, tables: readonly Table[]) {
  const table = tables.find((item) => item.id === entry.reservation.serviceTableId)
  if (table?.code) return table.seatCount > 1 ? `${table.code}-${entry.reservation.seatNumber}` : table.code
  return entry.tableNumber
    ? `${entry.tableNumber} 号桌 ${entry.reservation.seatNumber} 号座`
    : `桌位待核对 · ${entry.reservation.seatNumber} 号座`
}

const zoneText = (entry: ReservationEntry, tables: readonly Table[]) => {
  const table = tables.find((item) => item.id === entry.reservation.serviceTableId)
  return table?.zone ? zoneOf(table.zone as SeatZone)?.name || '' : ''
}

/** 放在 AuthBoundary 里用：登录后才读本人的预约。 */
export function MyReservationsContent() {
  const resource = useCustomerQuery(['reservations'], reservations.me, { live: true })
  const billing = useBillingEnabled()
  // 「还有多久开始」只在两次刷新之间走表，到没到点仍以接口给的状态为准
  const now = useNow(30000)
  const data = resource.data
  const settings = data?.settings
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // 正在问要不要取消的那条，和弹层里的出错说明
  const [cancelling, setCancelling] = useState<ReservationEntry | null>(null)
  const [cancelError, setCancelError] = useState('')

  const askCancel = (entry: ReservationEntry) => {
    if (busy) return
    setCancelError('')
    setCancelling(entry)
  }
  const cancel = async (entry: ReservationEntry, reason: string) => {
    if (busy) return
    setBusy(true)
    setCancelError('')
    try {
      await reservations.action({ action: 'cancel', targetId: entry.reservation.id, reason })
      setCancelling(null)
      void Taro.showToast({ title: '已取消预约', icon: 'none' })
      await resource.refresh()
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : '没取消成，请刷新后重试')
    } finally {
      setBusy(false)
    }
  }
  // 到店扫桌码入座：和首页「本次手作」一样，扫到了带着桌位进手作页
  const scan = async () => {
    try {
      const id = await scanTableCode()
      if (id) void Taro.navigateTo({ url: `${experience}?tableId=${encodeURIComponent(id)}` })
    } catch (failure) {
      void Taro.showToast({
        title: failure instanceof Error ? failure.message : '未识别到桌码，请重新扫描',
        icon: 'none',
      })
    }
  }
  const book = () => {
    void Taro.navigateTo({ url: '/pages/customer/reservations/index' })
  }
  const templates = data?.noticeTemplates ?? []
  const enableNotices = async (entry: ReservationEntry) => {
    if (busy) return
    // 订阅框要紧跟顾客的点击：先弹框，再置忙、提交
    const kinds = await askNotices(templates, missingNotices(entry, templates))
    if (!kinds.length) {
      void Taro.showModal({
        title: '没有开启微信提醒',
        content:
          '要在订阅框里点「允许」才收得到。没看到订阅框的话，可能之前选过「总是保持以上选择」：点右上角「···」›「设置」，把通知打开再试。',
        showCancel: false,
        confirmText: '知道了',
      })
      return
    }
    setBusy(true)
    setError('')
    try {
      await saveNotices(entry.reservation.id, kinds)
      await resource.refresh()
      void Taro.showToast({ title: '已开启微信提醒', icon: 'none' })
    } catch (e) {
      setError(e instanceof Error ? e.message : '没开成，请稍后再试')
    } finally {
      setBusy(false)
    }
  }
  /** 这条预约的微信提醒：缺哪种就给按钮，都开了写已开启。 */
  const noticeLine = (entry: ReservationEntry, className: string) => {
    if (!templates.length) return null
    if (!missingNotices(entry, templates).length)
      return <Text className={`${className} mine-notice-done`}>已开启微信提醒</Text>
    return (
      <Button
        className={`${className} mine-notice-on`}
        disabled={busy}
        ariaLabel={`开启 ${storeClock(entry.reservation.startAt)} 这条预约的微信提醒`}
        onClick={() => void enableNotices(entry)}
      >
        开启微信提醒
      </Button>
    )
  }

  if (resource.loading) return <Skeleton />
  if (!data || !settings)
    return (
      <Failure
        error={resource.error}
        retry={() => {
          void resource.refresh()
        }}
      />
    )
  const tables = data.tables
  const upcoming = data.reservations
    .filter(openEntry)
    .sort((a, b) => Date.parse(a.reservation.startAt) - Date.parse(b.reservation.startAt))
  const past = data.reservations
    .filter((entry) => !openEntry(entry))
    .sort((a, b) => Date.parse(b.reservation.startAt) - Date.parse(a.reservation.startAt))
  const [first, ...others] = upcoming
  const today = isoDate(storeDate(0, new Date(now)))
  const firstToday = !!first && isoDate(storeDate(0, new Date(first.reservation.startAt))) === today
  const shownPast = showAll ? past : past.slice(0, 3)
  const notice = () =>
    void Taro.showModal({
      title: '预约须知',
      content: [
        '· 提交后由店员确认，确认前座位还没锁定。',
        `· 请在开始时间后 ${settings.graceMinutes} 分钟内到店，过了座位会自动放出。`,
        '· 来不了就在这里取消，把座位让给别人。',
        ...(settings.noShowLimit > 0
          ? [
              `· 最近 ${settings.noShowWindowDays} 天里没到店也没取消满 ${settings.noShowLimit} 次，会暂停自助预约一段时间，已有的预约照常有效。`,
            ]
          : []),
      ].join('\n'),
      showCancel: false,
      confirmText: '知道了',
    })
  return (
    <View className="loyalty-content mine">
      {!!resource.error && (
        <RefreshNotice
          retry={() => {
            void resource.refresh()
          }}
        />
      )}
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
      {/* 最近爽约次数达到上限：是否受限由后端说了算，这里提前告诉顾客，不用等下单才知道 */}
      {data.selfServiceSuspended && (
        <View className="my-reservations-suspended" role="status">
          <Text className="strong">暂时不能自助预约</Text>
          <Text>最近爽约次数较多，暂时不能自助预约，请联系门店。已有的预约照常有效。</Text>
          {storeContactActions(storeContact(settings))}
        </View>
      )}
      <View className="mine-head">
        <Text className="mine-title">接下来</Text>
        {!data.selfServiceSuspended && (
          <Button className="mine-book" onClick={book}>
            预约座位
          </Button>
        )}
      </View>
      {first && (
        <View className="mine-next">
          <View className="mine-next-top">
            <Text className="mine-next-day">{dayHeading(first.reservation.startAt, now)}</Text>
            <Text className={`mine-state mine-state-${first.displayStatus}`}>
              {first.displayStatus === 'confirmed' ? '已确认' : '等店员确认'}
            </Text>
          </View>
          <Text className="mine-next-time">
            {storeClock(first.reservation.startAt)}–{storeClock(first.endAt)}
          </Text>
          <Text className="mine-next-until">
            {untilLabel(first.reservation.startAt, now)}
            {Date.parse(first.reservation.startAt) > now ? ' 开始' : ''}
            {first.displayStatus === 'confirmed'
              ? ` · ${storeClock(new Date(Date.parse(first.reservation.startAt) + settings.graceMinutes * 60000))} 前到`
              : ' · 确认前座位还没锁定'}
          </Text>
          <View className="mine-rows">
            <View className="mine-row">
              <Text className="mine-row-label">座位</Text>
              <Text className="mine-row-value">
                {seatText(first, tables)}
                {zoneText(first, tables) ? ` · ${zoneText(first, tables)}` : ''}
              </Text>
            </View>
            <View className="mine-row">
              <Text className="mine-row-label">时长</Text>
              <Text className="mine-row-value">
                {first.reservation.packageName} · {hoursText(first.reservation.durationMinutes)}
              </Text>
            </View>
            {first.reservation.coupon && (
              <View className="mine-row">
                <Text className="mine-row-label">团购</Text>
                <Text className="mine-row-value">{couponText(first.reservation.coupon)}</Text>
              </View>
            )}
            {/* 系统内收费关着时钱在美团、大众点评收，不写到店付多少 */}
            {billing && <Text className="mine-row-price">到店后付 ¥{moneyText(first.reservation.amountCents)}</Text>}
            {noticeLine(first, 'mine-next-notice')}
          </View>
          <View className={`mine-next-actions ${firstToday ? '' : 'mine-next-actions-single'}`}>
            {firstToday && (
              <Button className="mine-scan" disabled={busy} onClick={() => void scan()}>
                到店扫码入座
              </Button>
            )}
            <Button className="mine-cancel" disabled={busy} onClick={() => askCancel(first)}>
              取消预约
            </Button>
          </View>
        </View>
      )}
      {others.map((entry) => {
        const date = storeDate(0, new Date(entry.reservation.startAt))
        return (
          <View className="mine-card enter" key={entry.reservation.id}>
            <View className="mine-card-date">
              <Text className="mine-card-weekday">{weekdayLabel(date)}</Text>
              <Text className="mine-card-day">{date.day}</Text>
            </View>
            <View className="mine-card-copy">
              <Text className="mine-card-title">
                {storeClock(entry.reservation.startAt)}–{storeClock(entry.endAt)} ·{' '}
                {hoursText(entry.reservation.durationMinutes)}
              </Text>
              <Text className="mine-card-meta">
                {seatText(entry, tables)}
                {zoneText(entry, tables) ? ` · ${zoneText(entry, tables)}` : ''}
                {entry.reservation.coupon ? ` · ${couponText(entry.reservation.coupon)}` : ''}
                {billing ? ` · 到店后付 ¥${moneyText(entry.reservation.amountCents)}` : ''}
              </Text>
              <Text className={`mine-state mine-state-${entry.displayStatus}`}>
                {entry.displayStatus === 'confirmed' ? '已确认' : '等店员确认'}
              </Text>
              {noticeLine(entry, 'mine-card-notice')}
            </View>
            <Button
              className="mine-card-cancel"
              disabled={busy}
              ariaLabel={`取消 ${storeClock(entry.reservation.startAt)} 的预约`}
              onClick={() => askCancel(entry)}
            >
              取消
            </Button>
          </View>
        )
      })}
      {!upcoming.length && (
        <SectionEmpty
          title="还没有要来的预约"
          message={
            data.selfServiceSuspended ? '暂时不能自助预约，请联系门店。' : '点上面的「预约座位」，选好时间和座位就行。'
          }
        />
      )}
      {past.length > 0 && (
        <View className="mine-past">
          <View className="mine-head">
            <Text className="mine-title">以前的</Text>
            {past.length > 3 && (
              <Button className="mine-all" onClick={() => setShowAll((value) => !value)}>
                {showAll ? '收起' : `全部 ${past.length} 条`}
              </Button>
            )}
          </View>
          <View className="mine-past-list">
            {shownPast.map((entry) => {
              const date = storeDate(0, new Date(entry.reservation.startAt))
              const night = Number(storeClock(entry.reservation.startAt).slice(0, 2)) >= nightSchoolFromHour
              return (
                <View className="mine-past-row enter" key={entry.reservation.id}>
                  <Text className="mine-past-date">
                    {date.month} 月 {String(date.day).padStart(2, '0')} 日
                  </Text>
                  <Text className="mine-past-copy">
                    {storeClock(entry.reservation.startAt)} · {seatText(entry, tables)} ·{' '}
                    {night ? nightSchoolName : hoursText(entry.reservation.durationMinutes)}
                    {entry.displayStatus === 'cancelled' && entry.reservation.reason
                      ? ` · ${entry.reservation.reason}`
                      : ''}
                  </Text>
                  <Text className={`mine-past-state mine-past-state-${entry.displayStatus}`}>
                    {pastNames[entry.displayStatus] || entry.displayStatus}
                  </Text>
                </View>
              )
            })}
          </View>
        </View>
      )}
      <View className="mine-foot">
        <Text>来不了就提前取消，把座位让给别人。没到店也没取消的次数多了，会暂停一段时间不能预约 · </Text>
        <Button className="mine-foot-link" onClick={notice}>
          预约须知
        </Button>
      </View>
      {cancelling && (
        <CancelReservationSheet
          key={cancelling.reservation.id}
          when={`${dayHeading(cancelling.reservation.startAt, now)} ${storeClock(cancelling.reservation.startAt)}–${storeClock(cancelling.endAt)}`}
          what={`${seatText(cancelling, tables)} · ${hoursText(cancelling.reservation.durationMinutes)}`}
          busy={busy}
          error={cancelError}
          onConfirm={(reason) => void cancel(cancelling, reason)}
          onClose={() => setCancelling(null)}
        />
      )}
    </View>
  )
}
