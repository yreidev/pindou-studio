import { useEffect, useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../../../components/button'
import { navigateApp } from '../../../services/navigation'
import { roleNames, StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { AdmissionRow } from '../../../components/staff/admission-row'
import { CancelledRow } from '../../../components/staff/cancelled-row'
import { TableSheet } from '../../../components/staff/table-sheet'
import { useBillingEnabled } from '../../../hooks/billing'
import { useCustomer } from '../../../hooks/customer'
import { useNow } from '../../../hooks/clock'
import { usePageVisible, useRefreshAll } from '../../../hooks/query'
import { useStaffOverview } from '../../../hooks/staff-overview'
import { staffMessage } from '../../../services/staff'
import { isOpenOrder } from '../../../services/format'
import {
  alertKeys,
  arrivals,
  buzzAfterRead,
  buzzDue,
  callTable,
  claimNote,
  serviceCalls,
  waited,
  type Buzz,
  type ServiceCall,
} from '../../../services/service-calls'
import { storeClock, storeDate, storeDayLabel, isoDate } from '../../../services/reservations'
import { timingAlerts } from '../../../services/timing-alerts'
import './index.scss'
import { brandSpirit } from '../../../brand'
import { appVersion } from '../../../version'

// 现场（原工作台，2026-10-20 重做，docs/plan-page-redesign.md 第 2 节第 2 条）：老板、店长、店员看到的一样，
// 标题统一叫「现场」，名字旁标角色。从上到下：空闲 / 使用中 / 需关注三个数；顾客呼叫；「等你处理」（扫码入座申请
// 直接在这里确认、改团购、拒绝，超时、快到点、待结账、待确认预约各一行，顾客今天取消的预约一条一行、点「知道了」消掉）；
// 大按钮「客人到店，计时开台」去桌位；收货入库、连电脑两格；品牌精神与版本号。

export default function StaffWorkbench() {
  const auth = useCustomer()
  // 系统内收费关着时（钱在美团、大众点评收）没有订单要收：不显示待结账
  const billing = useBillingEnabled()
  const live = useStaffEvents(5000)
  const data = useStaffOverview(billing, live.refetchInterval)
  const now = useNow(30000)
  const [openId, setOpenId] = useState('')
  const tables = data.data?.tables || []
  const sessions = data.data?.sessions || []
  const admissions = data.data?.shift.admissions || []
  const booked = data.data?.reservations || []
  const cancellations = data.data?.cancellations || []
  const orders = data.data?.orders || []
  const roles = auth.account?.roles || []
  const role = roles.includes('owner') ? 'owner' : roles.includes('manager') ? 'manager' : 'clerk'
  const alerts = timingAlerts(tables, sessions, now)
  const free = tables.filter((table) => table.enabled && table.occupancy === 'idle').length
  const busy = tables.filter((table) => table.enabled && table.occupancy === 'occupied').length
  const attention = alerts.length + tables.filter((table) => !table.enabled).length
  // ★ 看 displayStatus 不看 status：过期的申请 status 永远停在 pending
  const waiting = admissions.filter((entry) => entry.displayStatus === 'pending')
  const unconfirmed = booked.filter((entry) => entry.displayStatus === 'pending')
  const missed = booked.filter((entry) => entry.displayStatus === 'expired')
  // 待结账含部分付款（分笔付款收了一部分、还没收齐）
  const open = billing ? orders.filter(isOpenOrder) : []
  const go = (url: string, replace = false) => {
    void navigateApp(url, replace)
  }
  const todayKey = isoDate(storeDate(0))
  const when = (startAt: string) =>
    `${storeDayLabel(startAt) === todayKey.slice(5) ? '今天' : storeDayLabel(startAt)} ${storeClock(startAt)}`
  const first = unconfirmed[0]
  const opened = tables.find((table) => table.id === openId)
  const nothing =
    !waiting.length && !alerts.length && !open.length && !unconfirmed.length && !missed.length && !cancellations.length
  return (
    <StaffScreen
      title="现场"
      loading={data.loading}
      error={data.error}
      stale={data.data !== null}
      onRetry={data.refresh}
    >
      <View className={`workbench-view workbench-${role}`}>
        <View className="workbench-hero">
          <View className="workbench-account">
            <Text className="workbench-initial">{(auth.account?.nickname || '店').slice(0, 1)}</Text>
            <Text className="workbench-name">{auth.account?.nickname}</Text>
            <Text className="workbench-role">{roleNames[role]}</Text>
            {/* 连接正常时只是一个绿点加「实时」；断了才把话写全，给一个「刷新」 */}
            {live.connection === 'connected' ? (
              <Text className="workbench-live">实时 · 已连接</Text>
            ) : (
              <Button className="workbench-live workbench-live-off" ariaLabel="连接恢复中，刷新" onClick={data.refresh}>
                {live.polling ? '连接恢复中 · 刷新' : '连接中断 · 刷新'}
              </Button>
            )}
          </View>
          <View className="workbench-counts">
            {(
              [
                ['空闲', free, 'free'],
                ['使用中', busy, 'busy'],
                ['需关注', attention, 'attention'],
              ] as const
            ).map(([label, value, tone]) => (
              <Button
                key={label}
                className={`workbench-count-card workbench-count-${tone}`}
                ariaLabel={`${label} ${value} 张，去桌位`}
                onClick={() => go('/pages/staff/tables/index', true)}
              >
                <Text className="workbench-count-label">{label}</Text>
                <Text className="workbench-count-value">{value}</Text>
              </Button>
            ))}
          </View>
        </View>

        <ServiceCallAlerts refetchInterval={live.refetchInterval} />

        <View className="workbench-block">
          <Text className="workbench-block-title">等你处理</Text>
          <View className="workbench-todo">
            {waiting.map((entry) => (
              <AdmissionRow
                key={entry.admission.id}
                entry={entry}
                tables={data.data?.shift.tables || []}
                billing={billing}
                now={now}
              />
            ))}
            {alerts.map((alert) => (
              <Button
                key={alert.table.id}
                className="workbench-row"
                ariaLabel={`${alert.table.code || `${alert.table.number}号桌`}，${alert.text}，查看会话`}
                onClick={() => setOpenId(alert.table.id)}
              >
                <View className={`workbench-dot ${alert.overdue ? 'workbench-dot-danger' : 'workbench-dot-warning'}`} />
                <View className="workbench-row-copy">
                  <Text className="workbench-row-title">
                    {alert.table.code || `${alert.table.number}号桌`} {alert.text.replace('剩余', '还剩')}
                  </Text>
                  <Text className="workbench-row-meta">
                    {alert.overdue ? '客人还在就续时，做完了点「结束」' : '快到点了，问问客人要不要续时'}
                  </Text>
                </View>
                <Text className="workbench-row-arrow">›</Text>
              </Button>
            ))}
            {open.length > 0 && (
              <Button
                className="workbench-row"
                ariaLabel={`${open.length} 单待结账，去收款`}
                onClick={() => go('/pages/staff/orders/index')}
              >
                <View className="workbench-dot workbench-dot-gold" />
                <View className="workbench-row-copy">
                  <Text className="workbench-row-title">{open.length} 单待结账</Text>
                  <Text className="workbench-row-meta">停了表、收了一部分的都在这里</Text>
                </View>
                <Text className="workbench-row-arrow">›</Text>
              </Button>
            )}
            {cancellations.map((entry) => (
              <CancelledRow key={entry.reservation.id} entry={entry} tables={data.data?.shift.tables || []} />
            ))}
            {missed.length > 0 && (
              <Button
                className="workbench-row"
                ariaLabel={`${missed.length} 条预约过了时间还没来，去预约`}
                onClick={() => go('/pages/staff/reservations/index', true)}
              >
                <View className="workbench-dot workbench-dot-danger" />
                <View className="workbench-row-copy">
                  <Text className="workbench-row-title">{missed.length} 条预约过了时间还没来</Text>
                  <Text className="workbench-row-meta">标记爽约，或者顾客说不来了就取消</Text>
                </View>
                <Text className="workbench-row-arrow">›</Text>
              </Button>
            )}
            {first && (
              <Button
                className="workbench-row"
                ariaLabel={`${unconfirmed.length} 条预约等确认，去预约`}
                onClick={() => go('/pages/staff/reservations/index', true)}
              >
                <View className="workbench-dot workbench-dot-ink" />
                <View className="workbench-row-copy">
                  <Text className="workbench-row-title">{unconfirmed.length} 条预约等确认</Text>
                  <Text className="workbench-row-meta">
                    最早 {when(first.reservation.startAt)}
                    {first.tableNumber ? ` · ${first.tableNumber} 号桌` : ''}
                    {first.customerName ? ` · ${first.customerName}` : ''}
                  </Text>
                </View>
                <Text className="workbench-row-arrow">›</Text>
              </Button>
            )}
            {nothing && (
              <Text className="workbench-empty">现在没有要处理的事。顾客扫码入座、桌快到点时会出现在这里。</Text>
            )}
          </View>
        </View>

        <Button
          className="workbench-start"
          ariaLabel="客人到店，计时开台，去平面图点一张空桌"
          onClick={() => go('/pages/staff/tables/index', true)}
        >
          <View className="workbench-start-copy">
            <Text className="workbench-start-title">客人到店，计时开台</Text>
            <Text className="workbench-start-note">去平面图点一张空桌</Text>
          </View>
          <Text className="workbench-row-arrow">›</Text>
        </Button>

        <View className="workbench-shortcuts">
          <Button className="workbench-shortcut" onClick={() => go('/pages/staff/receiving/index')}>
            收货入库
          </Button>
          <Button className="workbench-shortcut" onClick={() => go('/pages/staff/web-login/index')}>
            连电脑
          </Button>
        </View>

        {/* ★ 品牌精神只放员工端：店员一天要开几十次这一页，页脚一句小字是刚好的剂量。
            版本号：店员报「这个功能没有啊」时，第一句要问的就是他跑的哪一版 */}
        <Text className="workbench-spirit">
          {brandSpirit} · 版本 {appVersion}
        </Text>
      </View>
      {opened && <TableSheet table={opened} onClose={() => setOpenId('')} refetchInterval={live.refetchInterval} />}
    </StaffScreen>
  )
}

/**
 * 工作台最顶上：顾客在座位上点了「呼叫店员」、还没人处理的，「B3 桌 呼叫 · 3 分钟前」加「我去处理」「已处理」。
 * 没有呼叫时整块不显示。新呼叫到达（这次读到、上次没有）时手机马上振，之后没人处理就每 4 秒振一次，
 * 直到引起振动的呼叫都不用提醒了（有人点了「我去处理」或「已处理」，在哪点的都算，等重读）、点了「知道了」，或振满 5 分钟。
 * 有人认领的这一条写「阿贝 正在处理 · 2 分钟前」，只留「已处理」；认领满 10 分钟还没处理的重新振、谁都能再认领。
 * 页面不显示时查询停用、不振，回到工作台重读后还要提醒的接着振。是否认领、过期、已处理都以接口为准，等重读才变。
 */
function ServiceCallAlerts({ refetchInterval }: { refetchInterval: number | false }) {
  const me = useCustomer().account?.id
  const visible = usePageVisible()
  const calls = useStaffQuery(['service-calls', 'open'], serviceCalls.open, { refetchInterval })
  const refreshAll = useRefreshAll()
  const now = useNow(30000)
  // 正在提交的是哪条的哪个动作（「claim:编号」「handle:编号」）
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  // 上次读到的、要提醒的呼叫（alertKeys）；null 表示还没读到过（打开工作台时已经挂着的不振）
  const seen = useRef<Set<string> | null>(null)
  // 振动状态放 ref（每次重读都会算一遍，放 state 会让定时器跟着重启）；buzzing 只管显示「知道了」和开关定时器
  const buzz = useRef<Buzz | null>(null)
  const [buzzing, setBuzzing] = useState(false)
  const lastBuzz = useRef(0)
  // 回到工作台的时间与最近一次读到列表的时间：回来后先等重读，锁屏期间别处已处理的呼叫不再振一下
  const shownAt = useRef(0)
  const readAt = useRef(0)
  readAt.current = calls.updatedAt ?? 0
  const vibrate = () => {
    lastBuzz.current = Date.now()
    void Taro.vibrateLong().catch(() => undefined)
  }
  const quiet = () => {
    buzz.current = null
    setBuzzing(false)
  }
  useEffect(() => {
    if (visible) shownAt.current = Date.now()
  }, [visible])
  useEffect(() => {
    const list = calls.data
    if (!list) return
    const fresh = arrivals(seen.current, list)
    seen.current = alertKeys(list)
    buzz.current = buzzAfterRead(buzz.current, fresh, list, Date.now())
    setBuzzing(buzz.current !== null)
    if (fresh.length > 0 && visible) vibrate()
  }, [calls.data, visible])
  // 新呼叫没人处理就每 4 秒振一次，最长 5 分钟（buzzDue）；页面不显示时停，回来接着按真实时间算
  useEffect(() => {
    if (!buzzing || !visible) return
    const timer = setInterval(() => {
      if (readAt.current < shownAt.current) return
      const due = buzzDue(buzz.current, lastBuzz.current, Date.now())
      if (due === 'stop') quiet()
      else if (due === 'buzz') vibrate()
    }, 1000)
    return () => clearInterval(timer)
  }, [buzzing, visible])
  // 「我去处理」「已处理」：不做乐观更新，成功、失败都等重读（别人已认领时显示后端的「XX 已在处理」）
  const act = async (action: 'claim' | 'handle', call: ServiceCall) => {
    if (busy) return
    setBusy(`${action}:${call.id}`)
    setError('')
    try {
      if (action === 'claim') {
        await serviceCalls.claim(call.id)
        void Taro.showToast({ title: '已认领', icon: 'success' })
      } else {
        await serviceCalls.handle(call.id)
        void Taro.showToast({ title: `${callTable(call)}已处理`, icon: 'success' })
      }
    } catch (e) {
      setError(staffMessage(e))
    } finally {
      setBusy('')
      void refreshAll()
    }
  }
  const list = calls.data || []
  if (list.length === 0) return error ? <Text className="field-error">{error}</Text> : null
  const at = Math.max(now, calls.updatedAt || 0)
  return (
    <View className="workbench-calls" role="alert">
      <View className="workbench-calls-head">
        <Text className="workbench-block-title workbench-calls-title">顾客呼叫</Text>
        {buzzing && (
          <Button className="workbench-calls-quiet" ariaLabel="知道了，停止振动" onClick={quiet}>
            知道了
          </Button>
        )}
      </View>
      {list.map((call) => {
        const seat = call.seatNumber > 0 ? `${call.seatNumber} 号座` : '整桌'
        const who = call.customer?.nickname || call.customer?.phoneMasked || '顾客'
        const note = claimNote(call, at, me)
        // 有人认领着：不再给「我去处理」（谁先认领算谁），「已处理」照旧谁都能点
        const claimed = call.claimStatus === 'claimed'
        return (
          <View className={`workbench-call${claimed ? ' workbench-call-claimed' : ''}`} key={call.id}>
            <View className="workbench-call-copy">
              <Text className="workbench-call-title">
                {callTable(call)} 呼叫 · {waited(call.createdAt, at)}
              </Text>
              <Text className="workbench-call-meta">
                {seat} · {who}
              </Text>
              {note && <Text className="workbench-call-claim">{note}</Text>}
            </View>
            <View className="workbench-call-actions">
              {!claimed && (
                <Button
                  className="workbench-button workbench-call-action"
                  ariaLabel={`${callTable(call)} ${seat}的呼叫，我去处理`}
                  disabled={!!busy}
                  loading={busy === `claim:${call.id}`}
                  onClick={() => {
                    void act('claim', call)
                  }}
                >
                  我去处理
                </Button>
              )}
              <Button
                className="workbench-button workbench-button-dark workbench-call-action"
                ariaLabel={`${callTable(call)} ${seat}的呼叫，标记已处理`}
                disabled={!!busy}
                loading={busy === `handle:${call.id}`}
                onClick={() => {
                  void act('handle', call)
                }}
              >
                已处理
              </Button>
            </View>
          </View>
        )
      })}
      {error && <Text className="field-error">{error}</Text>}
    </View>
  )
}
