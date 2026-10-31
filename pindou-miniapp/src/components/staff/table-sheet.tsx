import { useRef, useState, type PropsWithChildren, type ReactNode } from 'react'
import { Input, Picker, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../button'
import { SheetCloseButton, SheetFrame } from '../sheet'
import { usePublicQuery, useRefreshAll, useStaffQuery } from '../../hooks/query'
import { useBillingEnabled } from '../../hooks/billing'
import { useCustomer } from '../../hooks/customer'
import { useNow } from '../../hooks/clock'
import { useServerSearch } from '../../hooks/server-search'
import { useLeaveGuard } from '../../hooks/leave-guard'
import { draftOrderNotice, staffApi, staffMessage, type ServiceTable, type VenueSession } from '../../services/staff'
import { loyalty, type Admission, type Table } from '../../services/membership'
import { scanMemberCode, type MemberScan } from '../../services/member-code'
import { fromStoreDateTime, storeDateTime } from '../../services/staff-workflow'
import { isOpenOrder, money } from '../../services/format'
import { endConfirm } from '../../services/billing'
import { couponText } from '../../services/coupon'
import { zoneOf, type SeatZone } from '../../services/seatmap'
import { storeClock } from '../../services/reservations'
import { navigateApp } from '../../services/navigation'
import { accountText, type AccountChoice } from './account-search'
import './table-sheet.scss'

// 桌位页（和现场页）的底部弹层（2026-10-20 重做，docs/plan-page-redesign.md 第 2 节第 4、5 条）：
// 点空桌从底部弹出「开台」，点使用中的桌弹出「会话」，不再跳到单独的开台页、会话页；
// 扫码入座的按座会话也用同一个会话弹层，不再跳「会员与计时」的列表。
//
// 规则没变：开台的回填、到打烊、自由计时同原来的开台页；会话两条后端路径（整桌走 /venue-sessions PATCH，
// 扫码开的按座会话走 loyalty.action），差别只在这里挑路，店员看到的按钮一样。
// 系统内收费关着时不显示应收、不给停止计时和去收款，主按钮是「结束，放出座位」。

/** 「1 小时」「1 小时 30 分」「45 分钟」。 */
export function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const rest = minutes % 60
  return rest ? `${Math.floor(minutes / 60)} 小时 ${rest} 分` : `${minutes / 60} 小时`
}

/** 「其他时长」滚轮：30 分钟一档，30 分钟到 8 小时（业主 10-20 定）。 */
export const otherDurations = Array.from({ length: 16 }, (_, index) => (index + 1) * 30)

/** 读不到已发布的计时套餐时，开台时长按钮退回这几个。 */
const fallbackDurations = [60, 120, 180]

/** 整桌续时「续 N 分钟」的几项：后端按开台时记下的价给的续时方案的 1、2、3 块（续时上限 1440 分钟以内的）。 */
export const renewChoices = (plan: { minutes: number }) =>
  [1, 2, 3].map((blocks) => blocks * plan.minutes).filter((minutes) => minutes <= 1440)

/** 自己填的续时分钟：1–1440 的整数，否则 null。 */
export function renewMinutesInput(text: string | undefined): number | null {
  const value = (text || '').trim()
  if (!/^\d{1,4}$/.test(value)) return null
  const minutes = Number(value)
  return minutes >= 1 && minutes <= 1440 ? minutes : null
}

const tableName = (table: Pick<ServiceTable, 'code' | 'number'>) => table.code || `${table.number} 号桌`

/** 弹层的外壳：遮罩、把手、标题行（桌号、状态、一行说明）和关闭（开关和拖着关见 components/sheet.tsx）。正在提交时不让关。 */
export function StaffSheet({
  title,
  pill,
  pillTone = 'plain',
  meta,
  busy = false,
  onClose,
  children,
  footer,
  heading = true,
  className = '',
  closeIcon = '×',
  dirty = false,
}: PropsWithChildren<{
  title: string
  pill?: string
  pillTone?: 'plain' | 'danger' | 'warning' | 'free'
  meta?: ReactNode
  busy?: boolean
  onClose: () => void
  footer?: ReactNode
  heading?: boolean
  className?: string
  closeIcon?: ReactNode
  /** 填了字：点遮罩不关 */
  dirty?: boolean
}>) {
  return (
    <SheetFrame
      mask={`table-sheet-mask ${className ? `${className}-mask` : ''}`}
      panel={`table-sheet ${className}`}
      handle="table-sheet-handle"
      label={`${title}${pill ? ` ${pill}` : ''}`}
      locked={busy}
      dirty={dirty}
      onClose={onClose}
      head={
        heading ? (
          <View className="table-sheet-head">
            <View className="table-sheet-heading">
              <View className="table-sheet-title-row">
                <Text className="table-sheet-title">{title}</Text>
                {pill && <Text className={`table-sheet-pill table-sheet-pill-${pillTone}`}>{pill}</Text>}
              </View>
              {meta && <Text className="table-sheet-meta">{meta}</Text>}
            </View>
            <SheetCloseButton className="table-sheet-close" disabled={busy}>
              {closeIcon}
            </SheetCloseButton>
          </View>
        ) : null
      }
    >
      <View className="table-sheet-body">{children}</View>
      {footer && <View className="table-sheet-footer">{footer}</View>}
    </SheetFrame>
  )
}

/** 点到一张桌：空的开台，使用中的看会话。 */
export function TableSheet({
  table,
  onClose,
  refetchInterval,
}: {
  table: ServiceTable
  onClose: () => void
  refetchInterval?: number | false
}) {
  return table.occupancy === 'occupied' ? (
    <SessionSheet table={table} onClose={onClose} refetchInterval={refetchInterval} />
  ) : (
    <StartSheet table={table} onClose={onClose} />
  )
}

/**
 * 谁来坐：默认散客；「扫会员码」扫顾客手机上的会员码直接选中；也可以搜昵称、手机尾号。
 * 没输关键字时不去查、不列人（弹层里放不下一整页名单）。
 */
export function CustomerPick({
  value,
  onChange,
  disabled = false,
  scanCode = scanMemberCode,
}: {
  value: AccountChoice | null
  onChange: (value: AccountChoice | null) => void
  disabled?: boolean
  scanCode?: () => Promise<MemberScan>
}) {
  const [keyword, setKeyword] = useState('')
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const typed = !!keyword.trim()
  const result = useServerSearch(['accounts', 5], (text, page) => staffApi.searchAccounts(text, page, 5), keyword, {
    enabled: typed && !value,
  })
  const scan = async () => {
    if (scanning) return
    setScanning(true)
    setError('')
    try {
      const outcome = await scanCode()
      if (outcome.kind === 'found') {
        const { id, nickname, phoneMasked } = outcome.account
        onChange({ id, nickname, ...(phoneMasked ? { phoneMasked } : {}) })
        setKeyword('')
      } else if (outcome.kind === 'error') setError(outcome.message)
    } finally {
      setScanning(false)
    }
  }
  if (value)
    return (
      <View className="table-sheet-chosen">
        <Text className="table-sheet-chosen-name">{accountText(value)}</Text>
        <Button className="text-button" disabled={disabled} onClick={() => onChange(null)}>
          换成散客
        </Button>
      </View>
    )
  return (
    <View className="table-sheet-who">
      <View className="table-sheet-segments">
        <Button className="table-sheet-choice table-sheet-choice-on" ariaLabel="散客，已选中" disabled={disabled}>
          散客
        </Button>
        <Button
          className="table-sheet-choice"
          disabled={disabled}
          loading={scanning}
          onClick={() => {
            void scan()
          }}
        >
          {scanning ? '正在查找' : '扫会员码'}
        </Button>
      </View>
      <Input
        className="input table-sheet-search"
        ariaLabel="找会员：昵称、手机尾号或完整手机号"
        cursorSpacing={96}
        value={keyword}
        disabled={disabled}
        placeholder="或者搜昵称、手机尾号"
        onInput={(event) => setKeyword(event.detail.value)}
      />
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
      {typed && (
        <View className="table-sheet-results">
          {result.items.map((account) => (
            <Button
              key={account.id}
              className="staff-account-option"
              disabled={disabled}
              ariaLabel={accountText(account)}
              onClick={() => {
                onChange(account)
                setKeyword('')
              }}
            >
              <Text className="grow">{account.nickname || '未命名顾客'}</Text>
              <Text className="muted">{account.phoneMasked || '未绑定手机'}</Text>
            </Button>
          ))}
          {result.loading && <Text className="field-help">正在查找…</Text>}
          {!!result.error && <Text className="field-error">查找失败：{result.error}</Text>}
          {result.ready && !result.loading && result.items.length === 0 && (
            <Text className="field-help">没有匹配的顾客，可换个关键字，或就当散客开台。</Text>
          )}
        </View>
      )}
    </View>
  )
}

type Mode = 'timed' | 'close' | 'free'

/**
 * 开台：谁来坐、坐多久（已发布套餐的时长、到打烊、自由计时、其他时长）、默认从现在开始计（可以改早），「确认开台」。
 * 开始时间没动过就不带 startedAt，由服务器收到时开始计：不看手机时钟，找顾客拖了 25 分钟也不会从 25 分钟前算。
 */
export function StartSheet({ table, onClose }: { table: ServiceTable; onClose: () => void }) {
  const auth = useCustomer()
  const canBackdate = auth.account?.roles.some((role) => role === 'manager' || role === 'owner')
  const billing = useBillingEnabled()
  const refreshAll = useRefreshAll()
  // 已发布的计时套餐：时长按钮用店里真实卖的时长、标上价。读不到退回 1、2、3 小时，不挡开台。
  const rules = usePublicQuery(['loyalty-rules'], loyalty.public, { once: true })
  const published = (rules.data || []).filter(
    (rule) => rule.kind === 'package' && !rule.untilClose && rule.durationMinutes > 0,
  )
  const choices = [...new Set(published.map((rule) => rule.durationMinutes))].sort((a, b) => a - b).slice(0, 4)
  const durations = choices.length ? choices : fallbackDurations
  const priceOf = (minutes: number) => published.find((rule) => rule.durationMinutes === minutes)?.amountCents
  const [mode, setMode] = useState<Mode>('timed')
  const [duration, setDuration] = useState(0)
  const minutes = duration || durations[Math.min(1, durations.length - 1)]
  const [startedAt, setStartedAt] = useState('')
  const [account, setAccount] = useState<AccountChoice | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  useLeaveGuard(!!account || !!duration || mode !== 'timed' || !!startedAt, saving)
  const other = mode === 'timed' && !!duration && !durations.includes(duration)
  const submit = async () => {
    if (submitting.current) return
    submitting.current = true
    setSaving(true)
    setError('')
    try {
      await staffApi.createSession({
        serviceTableId: table.id,
        accountId: account?.id,
        ...(startedAt ? { startedAt: fromStoreDateTime(startedAt).toISOString() } : {}),
        timingMode: mode === 'free' ? 'free' : 'timed',
        ...(mode === 'timed' ? { durationMinutes: minutes } : {}),
        ...(mode === 'close' ? { untilClose: true as const } : {}),
      })
      void Taro.showToast({ title: '开台成功', icon: 'success' })
      void refreshAll()
      onClose()
    } catch (failure) {
      setError(staffMessage(failure))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }
  const start = startedAt ? fromStoreDateTime(startedAt) : new Date()
  const summary = `${account ? account.nickname || '会员' : '散客'} · ${
    mode === 'free' ? '自由计时' : mode === 'close' ? '到打烊' : minutesText(minutes)
  }`
  const until =
    mode === 'timed'
      ? `到 ${storeClock(new Date(start.getTime() + minutes * 60000))} 结束`
      : mode === 'close'
        ? '到今天打烊结束'
        : '按实际用的时间算'
  const zone = zoneOf((table.zone || '') as SeatZone)
  const choice = (selected: boolean) => `table-sheet-choice ${selected ? 'table-sheet-choice-on' : ''}`
  return (
    <StaffSheet
      title={tableName(table)}
      pill="开台"
      busy={saving}
      onClose={onClose}
      meta={[zone?.name, `${table.seatCount} 座${table.wholeTable ? ' · 整桌' : ''}`, '空闲']
        .filter(Boolean)
        .join(' · ')}
      footer={
        <>
          <View className="table-sheet-summary">
            <Text className="table-sheet-summary-main">{summary}</Text>
            <Text className="table-sheet-summary-note">{until}</Text>
          </View>
          <Button
            className="table-sheet-primary"
            disabled={saving}
            loading={saving}
            onClick={() => {
              void submit()
            }}
          >
            {saving ? '正在开台' : '确认开台'}
          </Button>
        </>
      }
    >
      <View className="table-sheet-section">
        <Text className="table-sheet-label">谁来坐</Text>
        <CustomerPick value={account} onChange={setAccount} disabled={saving} />
      </View>
      <View className="table-sheet-section">
        <Text className="table-sheet-label">坐多久</Text>
        <View className="table-sheet-grid">
          {durations.map((value) => {
            const on = mode === 'timed' && minutes === value && !other
            const price = billing ? priceOf(value) : undefined
            return (
              <Button
                key={value}
                className={choice(on)}
                disabled={saving}
                ariaLabel={`${minutesText(value)}${price !== undefined ? `，¥${money(price)}` : ''}${on ? '，已选中' : ''}`}
                onClick={() => {
                  setMode('timed')
                  setDuration(value)
                }}
              >
                <Text>{minutesText(value)}</Text>
                {price !== undefined && <Text className="table-sheet-choice-note">¥{money(price)}</Text>}
              </Button>
            )
          })}
          <Button
            className={choice(mode === 'close')}
            disabled={saving}
            ariaLabel={`到打烊${mode === 'close' ? '，已选中' : ''}`}
            onClick={() => setMode('close')}
          >
            到打烊
          </Button>
          <Button
            className={choice(mode === 'free')}
            disabled={saving}
            ariaLabel={`自由计时${mode === 'free' ? '，已选中' : ''}`}
            onClick={() => setMode('free')}
          >
            自由计时
          </Button>
          <Picker
            mode="selector"
            disabled={saving}
            range={otherDurations.map(minutesText)}
            value={Math.max(0, otherDurations.indexOf(other ? duration : 150))}
            onChange={(event) => {
              setMode('timed')
              setDuration(otherDurations[Number(event.detail.value)] || 30)
            }}
          >
            <View className={choice(other)} ariaLabel={other ? `其他时长，${minutesText(duration)}` : '其他时长'}>
              {other ? minutesText(duration) : '其他时长'}
            </View>
          </Picker>
        </View>
        {mode === 'close' && (
          <Text className="field-help">
            从开始时间算到今天打烊，之后不能暂停、续时、标陪客，也不能改时长或计时方式；过了打烊开不了。
          </Text>
        )}
      </View>
      <View className="table-sheet-start">
        <Text className="table-sheet-start-copy">
          从<Text className="strong">{startedAt ? startedAt.slice(11, 16) : '现在'}</Text>开始计
        </Text>
        {/* 开台只能是今天（后端只收当日）；店员只能回填最近 60 分钟，店长、老板能回填今天更早的 */}
        <Picker
          mode="time"
          disabled={saving}
          value={(startedAt || storeDateTime()).slice(11, 16)}
          onChange={(event) => setStartedAt(`${storeDateTime().slice(0, 10)}T${event.detail.value}`)}
        >
          <View className="table-sheet-link">客人早到了？改成更早</View>
        </Picker>
      </View>
      {startedAt && (
        <Text className="field-help">
          {canBackdate ? '可回填今天更早的开始时间，不能选择未来时间。' : '可回填最近 60 分钟内的开始时间。'}
          <Text className="table-sheet-inline-link" onClick={() => setStartedAt('')}>
            改回现在
          </Text>
        </Text>
      )}
      {error && (
        <View className="inline-error" role="alert">
          {error}
        </View>
      )}
    </StaffSheet>
  )
}

/** 「12:08」「1:58:12」：倒数、超时、已用的大数字。 */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`
}

type SheetData = {
  sessions: VenueSession[]
  tables: ServiceTable[]
  shift: { admissions: Admission[]; tables: Table[] } | null
}

/**
 * 会话：剩余或超时的大数字，开始 / 时长 / 到点 / 团购；续时、暂停、换桌；主按钮「结束，放出座位」
 * （收费开着时是「停止计时」「去收款」）；「撤销这次开台」放最下（只给整桌开台的）。
 * 按座会话的续时按套餐追加，换桌是换座（选到空着的座）；到打烊的不给暂停、续时。
 */
export function SessionSheet({
  table,
  onClose,
  refetchInterval,
}: {
  table: ServiceTable
  onClose: () => void
  refetchInterval?: number | false
}) {
  const billing = useBillingEnabled()
  const refreshAll = useRefreshAll()
  const data = useStaffQuery<SheetData>(
    ['table-sheet', table.id],
    async () => {
      const [sessions, tables] = await Promise.all([staffApi.listLiveSessions(), staffApi.listTables()])
      const mine = sessions.filter((session) => session.serviceTableId === table.id)
      // 扫码开的按座会话不能走 /venue-sessions PATCH（后端 409），续时、暂停、换座都走 loyalty.action，要它的计时版本
      const shift = mine.some((session) => session.admissionId) ? await loyalty.shift() : null
      return { sessions: mine, tables, shift }
    },
    { refetchInterval: refetchInterval ?? 30000 },
  )
  const now = useNow(1000)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const sessions = data.data?.sessions || []
  // 同一张桌上几个按座会话（多座、按座卖的桌）：上面列座号切换；门店现在的桌一张只坐一组
  const session = sessions.find((value) => value.id === pick) || sessions[0]
  const summary = data.data?.tables.find((value) => value.id === table.id) || table
  const admission = session?.admissionId
    ? data.data?.shift?.admissions.find((entry) => entry.session?.id === session.id)
    : undefined
  const seatBased = !!session?.admissionId
  const customerId = session?.accountId || ''
  const named = admission?.customer
  const account = useStaffQuery(['accounts', customerId], () => staffApi.getAccount(customerId), {
    enabled: !!customerId && named?.id !== customerId,
    once: true,
  })
  const customerName = session?.accountId
    ? [named, account.data].find((value) => value?.id === customerId)?.nickname || '会员'
    : '散客'
  const run = async (task: () => Promise<boolean | void>) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const closed = await task()
      void refreshAll()
      if (closed) onClose()
    } catch (failure) {
      setError(staffMessage(failure))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const needAdmission = () => {
    if (!admission) throw new Error('体验信息还没读到，请稍后再点一次')
    return admission
  }
  const zone = zoneOf((summary.zone || '') as SeatZone)
  if (!session)
    return (
      <StaffSheet title={tableName(table)} onClose={onClose} meta={zone?.name}>
        {data.loading ? (
          <Text className="field-help">正在读取这张桌的会话…</Text>
        ) : data.error ? (
          <View className="inline-error" role="alert">
            {staffMessage(data.error)}
          </View>
        ) : (
          <Text className="field-help">这张桌的会话已经结束了。</Text>
        )}
      </StaffSheet>
    )
  const stopped = !!session.stoppedAt
  const paused = session.status === 'paused'
  const companion = session.status === 'companion'
  const untilClose = !!session.untilClose
  const free = session.timingMode === 'free'
  // 剩余与超时：按座会话取这位顾客自己的，整桌取桌位的；两次重读之间按读到的那一刻往下数
  const readAt = data.updatedAt || now
  const ticking = !stopped && !paused && !companion
  const elapsedFor = (seconds: number) => seconds + (ticking ? (now - readAt) / 1000 : 0)
  let remaining: number | null = null
  if (seatBased && admission) {
    remaining = admission.overdueSeconds ? -admission.overdueSeconds : (admission.remainingSeconds ?? null)
    if (remaining !== null && ticking) remaining -= (now - readAt) / 1000
  } else if (!free && summary.endsAt) {
    remaining = paused ? (summary.remainingSeconds ?? null) : (Date.parse(summary.endsAt) - now) / 1000
  }
  const overdue = remaining !== null && remaining < 0
  const expiring = remaining !== null && !overdue && remaining <= 600
  const elapsed = elapsedFor(
    seatBased && admission ? admission.elapsedSeconds || 0 : (readAt - Date.parse(session.startedAt)) / 1000,
  )
  const state = stopped
    ? billing
      ? '待结账'
      : '已停表'
    : companion
      ? '陪客'
      : paused
        ? '已暂停'
        : overdue
          ? '超时'
          : expiring
            ? '快到点'
            : '使用中'
  const tone = stopped || paused ? 'plain' : overdue ? 'danger' : expiring ? 'warning' : 'plain'
  const ends = session.durationMinutes
    ? new Date(Date.parse(session.startedAt) + session.durationMinutes * 60000)
    : null
  const coupon = admission?.admission.coupon ? couponText(admission.admission.coupon).split(' · ')[0] : ''
  const renewal = admission?.admission.package
  const orderOfSeat = admission?.order && isOpenOrder(admission.order) ? admission.order : undefined
  // 换桌：整桌会话挑空着的桌，按座会话挑空着的座（座号跟着变）
  const freeTables = (data.data?.tables || []).filter(
    (value) => value.enabled && value.occupancy === 'idle' && value.id !== session.serviceTableId,
  )
  const freeSeats = (data.data?.shift?.tables || []).flatMap((value) =>
    Array.from({ length: value.seatCount }, (_, index) => index + 1)
      .filter((seat) => !value.occupiedSeats.includes(seat))
      .map((seat) => ({ table: value, seat })),
  )
  const moves = seatBased
    ? freeSeats.map((x) => ({
        label:
          x.table.seatCount > 1
            ? `${x.table.code || x.table.number} · ${x.seat} 号座`
            : x.table.code || `${x.table.number} 号桌`,
        tableId: x.table.id,
        seat: x.seat,
      }))
    : freeTables.map((x) => ({ label: tableName(x), tableId: x.id, seat: 0 }))

  const pauseOrResume = () =>
    run(async () => {
      if (seatBased) {
        const a = needAdmission()
        await loyalty.action({
          action: paused ? 'resume' : 'pause',
          targetId: session.id,
          expectedVersion: a.sessionVersion,
        })
      } else await staffApi.updateSession(session.id, { status: paused ? 'active' : 'paused' })
      void Taro.showToast({ title: paused ? '已继续' : '已暂停', icon: 'success' })
    })
  const move = (index: number) =>
    run(async () => {
      const target = moves[index]
      if (!target) return
      if (seatBased) {
        const a = needAdmission()
        await loyalty.action({
          action: 'move',
          targetId: session.id,
          expectedVersion: a.sessionVersion,
          serviceTableId: target.tableId,
          seatNumber: target.seat,
        })
      } else await staffApi.updateSession(session.id, { serviceTableId: target.tableId })
      void Taro.showToast({ title: `已换到 ${target.label}`, icon: 'none' })
      return true
    })
  /** 自己填续多少分钟（弹窗的输入框，基础库 2.17.1 起）；取消、填得不对时为 null。 */
  const askRenewMinutes = async (): Promise<number | null> => {
    // editable / placeholderText 与结果里的 content 是微信基础库 2.17.1 起就有的，@tarojs/taro 的类型还没跟上
    const answer = (await Taro.showModal({
      title: '续多少分钟',
      editable: true,
      placeholderText: '填 1 到 1440 的整数',
      confirmText: '确认续时',
    } as Taro.showModal.Option)) as Taro.showModal.SuccessCallbackResult & { content?: string }
    if (!answer.confirm) return null
    const minutes = renewMinutesInput(answer.content)
    if (minutes === null) void Taro.showToast({ title: '续时要填 1 到 1440 的整数分钟', icon: 'none' })
    return minutes
  }
  /** 续时：按座会话按套餐追加（先确认分钟和费用）；整桌会话按续时方案选或自己填追加多久。 */
  const renew = () =>
    run(async () => {
      if (seatBased) {
        const a = needAdmission()
        const rule = a.admission.package
        if (!rule.renewalMinutes) return
        const answer = await Taro.showModal({
          title: '续时',
          content: billing
            ? `追加 ${rule.renewalMinutes} 分钟及 ¥${money(rule.renewalCents)} 费用？`
            : `追加 ${rule.renewalMinutes} 分钟？`,
          confirmText: '确认续时',
        })
        if (!answer.confirm) return
        await loyalty.action({ action: 'renew', targetId: session.id, expectedVersion: a.sessionVersion })
        void Taro.showToast({ title: '已续时', icon: 'success' })
        return
      }
      // 整桌会话：有续时方案（后端按开台时记下的价给）就列「续 N 分钟」和「其他时长」；没有方案只能自己填，
      // 对不上套餐加续时的结账时要填计时费
      const expectedDurationMinutes = session.durationMinutes
      const choices = session.renewal ? renewChoices(session.renewal) : []
      let extendMinutes: number | null
      if (choices.length) {
        let picked: number
        try {
          picked = (
            await Taro.showActionSheet({
              itemList: [...choices.map((value) => `续 ${minutesText(value)}`), '其他时长'],
            })
          ).tapIndex
        } catch {
          return
        }
        extendMinutes = picked < choices.length ? choices[picked] : await askRenewMinutes()
      } else extendMinutes = await askRenewMinutes()
      if (extendMinutes === null) return
      // 追加分钟数，带上看到的时长：别人刚续过或页面过期时后端回 409，不会互相覆盖
      const updated = await staffApi.updateSession(session.id, { extendMinutes, expectedDurationMinutes })
      const notice = draftOrderNotice(updated)
      if (notice && !notice.repriced)
        await Taro.showModal({ title: '请核对待结账订单', content: notice.text, showCancel: false })
      else void Taro.showToast({ title: notice ? notice.text : '已续时', icon: 'none' })
    })
  /** 结束并放座（收费关着时）：会话变成 ended，座位立刻放出。 */
  const end = () =>
    run(async () => {
      const answer = await Taro.showModal(endConfirm('这一台'))
      if (!answer.confirm) return
      if (seatBased) {
        const a = needAdmission()
        await loyalty.action({ action: 'end', targetId: session.id, expectedVersion: a.sessionVersion })
      } else await staffApi.updateSession(session.id, { end: true })
      void Taro.showToast({ title: '已结束，座位已放出', icon: 'none' })
      return true
    })
  /** 停止计时（收费开着时）：停在这一刻，计时费按这一刻算、不再变，座位保留到结账。 */
  const stop = () =>
    run(async () => {
      const answer = await Taro.showModal({
        title: '停止计时',
        content: '停止计时，保留座位直到结账？停止后计时费按这一刻算、不再变，不能再暂停、继续或续时。',
        confirmText: '停止计时',
        cancelText: '取消',
      })
      if (!answer.confirm) return
      if (seatBased) {
        const a = needAdmission()
        await loyalty.action({ action: 'stop', targetId: session.id, expectedVersion: a.sessionVersion })
      } else await staffApi.updateSession(session.id, { stop: true })
      void Taro.showToast({ title: '已停止计时', icon: 'success' })
    })
  /** 去收款：按座会话的单开台时就有了；整桌的这时建单。 */
  const checkout = () =>
    run(async () => {
      const id = seatBased
        ? orderOfSeat?.id
        : (await staffApi.createOrder({ venueSessionId: session.id, accountId: session.accountId })).id
      if (!id) throw new Error('这一台的订单还没读到，请稍后再点一次')
      onClose()
      void navigateApp(`/pages/staff/checkout/index?id=${encodeURIComponent(id)}`)
    })
  /** 标记陪客（只有整桌开台的）：标了就改不回，标错只能撤销开台后重开，先确认。 */
  const markCompanion = () =>
    run(async () => {
      const answer = await Taro.showModal({
        title: '标记陪客',
        content: '标记后这一台不计时、不收计时费，不能再暂停或继续，也改不回普通计时；标错了只能撤销开台后重开。',
        confirmText: '标记陪客',
        cancelText: '取消',
      })
      if (!answer.confirm) return
      await staffApi.updateSession(session.id, { status: 'companion' })
      void Taro.showToast({ title: '已标记陪客', icon: 'success' })
    })
  const cancel = () =>
    run(async () => {
      const answer = await Taro.showModal({
        title: '撤销开台',
        content: billing ? '撤销这次还没结账的开台？实际消费请结账。' : '撤销这次误开的开台？顾客用完了请点「结束」。',
        confirmText: '撤销开台',
      })
      if (!answer.confirm) return false
      await staffApi.cancelSession(session.id)
      void Taro.showToast({ title: '已撤销', icon: 'none' })
      return true
    })

  const canTime = !stopped && !companion && !untilClose
  const bigLabel = stopped
    ? '计时已停止'
    : free || companion
      ? '已用'
      : overdue
        ? '已超时'
        : paused
          ? '暂停中 · 还剩'
          : '还剩'
  const bigValue =
    stopped || free || companion || remaining === null
      ? clockText(elapsed)
      : overdue
        ? `+${clockText(-remaining)}`
        : clockText(remaining)
  const hint = stopped
    ? billing
      ? '计时已停止，等结账；座位保留到收完款。'
      : '计时已停止，顾客走了点「结束」放出座位。'
    : untilClose
      ? '用到今天打烊：不能暂停、续时，顾客走了点「结束」。'
      : billing
        ? '客人还想坐就续时；做完了先停止计时，再去收款。'
        : '客人还想坐就续时；做完了点「结束」，座位马上放出来。'
  return (
    <StaffSheet
      title={tableName(summary)}
      pill={state}
      pillTone={tone}
      busy={busy}
      onClose={onClose}
      meta={[zone?.name, customerName, seatBased && summary.seatCount > 1 ? `${session.seatNumber} 号座` : '']
        .filter(Boolean)
        .join(' · ')}
      footer={
        <>
          {billing ? (
            <View className="table-sheet-pair">
              {!stopped && !companion && (
                <Button className="table-sheet-secondary" disabled={busy} onClick={() => void stop()}>
                  停止计时
                </Button>
              )}
              <Button
                className="table-sheet-primary"
                disabled={busy || (seatBased && !orderOfSeat)}
                onClick={() => void checkout()}
              >
                {summary.estimatedCents === undefined ? '去收款' : `去收款 ¥${money(summary.estimatedCents)}`}
              </Button>
            </View>
          ) : (
            <Button
              className="table-sheet-primary"
              disabled={busy || (seatBased && !admission)}
              onClick={() => void end()}
            >
              结束，放出座位
            </Button>
          )}
          {!seatBased && (
            <Button className="table-sheet-quiet" disabled={busy} onClick={() => void cancel()}>
              开错了？撤销这次开台
            </Button>
          )}
        </>
      }
    >
      {sessions.length > 1 && (
        <View className="table-sheet-segments">
          {sessions.map((value) => (
            <Button
              key={value.id}
              className={`table-sheet-choice ${value.id === session.id ? 'table-sheet-choice-on' : ''}`}
              disabled={busy}
              onClick={() => setPick(value.id)}
            >
              {value.seatNumber ? `${value.seatNumber} 号座` : '整桌'}
            </Button>
          ))}
        </View>
      )}
      <View
        className={`table-sheet-timer ${overdue && !stopped ? 'table-sheet-timer-danger' : ''}`}
        ariaLabel={`${bigLabel} ${bigValue}`}
      >
        <View className="table-sheet-timer-main">
          <Text className="table-sheet-timer-label">{bigLabel}</Text>
          <Text className="table-sheet-timer-value">{bigValue}</Text>
        </View>
        <View className="table-sheet-facts">
          <View className="table-sheet-fact">
            <Text className="table-sheet-fact-label">开始</Text>
            <Text className="table-sheet-fact-value">{storeClock(session.startedAt)}</Text>
          </View>
          <View className="table-sheet-fact">
            <Text className="table-sheet-fact-label">时长</Text>
            <Text className="table-sheet-fact-value">
              {free
                ? '自由计时'
                : untilClose
                  ? '到打烊'
                  : companion
                    ? '陪客'
                    : minutesText(session.durationMinutes || 0)}
            </Text>
          </View>
          <View className="table-sheet-fact">
            <Text className="table-sheet-fact-label">到点</Text>
            <Text className="table-sheet-fact-value">
              {free || companion ? '—' : summary.endsAt ? storeClock(summary.endsAt) : ends ? storeClock(ends) : '—'}
            </Text>
          </View>
          <View className="table-sheet-fact">
            <Text className="table-sheet-fact-label">团购</Text>
            <Text className="table-sheet-fact-value">{coupon || '无'}</Text>
          </View>
        </View>
      </View>
      {billing && (
        <View className="table-sheet-charge">
          <View className="table-sheet-charge-row">
            <Text>应收</Text>
            {summary.estimatedCents === undefined ? (
              <Text className="muted">结账时填价</Text>
            ) : (
              <Text className="money">¥{money(summary.estimatedCents)}</Text>
            )}
          </View>
          {summary.charge && <Text className="field-help">{summary.charge.summary}</Text>}
        </View>
      )}
      <Text className="table-sheet-hint">{hint}</Text>
      {/* 停了表、陪客、到打烊的也能换桌（同原来的会话页），只是不给续时、暂停 */}
      <View className="table-sheet-grid table-sheet-actions">
        {canTime && (
          <Button
            className="table-sheet-choice"
            disabled={busy || (seatBased && !renewal?.renewalMinutes)}
            onClick={() => void renew()}
          >
            {seatBased
              ? renewal?.renewalMinutes
                ? `续 ${minutesText(renewal.renewalMinutes)}${billing ? ` +¥${money(renewal.renewalCents)}` : ''}`
                : '套餐不能续时'
              : '续时'}
          </Button>
        )}
        {canTime && (
          <Button className="table-sheet-choice" disabled={busy} onClick={() => void pauseOrResume()}>
            {paused ? '继续' : '暂停'}
          </Button>
        )}
        <Picker
          mode="selector"
          disabled={busy || !moves.length}
          range={moves.map((value) => value.label)}
          onChange={(event) => void move(Number(event.detail.value))}
        >
          <View className={`table-sheet-choice ${moves.length ? '' : 'table-sheet-choice-off'}`}>
            {moves.length ? (seatBased ? '换座' : '换桌') : '没有空桌可换'}
          </View>
        </Picker>
      </View>
      {!seatBased && canTime && (
        <Button className="table-sheet-inline" disabled={busy} onClick={() => void markCompanion()}>
          这桌是陪客？标记陪客（不计时）
        </Button>
      )}
      {error && (
        <View className="inline-error" role="alert">
          {error}
        </View>
      )}
    </StaffSheet>
  )
}
