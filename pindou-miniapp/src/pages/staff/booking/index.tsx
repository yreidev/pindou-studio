import { useMemo, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { Input, ScrollView, Text, Textarea, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import { StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { CustomerPick, minutesText } from '../../../components/staff/table-sheet'
import { type AccountChoice } from '../../../components/staff/account-search'
import { CouponFields } from '../../../components/coupon-fields'
import { useBillingEnabled } from '../../../hooks/billing'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { useRefreshAll } from '../../../hooks/query'
import { couponInput, couponProblem, emptyCouponDraft, type CouponDraft } from '../../../services/coupon'
import { money } from '../../../services/format'
import { bookingMinutes, slotMinutesOf } from '../../../services/packages'
import { returnToPreviousPage } from '../../../services/navigation'
import { StaffError } from '../../../services/staff'
import { zoneOf, type SeatZone } from '../../../services/seatmap'
import {
  isoDate,
  openSlots,
  parseDate,
  reservations,
  reservedOnly,
  seatFree,
  sessionUntil,
  storeClock,
  storeDate,
  weekdayLabel,
} from '../../../services/reservations'
import './index.scss'

// 代客登记（2026-10-20 从预约页拆出来，单独一页；docs/plan-page-redesign.md 第 2 节第 9 条）：
// 顾客（搜账号，或只写称呼）、坐多久、哪天几点到、座位（按区域列出那个时段空着的，不再先选桌、再选座号）、
// 团购和备注选填。电话或当面约的，登记后直接生效，不用顾客再确认。
// 代客登记只把预约当作占用；座位上正在进行的定时会话只提示（员工可以特殊安排），歇业日也只提示，都不挡。

export default function StaffBooking() {
  const billing = useBillingEnabled()
  const live = useStaffEvents(5000)
  const data = useStaffQuery(['reservations', 'open'], reservations.staffOpen, {
    refetchInterval: live.refetchInterval,
  })
  const refreshAll = useRefreshAll()
  const [account, setAccount] = useState<AccountChoice | null>(null)
  const [guestName, setGuestName] = useState('')
  const [packageID, setPackageID] = useState('')
  const [day, setDay] = useState(isoDate(storeDate(0)))
  const [startAt, setStartAt] = useState('')
  const [seatKey, setSeatKey] = useState('')
  const [note, setNote] = useState('')
  const [coupon, setCoupon] = useState<CouponDraft>(emptyCouponDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const view = data.data
  const settings = view?.settings
  const packages = view?.packages || []
  const selected = packages.find((rule) => rule.id === packageID)
  const slots = useMemo(
    () =>
      settings && selected
        ? openSlots(
            settings,
            parseDate(day),
            slotMinutesOf(selected),
            new Date(Date.now() - settings.leadMinutes * 60000),
          )
        : [],
    [settings, selected, day],
  )
  const start = startAt ? new Date(startAt) : null
  // 这次登记占多久（到打烊的算到打烊）
  const minutes = start && selected ? bookingMinutes(selected, start, settings?.closeMinute ?? 0) : 0
  // 那个时段空着的座位，按区域分组。整桌卖的桌（D 区）占的是整张桌，按 1 号座登记（后端整桌一起锁）。
  const seats = useMemo(() => {
    if (!view || !start || !selected) return []
    const held = reservedOnly(view.busy)
    return view.tables.flatMap((table) =>
      (table.wholeTable ? [1] : Array.from({ length: table.seatCount }, (_, index) => index + 1))
        .filter((seat) =>
          table.wholeTable
            ? Array.from({ length: table.seatCount }, (_, i) => i + 1).every((n) =>
                seatFree(held, table.id, n, start, minutes),
              )
            : seatFree(held, table.id, seat, start, minutes),
        )
        .map((seat) => ({
          key: `${table.id}:${seat}`,
          table,
          seat,
          label: table.wholeTable
            ? `${table.code || table.number} 整桌`
            : table.seatCount > 1
              ? `${table.code || table.number}-${seat}`
              : table.code || `${table.number}`,
          until: sessionUntil(view.busy, table.id, seat, start, minutes),
        })),
    )
    // start 每次渲染都是新对象，按它的值算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, startAt, selected, minutes])
  const zones = [...new Set(seats.map((seat) => seat.table.zone || ''))]
  const picked = seats.find((seat) => seat.key === seatKey)
  const days = settings
    ? Array.from({ length: settings.advanceDays + 1 }, (_, offset) => {
        const date = storeDate(offset)
        return {
          value: isoDate(date),
          top: offset === 0 ? '今天' : offset === 1 ? '明天' : weekdayLabel(date),
          day: date.day,
        }
      })
    : []
  // 歇业日（后端按设置算好的 closedDays）顾客不能自助预约；代客登记照常，提示员工和顾客确认
  const dayClosed = (view?.closedDays ?? []).includes(day)
  const name = account ? account.nickname || '会员' : guestName.trim()
  const ready = !!selected && !!start && !!picked && !!name && !couponProblem(coupon)
  const dirty = !!account || !!guestName.trim() || !!note.trim() || !!coupon.platform || !!packageID
  useLeaveGuard(dirty, busy)
  const submit = async () => {
    if (pending.current || !ready || !picked || !selected) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await reservations.action({
        action: 'register',
        accountId: account?.id,
        guestName: account ? undefined : guestName.trim(),
        serviceTableId: picked.table.id,
        seatNumber: picked.seat,
        packageId: selected.id,
        startAt,
        note: note.trim(),
        coupon: couponInput(coupon),
      })
      void Taro.showToast({ title: '已登记', icon: 'success' })
      void refreshAll()
      await returnToPreviousPage(true)
    } catch (e) {
      setError(e instanceof StaffError ? e.message : '登记失败，请重新读取后确认')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const dayText = days.find((value) => value.value === day)?.top || day.slice(5)
  const when = start
    ? `${dayText} ${storeClock(start)}${selected?.untilClose ? ' 到打烊' : `–${storeClock(new Date(start.getTime() + minutes * 60000))}`}`
    : '还没选时间'
  return (
    <StaffScreen title="代客登记" loading={data.loading} error={data.error} stale={!!view} onRetry={data.refresh}>
      {view && settings && (
        <View className="booking-form">
          <Text className="booking-intro">
            电话或当面约的，登记后直接生效，不用顾客再确认。
            {billing ? '预约不收钱，到店开台后才有套餐订单。' : '顾客在美团、大众点评买了团购的，可以在下面记下来。'}
          </Text>
          <View className="booking-section">
            <Text className="booking-label">顾客</Text>
            <CustomerPick value={account} onChange={setAccount} disabled={busy} />
            {!account && (
              <Input
                className="input booking-name"
                ariaLabel="没有账号就写个称呼"
                value={guestName}
                disabled={busy}
                maxlength={40}
                placeholder="没有账号就写个称呼，如「王阿姨」"
                onInput={(event) => setGuestName(event.detail.value)}
              />
            )}
            <Text className="booking-help">没有账号的写个称呼就行，不记手机号；到店再关联账户，或者当散客开台。</Text>
          </View>
          <View className="booking-section">
            <Text className="booking-label">坐多久</Text>
            <View className="booking-grid">
              {packages.map((rule) => (
                <Button
                  key={rule.id}
                  className={`booking-choice ${packageID === rule.id ? 'booking-choice-on' : ''}`}
                  disabled={busy}
                  onClick={() => {
                    setPackageID(rule.id)
                    setStartAt('')
                    setSeatKey('')
                  }}
                >
                  <Text>{rule.untilClose ? rule.name : minutesText(rule.durationMinutes)}</Text>
                  {billing && <Text className="booking-choice-note">¥{money(rule.amountCents)}</Text>}
                </Button>
              ))}
            </View>
            {packages.length === 0 && <Text className="booking-help">还没有发布计时套餐，登记不了预约。</Text>}
          </View>
          {selected && (
            <View className="booking-section">
              <Text className="booking-label">哪天几点到</Text>
              <ScrollView scrollX className="booking-dates">
                {days.map((value) => (
                  <Button
                    key={value.value}
                    className={`booking-date ${day === value.value ? 'booking-date-on' : ''}`}
                    disabled={busy}
                    onClick={() => {
                      setDay(value.value)
                      setStartAt('')
                      setSeatKey('')
                    }}
                  >
                    <Text className="booking-date-top">{value.top}</Text>
                    <Text className="booking-date-day">{value.day}</Text>
                  </Button>
                ))}
              </ScrollView>
              {dayClosed && (
                <View className="booking-warning" role="alert">
                  这天是歇业日，顾客不能自助预约；代客登记照常可以，请和顾客确认门店这天会有人接待。
                </View>
              )}
              <View className="booking-grid booking-grid-4">
                {slots.map((slot) => {
                  const value = slot.toISOString()
                  return (
                    <Button
                      key={value}
                      className={`booking-choice ${startAt === value ? 'booking-choice-on' : ''}`}
                      disabled={busy}
                      onClick={() => {
                        setStartAt(value)
                        setSeatKey('')
                      }}
                    >
                      {storeClock(slot)}
                    </Button>
                  )
                })}
              </View>
              {slots.length === 0 && <Text className="booking-help">这天已经没有能登记的时间了，换一天。</Text>}
            </View>
          )}
          {selected && start && (
            <View className="booking-section">
              <Text className="booking-label">
                座位
                <Text className="booking-label-note">
                  {' '}
                  · {dayText} {storeClock(start)} 起空着的
                </Text>
              </Text>
              {zones.map((zone) => (
                <View className="booking-zone" key={zone || 'none'}>
                  <Text className="booking-zone-name">
                    {zone} {zoneOf(zone as SeatZone)?.name || ''}
                  </Text>
                  <View className="booking-zone-seats">
                    {seats
                      .filter((seat) => (seat.table.zone || '') === zone)
                      .map((seat) => (
                        <Button
                          key={seat.key}
                          className={`booking-seat ${seatKey === seat.key ? 'booking-seat-on' : ''}`}
                          disabled={busy}
                          ariaLabel={`${seat.label}${seat.until ? `，现场使用中到 ${storeClock(seat.until)}` : ''}`}
                          onClick={() => setSeatKey(seat.key)}
                        >
                          {seat.label}
                          {seat.until ? '*' : ''}
                        </Button>
                      ))}
                  </View>
                </View>
              ))}
              {seats.length === 0 && <Text className="booking-help">这个时段的座位都约满了，换个时间。</Text>}
              {seats.some((seat) => seat.until) && (
                <Text className="booking-help">带 * 的座位现场正在使用，到时候才空出来。</Text>
              )}
              {picked?.until && (
                <View className="booking-warning" role="alert">
                  {picked.label} 现场正在使用，到 {storeClock(picked.until)}{' '}
                  才空出；代客登记照常可以，请和顾客确认到店时间。
                </View>
              )}
            </View>
          )}
          <View className="booking-section">
            <CouponFields value={coupon} onChange={setCoupon} disabled={busy} />
            <Text className="booking-label">备注（选填）</Text>
            <Textarea
              className="input booking-note"
              maxlength={200}
              disabled={busy}
              value={note}
              placeholder="同行人数、要求等"
              onInput={(event) => setNote(event.detail.value)}
            />
          </View>
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          <View className="booking-footer">
            <View className="booking-footer-copy">
              <Text className="booking-footer-main">
                {name || '还没填顾客'} · {picked ? picked.label : '还没选座位'}
              </Text>
              <Text className="booking-footer-note">{when}</Text>
            </View>
            <Button className="booking-submit" disabled={!ready || busy} loading={busy} onClick={() => void submit()}>
              登记
            </Button>
          </View>
        </View>
      )}
    </StaffScreen>
  )
}
