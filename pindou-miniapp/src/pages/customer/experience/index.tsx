import { useRef, useState, type PropsWithChildren } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { CouponFields } from '../../../components/coupon-fields'
import { DoneMark } from '../../../components/done-mark'
import { AuthBoundary, Failure, RefreshNotice, Screen, SectionEmpty, Skeleton } from '../../../components/customer'
import { useBillingEnabled } from '../../../hooks/billing'
import { useNow } from '../../../hooks/clock'
import { useCustomerQuery } from '../../../hooks/query'
import { couponInput, couponProblem, couponText, emptyCouponDraft, type CouponDraft } from '../../../services/coupon'
import { errorMessage } from '../../../services/customer'
import { loyalty } from '../../../services/membership'
import { beadApi } from '../../../services/maker/api'
import { myPatterns } from '../../../services/maker/mine'
import { deviceStorage, localIndex } from '../../../services/maker/store'
import { navigateApp } from '../../../services/navigation'
import { money } from '../../../services/format'
import { storeClock } from '../../../services/reservations'
import { zoneOf, type SeatZone } from '../../../services/seatmap'
import { packageDuration } from '../../../services/packages'
import { callState, serviceCalls, type ServiceCall } from '../../../services/service-calls'
import { scanTableCode, tableIdFromLaunch } from '../../../services/table-code'
import { wholeTableSessions, wholeTableStates, wholeTableTitle } from '../../../services/whole-table'
import './index.scss'
import { overdueMinutes } from '../../../services/timing-alerts'

const load = async () => {
  const [member, tables] = await Promise.all([loyalty.me(), loyalty.tables()])
  return { member, tables }
}

// 系统内收费关着时（钱在美团、大众点评收）不显示套餐价格，超时、停表也不提结账；申请时可以选填团购记录，
// 员工确认入座时能改。员工点「结束」放座后会话变成 ended，不再列在这里，顾客可以重新扫码。
// 2026-10-27 起：「取消申请」先问一句；最近一次申请被店员拒绝、或没人确认过了时限的，写明结果，不再悄悄消失。

/** 被拒绝、过期的申请在这么久以内的，告诉顾客结果；再早的不提。 */
const unansweredShownFor = 2 * 3600 * 1000

export default function Experience() {
  const { params } = useRouter()
  const billing = useBillingEnabled()
  // 计时在走：页面显示时每 5 秒重读一次已用、剩余时长，离开页面就停
  const resource = useCustomerQuery(['experience'], load, { live: true, refetchInterval: 5000 })
  // 呼叫店员的状态单独读：读不到不影响计时显示。实时事件由上面那条连接触发整页重读，这里不再另开连接
  const calls = useCustomerQuery(['service-calls', 'me'], serviceCalls.mine, { refetchInterval: 5000 })
  // 员工从桌位开台、绑定了本人账户的整桌计时（不在 admissions 里）。同样随上面那条实时连接重读
  const wholeTable = useCustomerQuery(['venue-sessions', 'me'], wholeTableSessions, { refetchInterval: 5000 })
  // 站内跳转、微信扫小程序码、微信扫网页桌码（扫普通链接二维码打开小程序）带进来的桌位
  const [tableID, setTableID] = useState(() => tableIdFromLaunch(params))
  const [seat, setSeat] = useState(0)
  const [packageID, setPackageID] = useState('')
  const [coupon, setCoupon] = useState<CouponDraft>(emptyCouponDraft)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const now = useNow(60000)
  const data = resource.data
  const tables = data?.tables || []
  const table = tables.find((t) => t.id === tableID)
  const packages = data?.member.rules.filter((r) => r.kind === 'package') || []
  const seats = table
    ? Array.from({ length: table.seatCount }, (_, i) => i + 1).filter((n) => !table.occupiedSeats.includes(n))
    : []
  const active =
    data?.member.admissions.filter(
      (a) =>
        a.displayStatus === 'pending' || (a.session && ['active', 'paused', 'companion'].includes(a.session.status)),
    ) || []
  const sessions = wholeTable.data || []
  const selectedPackage = packages.find((r) => r.id === packageID)
  const couponError = couponProblem(coupon)
  // 单人位不用选座号（2026-10-20）：只有 1 个座位的桌直接就是 1 号座
  const single = !!table && table.seatCount === 1
  const chosenSeat = single ? 1 : seat
  const ready = !!table && seats.includes(chosenSeat) && !!selectedPackage && !couponError
  const run = async (action: 'request' | 'cancel_request', targetId: string) => {
    if (pending.current) return
    if (action === 'request' && !ready) {
      setError('座位或套餐已变化，请重新选择')
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await loyalty.action({
        action,
        targetId,
        expectedVersion: data?.member.version,
        serviceTableId: tableID,
        seatNumber: chosenSeat,
        ...(action === 'request' ? { coupon: couponInput(coupon) } : {}),
      })
      if (action === 'request') setCoupon(emptyCouponDraft)
      await resource.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const scan = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const id = await scanTableCode()
      if (id) {
        setTableID(id)
        setSeat(0)
        await resource.refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '未识别到桌码，请重新扫描')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  // 桌位写给顾客看：「C1」，没有编码的退回「2 号桌」；后面跟区域名
  const tableLabel = (id?: string) => {
    const found = tables.find((t) => t.id === id)
    return found?.code || (found ? `${found.number} 号桌` : '桌位待核对')
  }
  const zoneName = (id?: string) => {
    const found = tables.find((t) => t.id === id)
    return found?.zone ? zoneOf(found.zone as SeatZone)?.name || '' : ''
  }
  const waiting = active.filter((a) => a.displayStatus === 'pending')
  const timing = active.filter((a) => a.displayStatus !== 'pending')
  // 最近一次申请的结果：被拒绝或过期了（没有别的申请、计时时才看得到这一块）
  const latest = [...(data?.member.admissions || [])].sort(
    (a, b) => Date.parse(b.admission.createdAt || '') - Date.parse(a.admission.createdAt || ''),
  )[0]
  const unanswered =
    latest &&
    (latest.displayStatus === 'rejected' || latest.displayStatus === 'expired') &&
    !!latest.admission.createdAt &&
    now - Date.parse(latest.admission.createdAt) < unansweredShownFor
      ? latest
      : undefined
  const cancelRequest = async (a: (typeof waiting)[number]) => {
    if (pending.current) return
    let answer: Taro.showModal.SuccessCallbackResult
    try {
      answer = await Taro.showModal({
        title: '取消入座申请？',
        content: `${tableLabel(a.admission.serviceTableId)} · ${a.admission.package.name}。取消后店员那边也看不到了，想坐的话重新扫码申请。`,
        confirmText: '取消申请',
        cancelText: '再等等',
      })
    } catch {
      return
    }
    if (answer.confirm) await run('cancel_request', a.admission.id)
  }
  // 计时中（扫码入座确认了、或店员开的整桌计时）用深色页，和首页「正在店里」那张卡一样
  const dark = timing.length + sessions.length > 0
  const freeSeats = table ? table.seatCount - table.occupiedSeats.length : 0
  return (
    <Screen title="本次手作" back dark={dark} className={`experience-screen ${dark ? 'experience-dark' : ''}`}>
      <AuthBoundary>
        {resource.loading || wholeTable.loading ? (
          <Skeleton />
        ) : !data ? (
          <Failure
            error={resource.error}
            retry={() => {
              void resource.refresh()
            }}
          />
        ) : (
          <View className="loyalty-content experience-content">
            {(!!resource.error || !!wholeTable.error) && (
              <RefreshNotice
                retry={() => {
                  void resource.refresh()
                  void wholeTable.refresh()
                }}
              />
            )}
            {error && (
              <View className="field-error" role="alert">
                {error}
              </View>
            )}
            {/* 计时中（画稿 CHandsonTiming）：圆环倒计时，入座时刻、已拼多久、团购，大按钮「呼叫店员」 */}
            {timing.map((a) => {
              const tableId = a.session?.serviceTableId || a.admission.serviceTableId
              const seatNumber = a.session?.seatNumber || a.admission.seatNumber
              const found = tables.find((t) => t.id === tableId)
              return (
                <TimingCard
                  key={a.admission.id}
                  table={`${tableLabel(tableId)}${found && found.seatCount > 1 ? `-${seatNumber}` : ''}`}
                  subtitle={[zoneName(tableId), a.admission.package.name].filter(Boolean).join(' · ')}
                  state={
                    a.session?.stoppedAt
                      ? billing
                        ? '计时已停止，等待结账'
                        : '计时已停止'
                      : a.session?.status === 'paused'
                        ? '已暂停'
                        : a.session?.untilClose
                          ? '计时中 · 用到今天打烊'
                          : '计时中'
                  }
                  totalSeconds={(a.admission.package.durationMinutes || 0) * 60}
                  elapsedSeconds={a.elapsedSeconds || 0}
                  remainingSeconds={a.remainingSeconds || 0}
                  overdueSeconds={a.overdueSeconds || 0}
                  untilClose={!!a.session?.untilClose}
                  free={a.session?.timingMode === 'free'}
                  stopped={!!a.session?.stoppedAt}
                  startedAt={a.session?.startedAt}
                  coupon={a.admission.coupon ? couponText(a.admission.coupon) : ''}
                  billing={billing}
                >
                  {a.session && ['active', 'paused'].includes(a.session.status) && (
                    <CallStaff
                      sessionId={a.session.id}
                      call={calls.data?.find((c) => c.venueSessionId === a.session?.id)}
                      fetchedAt={calls.updatedAt}
                      refresh={calls.refresh}
                    />
                  )}
                </TimingCard>
              )
            })}
            {sessions.map((x) => (
              <TimingCard
                key={x.id}
                table={x.tableCode || '整桌计时'}
                subtitle={wholeTableTitle(x)}
                state={wholeTableStates[x.displayStatus]}
                totalSeconds={(x.durationMinutes || 0) * 60}
                elapsedSeconds={x.elapsedSeconds}
                remainingSeconds={x.remainingSeconds || 0}
                overdueSeconds={x.overdueSeconds || 0}
                untilClose={false}
                free={x.timingMode === 'free'}
                stopped={x.displayStatus === 'stopped'}
                startedAt={x.startedAt}
                coupon=""
                billing={billing}
              >
                {x.canCallStaff && (
                  <CallStaff
                    sessionId={x.id}
                    call={calls.data?.find((c) => c.venueSessionId === x.id)}
                    fetchedAt={calls.updatedAt}
                    refresh={calls.refresh}
                  />
                )}
              </TimingCard>
            ))}
            {(timing.length > 0 || sessions.length > 0) && <MyPatternLink />}
            {/* 等店员确认（画稿 CHandsonWaiting）：三步进度，可以取消申请 */}
            {waiting.map((a) => (
              <View className="experience-waiting" key={a.admission.id}>
                <Text className="experience-waiting-title">等店员确认一下</Text>
                <Text className="experience-waiting-note">
                  店员确认后这一页会自动开始计时，不用一直盯着，先挑挑豆子吧。
                </Text>
                <View className="experience-steps">
                  <View className="experience-step experience-step-done">
                    {/* 申请一提交，这一步画出勾（docs/plan-interaction.md 第 3 节） */}
                    <DoneMark small className="experience-step-mark" />
                    <View className="experience-step-copy">
                      <Text className="experience-step-title">已提交申请</Text>
                      <Text className="experience-step-note">
                        {tableLabel(a.admission.serviceTableId)} · {a.admission.package.name}
                        {a.admission.createdAt ? ` · ${storeClock(a.admission.createdAt)}` : ''}
                      </Text>
                    </View>
                  </View>
                  <View className="experience-step experience-step-current">
                    <Text className="experience-step-dot" />
                    <View className="experience-step-copy">
                      <Text className="experience-step-title">店员确认中</Text>
                      <Text className="experience-step-note">等待员工确认，尚未开始计时</Text>
                    </View>
                  </View>
                  <View className="experience-step">
                    <Text className="experience-step-dot" />
                    <View className="experience-step-copy">
                      <Text className="experience-step-title">开始计时</Text>
                    </View>
                  </View>
                </View>
                <View className="experience-rows">
                  <View className="experience-row">
                    <Text className="experience-row-label">桌位</Text>
                    <Text className="experience-row-value">
                      {tableLabel(a.admission.serviceTableId)}
                      {tables.find((t) => t.id === a.admission.serviceTableId)?.seatCount === 1
                        ? ''
                        : ` · ${a.admission.seatNumber} 号座`}
                      {zoneName(a.admission.serviceTableId) ? ` · ${zoneName(a.admission.serviceTableId)}` : ''}
                    </Text>
                  </View>
                  <View className="experience-row">
                    <Text className="experience-row-label">时长</Text>
                    <Text className="experience-row-value">
                      {a.admission.package.name} · {packageDuration(a.admission.package)}
                    </Text>
                  </View>
                  {a.admission.coupon && (
                    <View className="experience-row">
                      <Text className="experience-row-label">团购</Text>
                      <Text className="experience-row-value">{couponText(a.admission.coupon)}</Text>
                    </View>
                  )}
                </View>
                <Button
                  className="experience-cancel"
                  disabled={busy}
                  onClick={() => {
                    void cancelRequest(a)
                  }}
                >
                  取消申请
                </Button>
                <Text className="experience-waiting-foot">选错了时长？取消后重新扫码申请</Text>
              </View>
            ))}
            {active.length === 0 && sessions.length === 0 && (
              <>
                {unanswered && (
                  <View className="experience-unanswered" role="status">
                    <Text className="experience-unanswered-title">
                      {unanswered.displayStatus === 'rejected'
                        ? '店员没有通过这次入座申请'
                        : '入座申请没等到确认，已经失效'}
                    </Text>
                    <Text className="experience-unanswered-meta">
                      {tableLabel(unanswered.admission.serviceTableId)} · {unanswered.admission.package.name}
                      {unanswered.admission.createdAt ? ` · ${storeClock(unanswered.admission.createdAt)} 提交` : ''}
                    </Text>
                    <Text className="experience-unanswered-note">
                      {unanswered.displayStatus === 'rejected'
                        ? '可能这个座位另有安排。问问店员，或者换个座位重新扫码申请。'
                        : `${unanswered.expiresAt ? `${storeClock(unanswered.expiresAt)} 前` : '提交后'}没有店员确认，申请自动失效了。找店员说一声，或者重新扫码申请。`}
                    </Text>
                  </View>
                )}
                {table ? (
                  <View className="experience-where">
                    <Text className="experience-where-label">你在</Text>
                    <Text className="experience-where-code">{table.code || `${table.number} 号桌`}</Text>
                    <Text className="experience-where-meta">
                      {[
                        zoneName(table.id),
                        `${table.seatCount} 个座位`,
                        freeSeats > 0 ? (freeSeats === table.seatCount ? '空着' : `还空 ${freeSeats} 个`) : '坐满了',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                ) : (
                  <View className="experience-intro">
                    <Text className="page-heading">坐下来，开始手作</Text>
                    <Text className="muted">
                      扫描桌上的二维码，选好坐多久，店员确认后开始计时；请店员开台的，开台后计时也会显示在这里。
                    </Text>
                  </View>
                )}
                {!table && (
                  <Button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => {
                      void scan()
                    }}
                  >
                    扫描桌码
                  </Button>
                )}
                {table && (
                  <>
                    {!single && (
                      <View className="experience-section">
                        <Text className="experience-question">选个座位</Text>
                        <View className="experience-seats">
                          {Array.from({ length: table.seatCount }, (_, i) => i + 1).map((n) => {
                            const occupied = table.occupiedSeats.includes(n)
                            return (
                              <Button
                                key={n}
                                className={`experience-seat ${seat === n && !occupied ? 'experience-seat-selected' : ''}`}
                                disabled={busy || occupied}
                                ariaLabel={`${n} 号座，${occupied ? '已占用' : seat === n ? '已选中' : '可选'}`}
                                onClick={() => {
                                  setSeat(n)
                                  setError('')
                                }}
                              >
                                <Text className="strong">{n} 号座</Text>
                                <Text className="experience-seat-status">
                                  {occupied ? '已占用' : seat === n ? '已选' : '可选'}
                                </Text>
                              </Button>
                            )
                          })}
                        </View>
                      </View>
                    )}
                    {seats.length === 0 && <Text className="field-help">当前没有空座，请联系员工或扫描其他桌码。</Text>}
                    <View className="experience-section">
                      <Text className="experience-question">今天坐多久？</Text>
                      <View className="experience-packages">
                        {packages.map((r) => (
                          <Button
                            key={r.id}
                            className={`experience-package ${packageID === r.id ? 'experience-package-selected' : ''}`}
                            disabled={busy}
                            ariaLabel={`${r.name}，${packageDuration(r)}${billing ? `，${money(r.amountCents)} 元` : ''}${packageID === r.id ? '，已选中' : ''}`}
                            onClick={() => {
                              setPackageID(r.id)
                              setError('')
                            }}
                          >
                            <Text className="experience-package-name">{r.name}</Text>
                            <Text className="experience-package-note">
                              {billing ? `¥${money(r.amountCents)} · ` : ''}
                              {r.untilClose ? '到今天打烊' : packageDuration(r)}
                              {packageID === r.id ? ' · 已选' : ''}
                            </Text>
                          </Button>
                        ))}
                      </View>
                      {packages.length === 0 && (
                        <SectionEmpty title="套餐暂未开放" message="请联系员工了解门店安排。" />
                      )}
                      <Text className="field-help">
                        从店员确认那一刻开始算时间{billing ? '；会员按等级价，用完找店员结账。' : '。'}
                      </Text>
                    </View>
                    <View className="experience-section experience-coupon">
                      <CouponFields value={coupon} onChange={setCoupon} disabled={busy} customer />
                    </View>
                    <Button
                      className="experience-switch"
                      disabled={busy}
                      onClick={() => {
                        void scan()
                      }}
                    >
                      不是这张桌？扫另一张桌上的码
                    </Button>
                    <View className="experience-bar">
                      <View className="experience-bar-copy">
                        <Text className="experience-bar-main">
                          {table.code || `${table.number} 号桌`}
                          {!single && seat ? `-${seat}` : ''}
                          {selectedPackage ? ` · ${selectedPackage.name}` : ''}
                          {billing && selectedPackage ? ` · ¥${money(selectedPackage.amountCents)}` : ''}
                        </Text>
                        <Text className="experience-bar-note">
                          {couponError
                            ? '团购填得不对，改好后再提交。'
                            : !single && !seat
                              ? '先选个座位'
                              : !selectedPackage
                                ? '先选坐多久'
                                : billing
                                  ? '现在不付钱，用完结账'
                                  : '店员确认后开始计时'}
                        </Text>
                      </View>
                      <Button
                        className="experience-submit"
                        disabled={!ready || busy}
                        loading={busy}
                        onClick={() => {
                          void run('request', packageID)
                        }}
                      >
                        申请入座
                      </Button>
                    </View>
                  </>
                )}
              </>
            )}
          </View>
        )}
      </AuthBoundary>
    </Screen>
  )
}

/**
 * 计时中的一张卡（扫码入座的、店员开的整桌计时都用它）：圆环是剩余占总时长的比例，中间写还剩多久；
 * 超时、暂停、停表、自由计时、到打烊各写各的。数都来自接口，两次刷新之间不自己走表。
 */
function TimingCard({
  table,
  subtitle,
  state,
  totalSeconds,
  elapsedSeconds,
  remainingSeconds,
  overdueSeconds,
  untilClose,
  free,
  stopped,
  startedAt,
  coupon,
  billing,
  children,
}: PropsWithChildren<{
  table: string
  subtitle: string
  state: string
  totalSeconds: number
  elapsedSeconds: number
  remainingSeconds: number
  overdueSeconds: number
  untilClose: boolean
  free: boolean
  stopped: boolean
  startedAt?: string
  coupon: string
  billing: boolean
}>) {
  const overdue = overdueSeconds > 0
  const total = untilClose ? elapsedSeconds + remainingSeconds : totalSeconds
  const ratio = free || overdue || !total ? (overdue ? 1 : 0) : Math.min(1, Math.max(0, remainingSeconds / total))
  const clock = (seconds: number) => {
    const minutes = Math.ceil(seconds / 60)
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
  }
  const label = free ? '已拼' : overdue ? '已超时' : '还剩'
  const value = free
    ? clock(elapsedSeconds)
    : overdue
      ? `+${overdueMinutes(overdueSeconds)} 分`
      : clock(remainingSeconds)
  const end = !free && !overdue && !stopped ? new Date(Date.now() + remainingSeconds * 1000) : null
  return (
    <View className={`experience-timing ${overdue ? 'experience-timing-overdue' : ''}`}>
      <View className="experience-timing-head">
        <View className="experience-timing-copy">
          <Text className="experience-timing-table">{table}</Text>
          <Text className="experience-timing-subtitle">{subtitle}</Text>
        </View>
        <Text className="experience-state">{state}</Text>
      </View>
      <View
        className="experience-ring"
        style={{
          background: `conic-gradient(${overdue ? '#c0492f' : '#d8c08f'} ${ratio * 360}deg, rgba(247, 245, 240, 0.12) 0deg)`,
        }}
      >
        <View className="experience-ring-inner">
          <Text className="experience-ring-label">{label}</Text>
          <Text className="experience-ring-value">{value}</Text>
          <Text className="experience-ring-note">
            {stopped
              ? '计时已停止'
              : untilClose
                ? '到今天打烊'
                : end
                  ? `${storeClock(end)} 到时间`
                  : free
                    ? '自由计时'
                    : ''}
          </Text>
        </View>
      </View>
      {overdue && (
        <Text className="experience-timing-alert">
          已超时 {overdueMinutes(overdueSeconds)} 分钟，{billing ? '请联系员工续时或结账' : '请联系店员'}
        </Text>
      )}
      <View className="experience-timing-rows">
        {startedAt && (
          <View className="experience-timing-cell">
            <Text className="experience-timing-cell-label">入座</Text>
            <Text className="experience-timing-cell-value">{storeClock(startedAt)}</Text>
          </View>
        )}
        <View className="experience-timing-cell">
          <Text className="experience-timing-cell-label">已拼</Text>
          <Text className="experience-timing-cell-value">{Math.floor(elapsedSeconds / 60)} 分钟</Text>
        </View>
        {coupon && (
          <View className="experience-timing-cell">
            <Text className="experience-timing-cell-label">团购</Text>
            <Text className="experience-timing-cell-value">{coupon}</Text>
          </View>
        )}
      </View>
      {children}
    </View>
  )
}

/** 计时中打开自己的图纸边拼边看（画稿 MHandson，docs/plan-bead-maker.md 第 4 节）：最近改的那张直接进「边拼边看」，没有就去「我的图纸」。 */
function MyPatternLink() {
  const list = useCustomerQuery(['bead-patterns'], beadApi.list)
  const [local, setLocal] = useState(() => localIndex(deviceStorage))
  useDidShow(() => setLocal(localIndex(deviceStorage)))
  const { latest, latestProgress } = myPatterns(list.data, local)
  return (
    <View className="experience-pattern">
      <Button
        className="experience-pattern-open"
        onClick={() =>
          void navigateApp(
            latest
              ? `/pages/maker/pattern/index?id=${encodeURIComponent(latest.id)}&tab=bead`
              : '/pages/maker/mine/index',
          )
        }
      >
        <Text className="experience-pattern-title">{latest ? '边拼边看我的图纸' : '用自己的图纸拼'}</Text>
        <Text className="experience-pattern-note">
          {latest ? `${latest.name} · 拼到 ${latestProgress}%` : '用照片做一张，或者打开做好的'}
        </Text>
      </Button>
      <Text className="experience-pattern-hint">清单上标着店里的盒号；店里没有的颜色，叫店员看看有没有替代的。</Text>
    </View>
  )
}

/**
 * 「呼叫店员」：计时中、暂停中（含停止计时等结账）的这次手作可以叫，扫码入座的和店员开台的整桌计时都一样。叫了之后显示「已呼叫，店员马上就到」和等了多久，
 * 有店员点了「我去处理」时改成「店员正在过来」（不说是哪位店员）；
 * 店员处理后显示已处理，1 分钟内按钮不可点并倒数；没人处理的 30 分钟后显示为过期，可以再叫。
 * 状态都由后端算好（displayStatus、cooldownSeconds），这里只在两次刷新之间倒数，不看手机时钟判断能不能叫。
 */
function CallStaff({
  sessionId,
  call,
  fetchedAt,
  refresh,
}: {
  sessionId: string
  call?: ServiceCall
  fetchedAt?: number
  refresh: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  // 等店员时每 30 秒更新「已等几分钟」，冷却时每秒倒数
  const now = useNow(call?.displayStatus === 'pending' ? 30000 : call?.cooldownSeconds ? 1000 : 0)
  const state = callState(call, fetchedAt ?? now, now)
  const ask = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await serviceCalls.call(sessionId)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      pending.current = false
      setBusy(false)
      void refresh()
    }
  }
  const minutes = state.kind === 'waiting' ? Math.floor((now - Date.parse(state.since)) / 60000) : 0
  return (
    <View className="experience-call">
      {state.kind === 'waiting' ? (
        <View className="experience-call-status" role="status">
          {/* 有店员点了「我去处理」：写那位的昵称（只有昵称，后端不给手机号）；认领失效后回到「马上就到」 */}
          <Text className="strong">{state.coming ? '店员正在过来' : '已呼叫，店员马上就到'}</Text>
          <Text className="muted">{minutes >= 1 ? `已等 ${minutes} 分钟` : '刚刚呼叫'}</Text>
        </View>
      ) : (
        <>
          {(state.kind === 'cooldown' || (state.kind === 'idle' && state.handled)) && (
            <Text className="muted">店员已处理你的呼叫</Text>
          )}
          {state.kind === 'expired' && <Text className="muted">上次呼叫没有等到店员，可以再叫一次</Text>}
          <Button
            className="button button-outline"
            disabled={busy || state.kind === 'cooldown'}
            loading={busy}
            onClick={() => {
              void ask()
            }}
          >
            {state.kind === 'cooldown' ? `${state.seconds} 秒后可再次呼叫` : '呼叫店员'}
          </Button>
          {state.kind !== 'cooldown' && (
            <Text className="experience-call-note">要换豆子、熨豆、想多坐一会儿，叫店员就行</Text>
          )}
        </>
      )}
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </View>
  )
}
