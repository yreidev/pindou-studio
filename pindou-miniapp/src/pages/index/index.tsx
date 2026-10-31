import { Image, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/button'
import { navbarHeight, Screen } from '../../components/customer'
import { assets } from '../../components/customer/assets'
import { openStoreMap } from '../../components/customer/store-contact'
import { useBillingEnabled, useOrdersTabText } from '../../hooks/billing'
import { useNow } from '../../hooks/clock'
import { useCustomer } from '../../hooks/customer'
import { usePatternsTabText } from '../../hooks/patterns-tab'
import { useCustomerQuery, usePublicQuery } from '../../hooks/query'
import { membershipName, patternColumn, todaySlotsTitle } from '../../brand'
import { errorMessage } from '../../services/customer'
import { loyalty } from '../../services/membership'
import { beginLogin, navigateApp } from '../../services/navigation'
import { dialNumber, reservations, slotParam, storeClock } from '../../services/reservations'
import { callState, serviceCalls } from '../../services/service-calls'
import {
  announcementTitle,
  greeting,
  homeLayout,
  imageUrl,
  noSlotsLine,
  openingLine,
  slotCells,
  storefront,
  todaysReservation,
  untilLabel,
  visitOf,
  type FeaturedSize,
  type Pattern,
  type StoreContact,
  type Visit,
} from '../../services/storefront'
import { homeShare, homeTimeline } from '../../services/share'
import { scanTableCode, tableIdFromLaunch } from '../../services/table-code'
import { wholeTableSessions } from '../../services/whole-table'
import right from '../../assets/staff/right.png'
import tableIcon from '../../assets/staff/tables-ink.png'
import reserveIcon from '../../assets/staff/reserve-active.png'
import businessIcon from '../../assets/staff/business-active.png'
import memberIcon from '../../assets/staff/profile-active.png'
import orderIcon from '../../assets/staff/orders-active.png'
import noticeIcon from '../../assets/staff/notice-active.png'
import locationIcon from '../../assets/staff/location-active.png'
import phoneIcon from '../../assets/staff/phone-active.png'
import wechatIcon from '../../assets/staff/wechat-gold.png'
import './index.scss'

// 首页一屏不滑动（方案见 docs/plan-home-and-patterns.md，画布「F 一屏版」）：
// 顶上是「本次手作」，正在店里或今天有预约时换成状态卡；下面三个入口、公告、今天还能约、本周上新、门店。
// 放哪些块、上新用哪一档按这台手机的可用高度挑（services/storefront.ts 的 homeLayout）。
// 门店内容是公开接口，没登录也能看；点时段、预约、手作这些要登录的，进去再登录。

const experience = '/pages/customer/experience/index'
const reserve = '/pages/customer/reservations/index'

/** 首页正文能用的高度：窗口高减去导航栏。 */
function availableHeight() {
  try {
    return Taro.getWindowInfo().windowHeight - navbarHeight(true)
  } catch {
    return 0
  }
}

/** 正在店里的这次（扫码入座的、店员开台的整桌计时），口径同「本次手作」页。 */
const loadVisit = async () => {
  const [member, tables, wholeTable] = await Promise.all([loyalty.me(), loyalty.tables(), wholeTableSessions()])
  return visitOf(member.admissions, tables, wholeTable)
}

export default function Index() {
  const auth = useCustomer()
  const authenticated = auth.status === 'authenticated'
  // 系统内收费关着时没有消费订单（钱在美团、大众点评收）：订单入口写「我的预约」
  const billing = useBillingEnabled()
  useOrdersTabText()
  const home = usePublicQuery(['storefront'], storefront.home, { refetchInterval: 60000 })
  const visits = useCustomerQuery(['home', 'visit'], loadVisit, { refetchInterval: 30000 })
  const mine = useCustomerQuery(['reservations'], reservations.me)
  const visit = visits.data
  const calls = useCustomerQuery(['service-calls', 'me'], serviceCalls.mine, {
    enabled: !!visit?.callSessionId,
    refetchInterval: 10000,
  })
  const call = calls.data?.find((item) => item.venueSessionId === visit?.callSessionId)
  // 预约倒数、呼叫冷却只在两次刷新之间走表，能不能叫、到没到点仍以接口为准
  const now = useNow(call?.cooldownSeconds ? 1000 : 30000)
  const reservation = !visit && mine.data ? todaysReservation(mine.data.reservations, new Date(now)) : null
  const status = visit ? 'visit' : reservation ? 'reservation' : 'start'
  const data = home.data
  // 「今天来示例工坊拼什么？」那几张和图纸库是后端同一个筛选：有一张就说明店里有上架的图纸，底部第二格叫「图纸」
  usePatternsTabText(data ? data.featured.length > 0 : null)
  const role = auth.account?.roles.includes('owner')
    ? '老板'
    : auth.account?.roles.includes('manager')
      ? '店长'
      : '店员'
  const staff = authenticated && !!auth.account?.roles.length

  const [available, setAvailable] = useState(availableHeight)
  useDidShow(() => setAvailable(availableHeight()))
  // 转发的首页不带桌码：从桌码进来的人转给朋友，朋友打开的是普通首页
  useShareAppMessage(homeShare)
  useShareTimeline(homeTimeline)
  useEffect(() => {
    const resize = () => setAvailable(availableHeight())
    Taro.onWindowResize(resize)
    return () => Taro.offWindowResize(resize)
  }, [])
  const contact = data?.contact
  const layout = homeLayout(available, {
    staff,
    status,
    announcement: !!data?.announcement,
    slots: !!data?.selfService,
    featured: data?.featured.length ?? 0,
    store: !!data,
    greeting: authenticated && !!auth.account?.nickname,
  })

  const go = (url: string) => {
    void navigateApp(url)
  }
  // 微信扫桌上的网页桌码（扫普通链接二维码打开小程序）规定落到手作页；万一规则配成了首页，带着桌位转过去
  const { params } = useRouter()
  useEffect(() => {
    const id = params.q ? tableIdFromLaunch({ q: params.q }) : ''
    if (id) void navigateApp(`${experience}?tableId=${encodeURIComponent(id)}`)
  }, [params.q])
  // 「本次手作」直接扫码，扫到了才带着桌位进页面；没登录先去登录（手作要记在账户上）。
  const scanning = useRef(false)
  const [scanError, setScanError] = useState('')
  const startExperience = async () => {
    if (!authenticated) {
      void beginLogin(experience)
      return
    }
    if (scanning.current) return
    scanning.current = true
    setScanError('')
    try {
      const id = await scanTableCode()
      // 取消扫码就什么都不做，停在首页
      if (id) go(`${experience}?tableId=${encodeURIComponent(id)}`)
    } catch (error) {
      // 相机打不开、扫到别家的码：告诉他，并留一条不用相机也能进去的路
      setScanError(error instanceof Error ? error.message : '未识别到桌码，请重新扫描')
    } finally {
      scanning.current = false
    }
  }

  const [calling, setCalling] = useState(false)
  const callStaff = async (sessionId: string) => {
    if (calling) return
    setCalling(true)
    try {
      await serviceCalls.call(sessionId)
      void Taro.showToast({ title: '已呼叫，店员马上就到', icon: 'none' })
    } catch (error) {
      void Taro.showToast({ title: errorMessage(error), icon: 'none' })
    } finally {
      setCalling(false)
      void calls.refresh()
    }
  }

  return (
    <Screen brand brandLogo={assets.logoWhite} dark className="home-screen">
      <View
        className={`home-main ${layout.fits ? 'home-main-fit' : ''}`}
        style={layout.fits ? { minHeight: `${available}px` } : undefined}
      >
        {layout.greeting && (
          <View className="home-greeting enter">
            <Text className="home-greeting-text">
              {greeting(new Date(now))}，{auth.account?.nickname}
            </Text>
          </View>
        )}
        {staff && (
          <Button className="home-staff-entry enter" onClick={() => go('/pages/staff/workbench/index')}>
            <Image className="home-icon" src={businessIcon} mode="aspectFit" />
            <Text className="grow">{role}工作台</Text>
            <Image className="inline-icon" src={right} />
          </Button>
        )}

        {visit ? (
          <VisitCard
            visit={visit}
            name={auth.account?.nickname || ''}
            callLabel={callLabel(callState(call, calls.updatedAt ?? now, now))}
            calling={calling}
            onCall={(id) => void callStaff(id)}
            onOpen={() => go(experience)}
          />
        ) : reservation ? (
          <View className="home-card home-card-light enter">
            <View className="home-card-head">
              <Text className="home-card-title">今天的预约</Text>
              <Text className="home-card-note">{untilLabel(reservation.reservation.startAt, now)}</Text>
            </View>
            <View className="home-card-body">
              <Text className="home-card-big">
                {storeClock(reservation.reservation.startAt)} – {storeClock(reservation.endAt)}
              </Text>
              <Text className="home-card-sub">
                {reservation.tableNumber ? `${reservation.tableNumber} 号桌` : '桌位待核对'} ·{' '}
                {reservation.reservation.seatNumber} 号座 ·{' '}
                {reservation.displayStatus === 'pending' ? '等员工确认' : '已确认'}
              </Text>
            </View>
            <View className="home-card-actions">
              <Button className="home-card-button home-card-button-dark" onClick={() => void startExperience()}>
                到店扫码入座
              </Button>
              <Button
                className="home-card-button home-card-button-plain"
                onClick={() => go(billing ? '/pages/customer/my-reservations/index' : '/pages/orders/index')}
              >
                查看预约 ›
              </Button>
            </View>
          </View>
        ) : (
          <Button className="home-start enter" onClick={() => void startExperience()}>
            <View className="home-start-icon">
              <Image className="home-start-image" src={tableIcon} mode="aspectFit" />
            </View>
            <View className="home-start-copy">
              <Text className="home-start-title">本次手作</Text>
              <Text className="home-start-note">到店扫桌码，入座开始计时</Text>
            </View>
            <Text className="home-chevron">›</Text>
          </Button>
        )}
        {/* 扫不出来时得有一条不用相机的路，否则顾客卡在首页 */}
        {scanError && (
          <View className="field-error home-scan-error" role="alert">
            {scanError}
            <Button className="text-button" onClick={() => go(experience)}>
              手动进入本次手作
            </Button>
          </View>
        )}

        <View className="home-actions enter">
          <Button className="home-action" onClick={() => go(reserve)}>
            <Image className="home-icon" src={reserveIcon} mode="aspectFit" />
            <Text className="home-action-text">预约座位</Text>
          </Button>
          <Button className="home-action" onClick={() => go('/pages/orders/index')}>
            <Image className="home-icon" src={orderIcon} mode="aspectFit" />
            <Text className="home-action-text">{billing ? '消费订单' : '我的预约'}</Text>
          </Button>
          <Button className="home-action" onClick={() => go('/pages/customer/membership/index')}>
            <Image className="home-icon" src={memberIcon} mode="aspectFit" />
            <Text className="home-action-text">{membershipName}</Text>
          </Button>
        </View>

        {!data && home.error ? (
          <View className="home-failure" role="alert">
            <Text className="muted">门店信息没读到</Text>
            <Button className="text-button" onClick={home.refresh}>
              重新加载
            </Button>
          </View>
        ) : null}

        {data?.announcement && (
          <Button
            className="home-notice enter"
            ariaLabel={`门店公告：${data.announcement.body}`}
            onClick={() => {
              void Taro.showModal({
                title: '门店公告',
                content: data.announcement!.body,
                showCancel: false,
                confirmText: '知道了',
              }).catch(() => undefined)
            }}
          >
            <Image className="home-notice-icon" src={noticeIcon} mode="aspectFit" />
            <Text className="home-notice-text">{announcementTitle(data.announcement.body)}</Text>
            <Image className="inline-icon" src={right} />
          </Button>
        )}

        {data?.selfService && status === 'start' && (
          <View className="home-slots enter">
            <View className="home-block-head">
              <Text className="home-block-title">{todaySlotsTitle}</Text>
              <Button className="home-block-more" onClick={() => go(reserve)}>
                全部时段 ›
              </Button>
            </View>
            {data.slots.length ? (
              <View className="home-slot-grid">
                {slotCells(data.slots).map((cell) => (
                  <Button
                    key={cell.startAt}
                    className={`home-slot ${cell.night ? 'home-slot-night' : ''} ${cell.full ? 'home-slot-full' : ''}`}
                    disabled={cell.full}
                    ariaLabel={cell.label}
                    onClick={() => go(`${reserve}?at=${slotParam(cell.startAt)}`)}
                  >
                    <Text className="home-slot-time">{cell.time}</Text>
                    <Text className="home-slot-note">{cell.note}</Text>
                  </Button>
                ))}
              </View>
            ) : (
              <Button className="home-slot-empty" onClick={() => go(reserve)}>
                <Text className="grow">{noSlotsLine(data.today)}</Text>
                <Text className="home-block-more-text">去预约 ›</Text>
              </Button>
            )}
          </View>
        )}

        {data && layout.featured !== 'none' && data.featured.length > 0 && (
          <Featured size={layout.featured} patterns={data.featured} go={go} />
        )}

        {data && contact && <StoreRow today={data.today} contact={contact} />}
      </View>
    </Screen>
  )
}

/** 呼叫店员按钮上写什么、能不能点：等着店员、刚处理过的冷却里都不能再点。 */
function callLabel(state: ReturnType<typeof callState>): { text: string; disabled: boolean } {
  if (state.kind === 'waiting') return { text: state.coming ? '店员正在过来' : '已呼叫', disabled: true }
  if (state.kind === 'cooldown') return { text: `${state.seconds} 秒后可再叫`, disabled: true }
  return { text: '呼叫店员', disabled: false }
}

/** 正在店里：在哪桌、几点入座、已经拼了多久；能呼叫店员时给按钮，另一个进「本次手作」。 */
function VisitCard({
  visit,
  name,
  callLabel: label,
  calling,
  onCall,
  onOpen,
}: {
  visit: Visit
  name: string
  callLabel: { text: string; disabled: boolean }
  calling: boolean
  onCall: (sessionId: string) => void
  onOpen: () => void
}) {
  const detail =
    visit.state !== '计时中'
      ? visit.state
      : visit.free
        ? '自由计时'
        : visit.overdue
          ? `已超时 ${visit.overdue} 分钟`
          : `还剩 ${visit.remaining ?? 0} 分钟`
  return (
    <View className="home-card home-card-dark enter">
      <View className="home-card-head">
        <Text className="home-card-title">
          {name ? `${name}，` : ''}
          {visit.pending ? '已申请入座' : '正在拼'} · {visit.table}
        </Text>
        {visit.startedAt && (
          <Text className="home-card-note">
            {storeClock(visit.startedAt)} 入座 · {detail}
          </Text>
        )}
      </View>
      <View className="home-card-body">
        <Text className="home-card-big">{visit.pending ? '等员工确认后开始计时' : `已拼 ${visit.minutes} 分钟`}</Text>
      </View>
      <View className="home-card-actions">
        {visit.callSessionId && (
          <Button
            className="home-card-button home-card-button-gold"
            disabled={label.disabled || calling}
            onClick={() => onCall(visit.callSessionId!)}
          >
            {label.text}
          </Button>
        )}
        <Button className="home-card-button home-card-button-ghost" onClick={onOpen}>
          本次手作 ›
        </Button>
      </View>
    </View>
  )
}

/** 本周上新：三张大图、三张小图，或者矮屏上一行（一张缩略图加名字）。点图进详情，「全部图纸」去底部「图纸」。 */
function Featured({ size, patterns, go }: { size: FeaturedSize; patterns: Pattern[]; go: (url: string) => void }) {
  const open = (pattern: Pattern) => go(`/pages/customer/pattern/index?id=${encodeURIComponent(pattern.id)}`)
  if (size === 'row') {
    const first = patterns[0]
    return (
      <View className="home-featured home-featured-row enter">
        <Button className="home-featured-strip" ariaLabel={`${first.name}，看大图`} onClick={() => open(first)}>
          <Image className="home-featured-thumb" src={imageUrl(first.thumbnailPath)} mode="aspectFill" />
          <View className="home-featured-copy">
            <Text className="home-featured-label">{patternColumn}</Text>
            <View className="home-featured-line">
              <Text className="home-featured-name">{first.name}</Text>
              {first.isNew && <Text className="home-featured-tag">本周上新</Text>}
            </View>
          </View>
        </Button>
        <Button className="home-block-more" onClick={() => go('/pages/patterns/index')}>
          全部图纸 ›
        </Button>
      </View>
    )
  }
  return (
    <View className={`home-featured home-featured-${size} enter`}>
      <View className="home-block-head">
        <Text className="home-block-title">{patternColumn}</Text>
        <Button className="home-block-more" onClick={() => go('/pages/patterns/index')}>
          全部图纸 ›
        </Button>
      </View>
      <View className="home-featured-grid">
        {patterns.map((pattern) => (
          <Button
            key={pattern.id}
            className="home-featured-card"
            ariaLabel={`${pattern.name}${pattern.isNew ? '，本周上新' : ''}，看大图`}
            onClick={() => open(pattern)}
          >
            <View className="home-featured-media">
              <Image className="home-featured-image" src={imageUrl(pattern.thumbnailPath)} mode="aspectFill" />
              {pattern.isNew && <Text className="home-featured-badge">上新</Text>}
            </View>
            <Text className="home-featured-name">{pattern.name}</Text>
          </Button>
        ))}
      </View>
    </View>
  )
}

/** 门店：营业状态和地址；右边导航、电话、微信，没填的不显示。 */
function StoreRow({ today, contact }: { today: Parameters<typeof openingLine>[0]; contact: StoreContact }) {
  const located = contact.latitude !== null && contact.longitude !== null
  return (
    <View className="home-store enter">
      <View className="home-store-copy">
        <View className="home-store-line">
          <Text className={`home-store-dot ${today.status === 'open' ? 'home-store-dot-open' : ''}`} />
          <Text className="home-store-hours">{openingLine(today)}</Text>
        </View>
        {!!contact.address && <Text className="home-store-address">{contact.address}</Text>}
      </View>
      {located && (
        <Button className="home-store-button" ariaLabel="导航到门店" onClick={() => openStoreMap(contact)}>
          <Image className="home-icon" src={locationIcon} mode="aspectFit" />
        </Button>
      )}
      {!!contact.phone && (
        <Button
          className="home-store-button"
          ariaLabel={`拨打门店电话 ${contact.phone}`}
          onClick={() => void Taro.makePhoneCall({ phoneNumber: dialNumber(contact.phone) }).catch(() => undefined)}
        >
          <Image className="home-icon" src={phoneIcon} mode="aspectFit" />
        </Button>
      )}
      {!!contact.wechat && (
        <Button
          className="home-store-button"
          ariaLabel={`复制门店微信号 ${contact.wechat}`}
          onClick={() =>
            void Taro.setClipboardData({ data: contact.wechat })
              .then(() => Taro.showToast({ title: '微信号已复制', icon: 'none' }))
              .catch(() => undefined)
          }
        >
          <Image className="home-icon" src={wechatIcon} mode="aspectFit" />
        </Button>
      )}
    </View>
  )
}
