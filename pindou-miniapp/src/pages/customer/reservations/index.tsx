import { useEffect, useMemo, useState } from 'react'
import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter, useShareAppMessage } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { DoneMark } from '../../../components/done-mark'
import { SheetCloseButton, SheetFrame } from '../../../components/sheet'
import {
  AuthBoundary,
  Failure,
  RefreshNotice,
  Screen,
  SectionEmpty,
  Skeleton,
  Status,
} from '../../../components/customer'
import { storeContactActions } from '../../../components/customer/store-contact'
import { CouponFields } from '../../../components/coupon-fields'
import { useBillingEnabled } from '../../../hooks/billing'
import { useCustomerQuery } from '../../../hooks/query'
import { couponInput, couponProblem, emptyCouponDraft, type CouponDraft } from '../../../services/coupon'
import { customerMessage } from '../../../services/customer'
import { moneyText } from '../../../services/format'
import { bookingMinutes, byDuration, packageDuration, slotMinutesOf } from '../../../services/packages'
import {
  contactLine,
  dayLabel,
  openSlots,
  reservations,
  seatFree,
  slotFromParam,
  storeClock,
  storeContact,
  storeDate,
  weekdayLabel,
  type ReservationView,
  type StoreDate,
} from '../../../services/reservations'
import { reservationShare } from '../../../services/share'
import { navigateApp } from '../../../services/navigation'
import { askNotices, bookingNotices, saveNotices } from '../../../services/notices'
import { facilityLegends, mapSeats, planSize, roomNotes, zoneOf, zoneSeatCount, zones } from '../../../services/seatmap'
import { brandSlogan, nightSchoolFromHour, nightSchoolName, seatMapSubtitle, seatMapTitle } from '../../../brand'
import './index.scss'

// 平面图坐标按底图像素给出，这里换算成百分比，底图换分辨率不必改数据。
const pct = (value: number, total: number) => `${((value / total) * 100).toFixed(3)}%`
const boxOf = (o: { x: number; y: number; w: number; h: number }) => ({
  left: pct(o.x, planSize.width),
  top: pct(o.y, planSize.height),
  width: pct(o.w, planSize.width),
  height: pct(o.h, planSize.height),
})

const pad2 = (value: number) => String(value).padStart(2, '0')
// 日期一律存成绝对的 YYYY-MM-DD。存「第几天」的话，跨过零点同一个偏移指向的日期就变了，
// 页面上显示的和实际提交的 startAt 会对不上。
const isoOf = (d: StoreDate) => `${d.year}-${pad2(d.month)}-${pad2(d.day)}`
const dateOf = (iso: string): StoreDate => {
  const [year, month, day] = iso.split('-').map(Number)
  return { year, month, day }
}
const rangeLabel = (slot: Date, minutes: number) =>
  `${storeClock(slot)}–${storeClock(new Date(slot.getTime() + minutes * 60000))}`
const seatKey = (table: string, seat: number) => `${table}#${seat}`

/**
 * 这个时段算不算「示例工坊夜校」。
 *
 * ★ 必须按**门店本地时间**判，不能用 slot.getHours() —— 那读的是手机所在时区。
 *   顾客人在别的时区（或手机时区设歪了）时，同一个时段会一会儿是夜校一会儿不是。
 *   storeClock 已经做过 UTC+8 换算，取它的小时数就对了。
 */
const isNight = (slot: Date) => Number(storeClock(slot).slice(0, 2)) >= nightSchoolFromHour

/** 图上点中的座位：code 是底图编号（B3），place 是「B 区 · 靠窗单人间」 */
type PickedSeat = { code: string; place: string; serviceTableId: string; seatNumber: number; people: number }

// 「到打烊」的套餐（untilClose）没有固定时长：在打烊前的任一时段开始，一直约到当天打烊（后端同样这么算）。
// 列时段按 slotMinutesOf（至少 1 分钟），占不占座、时段写成几点到几点按 bookingMinutes（开始到打烊）。
// 系统内收费关着时（钱在美团、大众点评收）不写价格和「到店付」，换成选填的团购记录。

export default function Reservations() {
  const resource = useCustomerQuery(['reservations'], reservations.me)
  const data = resource.data
  const settings = data?.settings
  const packages = useMemo(() => byDuration(data?.packages || []), [data?.packages])
  const billing = useBillingEnabled()
  /** 这个套餐从 slot 开始要占多久（到打烊的算到打烊）。 */
  const minutesAt = (rule: (typeof packages)[number], slot: Date) =>
    bookingMinutes(rule, slot, settings?.closeMinute ?? 0)

  // 首页「今天还能约」点的那个整点（?at=Unix 秒）：图上先只亮这个时间还排得下的座位，点座位时直接选好这个时段。
  // 顾客换了日期、点了「看全天」就不再按它筛。
  const { params } = useRouter()
  const [wanted, setWanted] = useState(() => slotFromParam(params.at))
  // '' = 顾客还没亲手选过日期。这时页面跟着「最近一个还排得出时段的日子」走：晚上打开，
  // 今天已经没有可约时段，第一屏不该是一句「没有」，而是直接站在明天。顾客点过日期条
  // 之后就以他选的为准，哪怕那天是空的——那是他自己要看的。从首页点了整点进来的，站在那个整点的那天；
  // 朋友转来的带着日期（?date=YYYY-MM-DD）的，站在那天（不在可约天数里了就照常跟着最近一个日子走）。
  const [chosenISO, setChosenISO] = useState(() => {
    const at = slotFromParam(params.at)
    if (at) return isoOf(storeDate(0, at))
    return /^\d{4}-\d{2}-\d{2}$/.test(params.date || '') ? params.date! : ''
  })
  const [picked, setPicked] = useState<PickedSeat | null>(null)
  // 预约提交成功：弹层不关，换成勾和这次约的座位、时段（docs/plan-interaction.md 第 3 节）
  const [booked, setBooked] = useState<{ code: string; when: string } | null>(null)
  // 顾客亲手点过的套餐、时段；没点过时套餐默认第一个（从首页整点进来的是排得进那个整点的最短套餐），时段默认那个整点
  const [packageChoice, setPackageChoice] = useState('')
  const [slotChoice, setSlotChoice] = useState('')
  const [note, setNote] = useState('')
  const [coupon, setCoupon] = useState<CouponDraft>(emptyCouponDraft)
  // 出错时连错误码一起记：超出每人上限时，说明后面要接门店联系方式
  const [failure, setFailure] = useState({ message: '', code: '' })
  const error = failure.message
  const setError = (message: string, code = '') => setFailure({ message, code })
  // 超出每人上限、爽约暂停：说明后面接门店联系方式
  const limited = failure.code === 'reservation_limit_reached' || failure.code === 'reservation_suspended'
  const [busyForm, setBusyForm] = useState(false)
  // 点了「提交预约」到出结果之间（预约须知、订阅框、提交）：弹层锁住，点遮罩、往下拖都关不掉。
  // 不锁的话，两个弹框之间的空当里碰一下遮罩，弹层就关了，提交成功的那个勾也就看不到了。
  const [confirming, setConfirming] = useState(false)
  const sheetLocked = busyForm || confirming
  // 可约时段随时间推移会失效，但这些都是 useMemo 算出来的，依赖里没有时间就永远是
  // 打开页面那一刻的快照：图上一直说「有空闲」，抽屉里选中的时段过期了也照样能点，
  // 提交被打回后列表还是原样，顾客陷在同一条错误里出不来。每分钟推一次这个计数。
  const [minute, setMinute] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setMinute((value) => value + 1), 60000)
    return () => clearInterval(timer)
  }, [])

  const days = useMemo(
    // 显示 advanceDays 天（含今天）。再多一天只在当前钟点之前可约，摆出来只会让人以为被订满。
    () => (settings ? Array.from({ length: settings.advanceDays }, (_, offset) => storeDate(offset)) : []),
    [settings, minute], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 歇业日（含每周休息日）由后端算好放在 closedDays 里，这里只查不推算。歇业日排不出任何时段，
  // 日期条写「店休」，图上整张压灰——和「已约满」是两回事。
  const closedDays = useMemo(() => new Set(data?.closedDays ?? []), [data?.closedDays])
  // 日期只在挂载时算一次，跨过零点后它会掉出 days 窗口：横条上没有一个高亮，
  // 而那一天的时段全成了过去时，整张图会被画成「全店订满」。掉窗就退回第一天。
  const inWindow = (iso: string) => days.some((date) => isoOf(date) === iso)
  // 这一天能不能排出至少一个时段（任一套餐）。排不出来跟「座位被订满」是两回事。
  const hasSlots = (date: StoreDate) =>
    !!settings &&
    !closedDays.has(isoOf(date)) &&
    packages.some((rule) => openSlots(settings, date, slotMinutesOf(rule)).length > 0)
  const firstOpen = useMemo(() => days.find(hasSlots), [days, settings, packages, closedDays, minute]) // eslint-disable-line react-hooks/exhaustive-deps
  const todayISO = isoOf(days[0] || storeDate(0))
  const autoISO = firstOpen ? isoOf(firstOpen) : todayISO
  const activeDay = chosenISO && inWindow(chosenISO) ? chosenISO : autoISO
  // 顾客没选、而页面自己从今天挪到了别的日子——要告诉他一声，不然他以为今天还能约
  const autoSwitched = !chosenISO && activeDay !== todayISO
  const dayClosed = closedDays.has(activeDay)
  const sheetDay = activeDay
  const mapping = useMemo(() => mapSeats(data?.tables || []), [data?.tables])

  // 某一天这个座位还有没有可约的时段。图上先只分「有空闲 / 已约满」，具体时段进抽屉再选；
  // 不先算出这一层，整张图在选时段之前就没有任何信息量。
  const dayOpen = useMemo(() => {
    const open = new Set<string>()
    if (!settings || !data || closedDays.has(activeDay)) return open
    const day = dateOf(activeDay)
    const candidates = mapping.seats
      .filter((seat) => !seat.disabled)
      .map((seat) => [seat.serviceTableId, seat.seatNumber] as const)
    for (const rule of packages) {
      for (const slot of openSlots(settings, day, slotMinutesOf(rule))) {
        for (const [table, seat] of candidates) {
          const key = seatKey(table, seat)
          if (!open.has(key) && seatFree(data.busy, table, seat, slot, minutesAt(rule, slot))) open.add(key)
        }
      }
    }
    return open
  }, [settings, data, packages, mapping.seats, activeDay, closedDays, minute]) // eslint-disable-line react-hooks/exhaustive-deps

  // 首页带来的整点：哪些套餐排得进这个时段（过了最短提前量、排不下的套餐不算），以及哪些座位这时还空着。
  // 一个套餐都排不进是时间已过（past）；排得进但座位都被占了是 full。不是这一天的、没带整点的为 null，图照常按全天画。
  const wantedRules = useMemo(() => {
    if (!wanted || !settings || closedDays.has(activeDay) || isoOf(storeDate(0, wanted)) !== activeDay) return null
    const day = dateOf(activeDay)
    return packages.filter((rule) =>
      openSlots(settings, day, slotMinutesOf(rule)).some((slot) => slot.getTime() === wanted.getTime()),
    )
  }, [wanted, settings, packages, activeDay, closedDays, minute]) // eslint-disable-line react-hooks/exhaustive-deps
  const fitsWanted = (rule: (typeof packages)[number], table: string, seat: number) =>
    !!wanted && !!data && seatFree(data.busy, table, seat, wanted, minutesAt(rule, wanted))
  const wantedOpen = useMemo(() => {
    if (!wantedRules) return null
    const open = new Set<string>()
    for (const seat of mapping.seats) {
      if (seat.disabled) continue
      if (wantedRules.some((rule) => fitsWanted(rule, seat.serviceTableId, seat.seatNumber)))
        open.add(seatKey(seat.serviceTableId, seat.seatNumber))
    }
    return open
  }, [wantedRules, mapping.seats, data]) // eslint-disable-line react-hooks/exhaustive-deps
  const wantedState = !wantedOpen ? null : wantedRules?.length ? (wantedOpen.size ? 'open' : 'full') : 'past'
  // 图上标空闲、给热区用的那一份：按整点筛着的时候只算这个整点
  const seatOpen = wantedState === 'open' && wantedOpen ? wantedOpen : dayOpen

  // 超出「最多提前 N 天」那一刻之后、或今天已过最后一个可约时段，当天一个时段都排不出来。
  // 这跟「座位被别人订满」是两回事，混成一句「已约满」等于告诉顾客一条不存在的事实。
  const dayHasSlots = useMemo(() => hasSlots(dateOf(activeDay)), [settings, packages, activeDay, closedDays, minute]) // eslint-disable-line react-hooks/exhaustive-deps

  // 1）坐多久：顾客点过的；没点过时，从首页整点进来的取排得进那个整点的最短套餐，其余取第一个
  const wantedFit =
    wantedState === 'open' && wanted && wantedRules
      ? wantedRules.slice().sort((a, b) => minutesAt(a, wanted) - minutesAt(b, wanted))[0]
      : undefined
  const selectedPackage = packages.find((rule) => rule.id === packageChoice) || wantedFit || packages[0]
  const packageID = selectedPackage?.id || ''
  // 2）几点开始：这一天按所选套餐排得出的时段
  const slots = useMemo(
    () =>
      settings && selectedPackage && sheetDay && !closedDays.has(sheetDay)
        ? openSlots(settings, dateOf(sheetDay), slotMinutesOf(selectedPackage))
        : [],
    [settings, selectedPackage, sheetDay, closedDays, minute], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 选好时段后时间还在走：过了最短提前量的时段会从 slots 里消失，此时必须一并作废选择，
  // 否则按钮仍可点、提交一个已经不能约的时间。
  const startAt =
    slotChoice ||
    (wantedState === 'open' && wanted && slots.some((slot) => slot.getTime() === wanted.getTime())
      ? wanted.toISOString()
      : '')
  const startValid = !!startAt && slots.some((slot) => slot.toISOString() === startAt)
  const start = startValid ? new Date(startAt) : null
  // 转发给朋友：选了几点就带上这个时段，没选时带上顾客点过的日期（docs/plan-notify-and-share.md 第 1 节）
  useShareAppMessage(() => reservationShare(start, chosenISO && inWindow(chosenISO) ? chosenISO : ''))
  // 每个时段还空着几个位置（按所选套餐占多久算，现场正在用的也算占用）
  const openAt = (slot: Date) =>
    !selectedPackage || !data
      ? []
      : mapping.seats.filter(
          (seat) =>
            !seat.disabled &&
            seatFree(data.busy, seat.serviceTableId, seat.seatNumber, slot, minutesAt(selectedPackage, slot)),
        )
  const slotCounts = useMemo(
    () => slots.map((slot) => ({ slot, free: openAt(slot).length })),
    [slots, selectedPackage, data, mapping.seats], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // 3）图上框出的座位：选了时段就是那个时段空着的；还没选时只按当天有没有空画，不给点
  const startOpen = useMemo(
    () => new Set(start ? openAt(start).map((seat) => seatKey(seat.serviceTableId, seat.seatNumber)) : []),
    // slots 跟着每分钟的计数重算：时间推进后这一份也要跟着重算，不能停在打开页面那一刻
    [startAt, slots, selectedPackage, data, mapping.seats], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const shownOpen = start ? startOpen : seatOpen
  const freeSeats = mapping.seats.filter(
    (seat) => !seat.disabled && shownOpen.has(seatKey(seat.serviceTableId, seat.seatNumber)),
  ).length
  const bookableSeats = mapping.seats.filter((seat) => !seat.disabled).length

  const slotFree = (slot: Date) =>
    !!picked &&
    !!selectedPackage &&
    !!data &&
    seatFree(data.busy, picked.serviceTableId, picked.seatNumber, slot, minutesAt(selectedPackage, slot))
  const couponError = couponProblem(coupon)
  const ready = !!picked && !!selectedPackage && !!start && slotFree(start) && !couponError

  const openSheet = (seat: PickedSeat) => {
    setPicked(seat)
    setNote('')
    setCoupon(emptyCouponDraft)
    setError('')
  }
  const closeSheet = () => {
    setPicked(null)
    setBooked(null)
    setError('')
  }
  const run = async (input: Parameters<typeof reservations.action>[0], done?: (view: ReservationView) => void) => {
    if (busyForm) return
    setBusyForm(true)
    setError('')
    try {
      done?.(await reservations.action(input))
      await resource.refresh()
    } catch (e) {
      // 文案走 customerMessage：上限这类有固定说法的，不照搬服务端 message
      const code = (e as { code?: string } | null)?.code || ''
      setError(customerMessage(e, '操作失败，请刷新后重试'), code)
      // 歇业、现场占用、爽约暂停是页面拿到的数据过时了：重读一次，图和日期条跟上后端
      if (code === 'store_closed' || code === 'seat_in_use' || code === 'reservation_suspended') void resource.refresh()
    } finally {
      setBusyForm(false)
    }
  }

  // 门店联系方式来自预约设置（老板在网页后台填），没填就不显示，前面的话里已经写了「联系门店」
  const contact = storeContact(settings)
  const contactText = contactLine(contact)
  const contactActions = () => storeContactActions(contact)

  // 「预约须知」写的都是现行规则：不收费、待员工确认、迟到宽限、怎么取消。
  // 顶上的「?」只看，提交前那次要按「确认预约」才真的下单。
  const notice = (confirm: boolean) => ({
    title: '预约须知',
    content: [
      billing
        ? `· 预约本身不收费，到店后按所选套餐计费。`
        : `· 预约不收费；在美团、大众点评买了团购的，到店出示券码，由店员核销。`,
      `· 提交后由员工确认，确认前座位尚未锁定。`,
      `· 最多提前 ${settings?.advanceDays ?? 0} 天、至少提前 ${settings?.leadMinutes ?? 0} 分钟预约。`,
      `· 请在开始时间后 ${settings?.graceMinutes ?? 0} 分钟内到店，逾期座位自动释放。`,
      `· 如需取消，请在「我的预约」里操作。`,
      ...roomNotes.map((note) => `· ${note}`),
      ...(contactText ? [`· 联系门店：${contactText}`] : []),
    ].join('\n'),
    showCancel: confirm,
    confirmText: confirm ? '确认预约' : '知道了',
    cancelText: '再想想',
  })

  const submit = () => {
    if (!ready || !picked || !selectedPackage || !settings) return
    // slots 只在套餐、日期或数据变化时重算，顾客停在抽屉里挑时段时它不会自己过期。
    // 不在这里按当前时间复核一次，就会提交一个已经不能约的时间，由后端报一句看不懂的话。
    const day = dateOf(sheetDay)
    if (!openSlots(settings, day, slotMinutesOf(selectedPackage)).some((s) => s.toISOString() === startAt)) {
      setSlotChoice('')
      setMinute((value) => value + 1)
      setError('刚才选的时段已经过了可预约时间，请重新选择。')
      return
    }
    if (confirming) return
    setConfirming(true)
    void (async () => {
      try {
        const result = await Taro.showModal(notice(true))
        if (!result.confirm) return
        // 微信提醒：订阅框要紧跟顾客的点击，按下「确认预约」就弹，一次订确认、提醒、取消三种；拒绝了照常提交，不追问
        const kinds = await askNotices(data?.noticeTemplates ?? [], bookingNotices)
        const summary = { code: picked.code, when: `${sheetDate.month} 月 ${sheetDate.day} 日 ${dayName} · ${range}` }
        await run(
          {
            action: 'book',
            serviceTableId: picked.serviceTableId,
            seatNumber: picked.seatNumber,
            packageId: selectedPackage.id,
            startAt,
            note: note.trim(),
            coupon: couponInput(coupon),
          },
          (view) => {
            setNote('')
            setCoupon(emptyCouponDraft)
            setSlotChoice('')
            setWanted(null)
            setBooked(summary)
            // 记下允许了哪几种；没记上也不打扰，顾客还能在「我的预约」里再开
            if (kinds.length && view.targetId) void saveNotices(view.targetId, kinds).catch(() => undefined)
          },
        )
      } catch {
        // 预约须知的弹框没弹出来：什么都没提交，留在弹层里重新点就行
      } finally {
        setConfirming(false)
      }
    })()
  }

  const dayStrip = (current: string, pick: (iso: string) => void) => (
    <View className="plan-days">
      {days.map((date, offset) => {
        const iso = isoOf(date)
        const on = iso === current
        const closed = closedDays.has(iso)
        return (
          <Button
            key={iso}
            className={`plan-day ${on ? 'plan-day-on' : ''} ${closed ? 'plan-day-closed' : ''}`}
            disabled={busyForm}
            ariaLabel={`${dayLabel(date, offset)}${closed ? '，店休' : ''}${on ? '，已选中' : ''}`}
            onClick={() => pick(iso)}
          >
            <Text className="plan-day-week">{closed ? '店休' : offset === 0 ? '今天' : weekdayLabel(date)}</Text>
            <Text className="plan-day-date">
              {date.month}/{date.day}
            </Text>
          </Button>
        )
      })}
    </View>
  )

  const dayOffset = days.findIndex((d) => isoOf(d) === sheetDay)
  const sheetDate = dateOf(sheetDay)
  const dayName = ['今天', '明天', '后天'][dayOffset] || weekdayLabel(sheetDate)
  const range = start && selectedPackage ? rangeLabel(start, minutesAt(selectedPackage, start)) : ''
  const durationText = selectedPackage
    ? selectedPackage.untilClose
      ? '到今天打烊'
      : packageDuration(selectedPackage)
    : ''
  const anyFree = slotCounts.some((item) => item.free > 0)

  return (
    <Screen title="预约座位" back className="reservation-screen">
      <AuthBoundary>
        {resource.loading ? (
          <Skeleton />
        ) : !data || !settings ? (
          <Failure
            error={resource.error}
            retry={() => {
              void resource.refresh()
            }}
          />
        ) : (
          <View className="loyalty-content plan-content">
            {!!resource.error && (
              <RefreshNotice
                retry={() => {
                  void resource.refresh()
                }}
              />
            )}
            {error && !picked && (
              <View className="field-error" role="alert">
                {error}
              </View>
            )}
            {error && !picked && limited && contactActions()}

            {!settings.enabled ? (
              <Status kind="empty" title="自助预约暂未开放" message="门店暂时关闭了小程序预约，可联系员工代为登记。" />
            ) : data.selfServiceSuspended ? (
              // 是否受限由后端说了算（最近爽约次数达到老板设的上限），提前告诉顾客，不等下单被拒
              <>
                <Status
                  kind="empty"
                  title="暂时不能自助预约"
                  message="最近爽约次数较多，暂时不能自助预约，请联系门店。"
                />
                {contactActions()}
              </>
            ) : packages.length === 0 ? (
              <SectionEmpty title="套餐暂未开放" message="门店发布计时套餐后即可预约。" />
            ) : (
              <>
                {dayStrip(activeDay, (iso) => {
                  setChosenISO(iso)
                  setWanted(null)
                  setSlotChoice('')
                  setError('')
                })}

                {/* 从首页点的整点：排得下就直接选好，下面的时段格里看得到；排不下才说一声 */}
                {wanted && (wantedState === 'full' || wantedState === 'past') && (
                  <View className="plan-wanted" role="status">
                    <Text className="plan-wanted-text">
                      {wantedState === 'full'
                        ? `${storeClock(wanted)} 开始的座位刚被约完了，换个时间看看。`
                        : `${storeClock(wanted)} 已经过了可预约的时间，换个时间看看。`}
                    </Text>
                  </View>
                )}

                {autoSwitched && dayHasSlots && (
                  <View className="field-help" role="status">
                    {closedDays.has(todayISO) ? '今天门店歇业' : '今天的可约时段已过'}，已切到 {sheetDate.month} 月{' '}
                    {sheetDate.day} 日。
                  </View>
                )}
                {/*
                  日期条只给 advanceDays 天，「超出最多提前 N 天」这种情况从界面上进不去，
                  不用在文案里猜。没时段的只有两种：顾客自己点了一个空的日子；或近几天都排不出来。
                  这是正常状态不是出错，不用红字。
                */}
                {!dayHasSlots && (
                  <View className="field-help" role="alert">
                    {dayClosed
                      ? firstOpen
                        ? '门店这天歇业（店休），请在上面换一天。'
                        : `门店这天歇业，最近 ${settings.advanceDays} 天都排不出可约时段，请稍后再看。`
                      : firstOpen
                        ? '这一天没有可约时段，请在上面换一天。'
                        : `最近 ${settings.advanceDays} 天都排不出可约时段，请稍后再看。`}
                  </View>
                )}

                {dayHasSlots && (
                  <>
                    <Text className="plan-question">坐多久</Text>
                    <View className="plan-packages">
                      {packages.map((rule) => {
                        const on = packageID === rule.id
                        return (
                          <Button
                            key={rule.id}
                            className={`plan-package ${on ? 'plan-package-on' : ''}`}
                            disabled={busyForm}
                            ariaLabel={`${rule.name}，${packageDuration(rule)}${billing ? `，${moneyText(rule.amountCents)} 元` : ''}${on ? '，已选中' : ''}`}
                            onClick={() => {
                              setPackageChoice(rule.id)
                              // 换了时长，原来选的几点还排得进就留着，排不进就作废
                              const keep =
                                !!startAt &&
                                openSlots(settings, sheetDate, slotMinutesOf(rule)).some(
                                  (slot) => slot.toISOString() === startAt,
                                )
                              setSlotChoice(keep ? startAt : '')
                              setError('')
                            }}
                          >
                            <Text className="plan-package-name">{rule.name}</Text>
                            {billing && <Text className="plan-package-note">¥{moneyText(rule.amountCents)}</Text>}
                          </Button>
                        )
                      })}
                    </View>

                    <Text className="plan-question">几点开始</Text>
                    {slots.length === 0 ? (
                      <Text className="field-help">这一天排不下「{selectedPackage?.name}」了，换个时长或换一天。</Text>
                    ) : (
                      <>
                        {!anyFree && (
                          <Text className="field-help">
                            这一天「{selectedPackage?.name}」都约满了，换个时长或换一天。
                          </Text>
                        )}
                        <View className="plan-slots">
                          {slotCounts.map(({ slot, free }) => {
                            const value = slot.toISOString()
                            const on = startValid && startAt === value
                            return (
                              <Button
                                key={value}
                                className={`plan-slot ${on ? 'plan-slot-on' : ''}`}
                                disabled={busyForm || free === 0}
                                ariaLabel={`${storeClock(slot)} 开始，${free ? `还能约 ${free} 个位置` : '已约满'}${on ? '，已选中' : ''}`}
                                onClick={() => {
                                  setSlotChoice(value)
                                  setError('')
                                }}
                              >
                                <Text className="plan-slot-time">{storeClock(slot)}</Text>
                                <Text className="plan-slot-state">
                                  {/* ★ 夜校只是给晚间时段贴个名字，不改变可不可约 —— 能不能约仍看余座。
                                      约满时不挂活动名：那时这颗按钮点不动，再挂个名字是噪音。 */}
                                  {free === 0 ? '已满' : isNight(slot) ? nightSchoolName : `余 ${free}`}
                                </Text>
                              </Button>
                            )
                          })}
                        </View>
                      </>
                    )}
                  </>
                )}

                {/*
                  ★ 停用的桌（后端不下发）在图上画成 off、不给热区，其余照常可约；没有「整张图不给用」的分支了，
                    见 services/seatmap.ts 的 mapSeats。
                  ★★ 原先这里还有一份「按桌号选座」的兜底列表，2026-09-19 删掉了，业主确认不加回来：
                    它照 seatCount 一路列、不看停用，会把**停用的桌也列出来卖**，还会把整桌单位拆成两个座。
                */}
                <View className="plan-title">
                  <View className="plan-title-copy">
                    <Text className="plan-title-text">{seatMapTitle}</Text>
                    <Text className="plan-title-sub">{seatMapSubtitle}</Text>
                  </View>
                  <Button className="plan-help" ariaLabel="预约须知" onClick={() => void Taro.showModal(notice(false))}>
                    ?
                  </Button>
                </View>
                <View className="seatmap-plan">
                  <Image
                    className="seatmap-image"
                    src="/assets/seatmap/plan.jpg"
                    mode="widthFix"
                    ariaLabel="门店平面图"
                  />
                  {mapping.seats.map((seat) => {
                    // 底图已经给每个座位画了边框和编号。选好时段后，那时空着的座位框金边、可以点；
                    // 还没选时段只按当天有没有空画，约满的压灰。门店停用的桌（坏了、在维护）画成 off，
                    // 和「已约满」分开：约满的明天可能有位，停用的今天明天都没有，不该给顾客同一种暗示。
                    const key = seatKey(seat.serviceTableId, seat.seatNumber)
                    const mark = seat.disabled
                      ? 'off'
                      : !dayHasSlots
                        ? 'dim'
                        : start
                          ? startOpen.has(key)
                            ? 'pick'
                            : 'taken'
                          : seatOpen.has(key)
                            ? 'free'
                            : 'taken'
                    return (
                      <View
                        key={`mark-${seat.id}`}
                        className={`seatmap-mark seatmap-mark-${mark}`}
                        style={boxOf(seat)}
                      />
                    )
                  })}
                  {start &&
                    mapping.seats.map((seat) => {
                      if (seat.disabled) return null
                      if (!startOpen.has(seatKey(seat.serviceTableId, seat.seatNumber))) return null
                      const area = zoneOf(seat.zone)
                      return (
                        <Button
                          key={`hit-${seat.id}`}
                          className="seatmap-hit"
                          style={boxOf(seat)}
                          disabled={busyForm}
                          ariaLabel={`${seat.id}，${area?.name} ${area?.desc}，${seat.tableNumber} 号桌 ${seat.seatNumber} 号座，${storeClock(start)} 有空`}
                          onClick={() =>
                            openSheet({
                              code: seat.id,
                              place: [area?.name, area?.desc].filter(Boolean).join(' · '),
                              serviceTableId: seat.serviceTableId,
                              seatNumber: seat.seatNumber,
                              people: seat.people,
                            })
                          }
                        />
                      )
                    })}
                </View>
                {dayHasSlots && (
                  <View className="plan-map-note">
                    <Text className="plan-map-note-text">
                      {start
                        ? `${range} 还能约 ${freeSeats} 个位置，点框起来的座位预约`
                        : `先在上面选几点开始，图上会框出那时空着的座位 · 当天空闲 ${freeSeats}／${bookableSeats}`}
                    </Text>
                    <Button className="text-button" onClick={() => void Taro.showModal(notice(false))}>
                      预约须知
                    </Button>
                  </View>
                )}

                <View className="plan-zones-card">
                  <View className="plan-zones-grid">
                    {zones.map((item) => (
                      <View className="plan-zone-row" key={item.key}>
                        <Text className="plan-zone-swatch" style={{ background: item.color }} />
                        <Text className="plan-zone-name">{item.name}</Text>
                        <Text className="plan-zone-desc">
                          {item.seatsPerUnit > 1
                            ? `${zoneSeatCount(item.key)} 张 ${item.seatsPerUnit} 人桌`
                            : `${zoneSeatCount(item.key)} 座`}
                        </Text>
                      </View>
                    ))}
                    {facilityLegends.map((item) => (
                      <View className="plan-zone-row" key={item.name}>
                        <Text className="plan-zone-swatch" style={{ background: item.color }} />
                        <Text className="plan-zone-name">{item.name}</Text>
                      </View>
                    ))}
                  </View>
                  {roomNotes.map((note) => (
                    <Text className="plan-room-note" key={note}>
                      {note}
                    </Text>
                  ))}
                  {roomNotes.length > 0 && contactActions()}
                  <Text className="plan-zones-note">
                    <Text className="plan-key plan-key-taken" />
                    {dayHasSlots
                      ? ' 灰色为这时已约满（含现场正在使用）'
                      : dayClosed
                        ? ' 门店这天歇业'
                        : ' 这一天没有可预约的时段'}
                  </Text>
                </View>
                <Text className="plan-footer">{brandSlogan}</Text>
              </>
            )}

            {picked && (
              <SheetFrame
                mask="plan-sheet-mask"
                panel="plan-sheet"
                label={`${picked.code} 确认预约`}
                locked={sheetLocked}
                dirty={!!note.trim() || !!coupon.code.trim()}
                onClose={closeSheet}
                head={
                  <View className="plan-sheet-head">
                    <View className="plan-sheet-title">
                      <Text className="plan-sheet-code">{picked.code}</Text>
                      <Text className="plan-sheet-place">
                        {picked.place} · {picked.people > 1 ? `可坐 ${picked.people} 人 · 整桌预约` : '1 个座位'}
                      </Text>
                    </View>
                    <SheetCloseButton className="text-button" disabled={sheetLocked}>
                      关闭
                    </SheetCloseButton>
                  </View>
                }
              >
                {booked ? (
                  <View className="plan-done">
                    <DoneMark />
                    <Text className="plan-done-title">已提交，等店员确认</Text>
                    <Text className="plan-done-when">
                      {booked.code} · {booked.when}
                    </Text>
                    <Text className="plan-done-note">店员确认后，「我的预约」里会显示已确认</Text>
                    <SheetCloseButton className="button button-primary plan-done-ok" ariaLabel="好的">
                      好的
                    </SheetCloseButton>
                    <Button
                      className="text-button"
                      onClick={() => {
                        closeSheet()
                        void navigateApp(billing ? '/pages/customer/my-reservations/index' : '/pages/orders/index')
                      }}
                    >
                      看我的预约
                    </Button>
                  </View>
                ) : (
                  <>
                    <View className="plan-sheet-rows">
                      <View className="plan-sheet-row">
                        <Text className="plan-sheet-label">日期</Text>
                        <Text className="plan-sheet-value">
                          {sheetDate.month} 月 {sheetDate.day} 日 · {dayName}
                        </Text>
                      </View>
                      {start && selectedPackage && (
                        <>
                          <View className="plan-sheet-row">
                            <Text className="plan-sheet-label">时间</Text>
                            <Text className="plan-sheet-value">
                              {range} · {durationText}
                            </Text>
                          </View>
                          <View className="plan-sheet-row">
                            <Text className="plan-sheet-label">到店</Text>
                            <Text className="plan-sheet-value">
                              {storeClock(new Date(start.getTime() + settings.graceMinutes * 60000))}{' '}
                              前到，过时座位会释放
                            </Text>
                          </View>
                          {billing && (
                            <View className="plan-sheet-row">
                              <Text className="plan-sheet-label">费用</Text>
                              <Text className="plan-sheet-value">
                                ¥{moneyText(selectedPackage.amountCents)} · 到店付，会员价以结账为准
                              </Text>
                            </View>
                          )}
                        </>
                      )}
                    </View>

                    {error && (
                      <View className="field-error" role="alert">
                        {error}
                      </View>
                    )}
                    {error && limited && contactActions()}
                    {!error && startAt && !startValid && (
                      <Text className="field-help">刚才选的时段已过可预约时间，请关掉重新选择。</Text>
                    )}
                    {!error && start && !slotFree(start) && (
                      <Text className="field-help">这个座位这时刚被约走了，请关掉换一个。</Text>
                    )}

                    <CouponFields value={coupon} onChange={setCoupon} disabled={sheetLocked} customer />

                    <View className="staff-field">
                      <Text className="field-label">备注（选填）</Text>
                      <Textarea
                        className="input"
                        maxlength={200}
                        disabled={sheetLocked}
                        value={note}
                        placeholder="想做的作品、同行人数等"
                        onInput={(event) => setNote(event.detail.value)}
                      />
                    </View>

                    <Button
                      className="button button-primary plan-sheet-submit"
                      disabled={!ready || sheetLocked}
                      loading={busyForm}
                      onClick={submit}
                    >
                      提交预约
                    </Button>
                    <View className="plan-sheet-foot">
                      <Text className="plan-sheet-foot-text">
                        {couponError
                          ? '团购填得不对，改好后再预约'
                          : `${billing ? '预约时不付钱，到店后按套餐付。' : '预约不收费。'}提交后等店员确认，确认前座位还没锁定`}
                      </Text>
                      <Button className="text-button" onClick={() => void Taro.showModal(notice(false))}>
                        预约须知
                      </Button>
                    </View>
                  </>
                )}
              </SheetFrame>
            )}
          </View>
        )}
      </AuthBoundary>
    </Screen>
  )
}
