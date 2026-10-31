import { Image, Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import Taro, { useRouter } from '@tarojs/taro'
import { StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { TableSheet } from '../../../components/staff/table-sheet'
import { staffApi, staffMessage, type ServiceTable } from '../../../services/staff'
import { useBillingEnabled } from '../../../hooks/billing'
import { useCustomer } from '../../../hooks/customer'
import { useNow } from '../../../hooks/clock'
import { useEffect, useMemo, useRef, useState } from 'react'
import { planSeats, planSize, zoneOf, type SeatZone } from '../../../services/seatmap'
import { overdueMinutes, timingAlerts } from '../../../services/timing-alerts'
import './index.scss'

// ★★ 这一页给店员回答一个问题：**哪桌空着，我给客人开台**。别的都是次要的。
//
//    · 默认就是**平面图**，和顾客端同一张底图、同一套坐标。每张桌按状态着色（2026-10-20 重做）：
//      空闲绿框、使用中深色并写剩几分钟、快到点金色、超时红色、停用斜纹。图下列出超时和快到点的桌。
//    · 筛选一行四项：全部 / 空闲 / 使用中 / 需关注（超时、快到点、停用）。
//    · 点空桌从底部弹出「开台」，点使用中的弹出「会话」（components/staff/table-sheet.tsx），不再跳页。
//    · 「停用 / 启用」是低频操作，只给店长和老板：列表视图里一个小按钮；图上点到停用的桌问要不要启用。

const pct = (value: number, total: number) => `${((value / total) * 100).toFixed(3)}%`
const boxOf = (o: { x: number; y: number; w: number; h: number }) => ({
  left: pct(o.x, planSize.width),
  top: pct(o.y, planSize.height),
  width: pct(o.w, planSize.width),
  height: pct(o.h, planSize.height),
})

/**
 * 一张桌当前处于哪种状态，和着色、筛选、文案一一对应。
 * 停止计时、等结账的桌（后端的 stopped）算使用中：计时已经停了，不再按停止那一刻的剩余时间催。
 */
type Mark = 'free' | 'busy' | 'expiring' | 'overdue' | 'off'
const markOf = (table: ServiceTable): Mark =>
  !table.enabled
    ? 'off'
    : table.occupancy !== 'occupied'
      ? 'free'
      : table.stopped
        ? 'busy'
        : table.timingStatus === 'overdue'
          ? 'overdue'
          : table.timingStatus === 'expiring'
            ? 'expiring'
            : 'busy'

const statusText = (table: ServiceTable, billing: boolean) =>
  ({
    off: '已停用',
    free: '空闲',
    busy: table.stopped ? (billing ? '待结账' : '已停表') : '使用中',
    expiring: '快到点',
    overdue: '已超时',
  })[markOf(table)]

/** 方块上桌号下面那个小字：剩几分钟、超时「+12」、自由计时「自由」、停了表「停」。空桌和停用的不写。 */
function minutesOn(table: ServiceTable, now: number): string {
  if (!table.enabled || table.occupancy !== 'occupied') return ''
  if (table.stopped) return '停'
  if (table.timingMode === 'free' && !table.endsAt) return '自由'
  if (!table.endsAt) return ''
  const seconds = (Date.parse(table.endsAt) - now) / 1000
  if (table.timingStatus === 'overdue') return `+${overdueMinutes(Math.max(1, -seconds))}`
  return String(Math.max(0, Math.ceil(seconds / 60)))
}

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'free', label: '空闲' },
  { key: 'busy', label: '使用中' },
  { key: 'attention', label: '需关注' },
] as const
type Filter = (typeof FILTERS)[number]['key']

const matches = (table: ServiceTable, filter: Filter) => {
  const mark = markOf(table)
  switch (filter) {
    case 'free':
      return mark === 'free'
    case 'busy':
      return mark === 'busy' || mark === 'expiring' || mark === 'overdue'
    case 'attention':
      // 超时、快到点、停用 —— 都是「店员该看一眼」的桌
      return mark === 'expiring' || mark === 'overdue' || mark === 'off'
    default:
      return true
  }
}

const LEGEND = [
  ['free', '空闲，点了开台'],
  ['busy', '使用中，数字是剩几分钟'],
  ['expiring', '快到点'],
  ['overdue', '超时'],
  ['off', '停用'],
] as const

export default function StaffTables() {
  const { params } = useRouter()
  const live = useStaffEvents(5000)
  const data = useStaffQuery(['service-tables'], () => staffApi.listTables(), { refetchInterval: live.refetchInterval })
  // 进行中的会话只为图下「快到点 / 已超时」认出暂停中、已停止计时的桌（它们不提醒），和现场页一个口径
  const sessions = useStaffQuery(['venue-sessions', 'live'], () => staffApi.listLiveSessions(), {
    refetchInterval: live.refetchInterval,
  })
  const auth = useCustomer()
  const billing = useBillingEnabled()
  const now = useNow(30000)
  const canToggle = !!auth.account?.roles.some((role) => role === 'manager' || role === 'owner')
  const [filter, setFilter] = useState<Filter>('all')
  const [view, setView] = useState<'plan' | 'list'>('plan')
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  // 弹层开着的是哪张桌（记编号，内容随重读更新）；从别处带 ?tableId= 进来的直接打开
  const [openId, setOpenId] = useState(params.tableId || '')
  const submitting = useRef(false)
  useEffect(() => {
    if (params.tableId) setOpenId(params.tableId)
  }, [params.tableId])

  const tables = useMemo(() => data.data || [], [data.data])
  const byCode = useMemo(() => new Map(tables.filter((t) => t.code).map((t) => [t.code as string, t])), [tables])
  const shown = useMemo(
    () => tables.filter((t) => matches(t, filter)).sort((a, b) => (a.code || '').localeCompare(b.code || '')),
    [tables, filter],
  )
  const counts = useMemo(() => {
    const c = { all: tables.length, free: 0, busy: 0, attention: 0 }
    for (const t of tables) for (const f of ['free', 'busy', 'attention'] as const) if (matches(t, f)) c[f]++
    return c
  }, [tables])
  const alerts = timingAlerts(tables, sessions.data || [], now)
  const opened = tables.find((t) => t.id === openId)

  const enter = (table: ServiceTable) => {
    if (busyId) return
    if (!table.enabled) {
      // 停用的桌开不了台。有权限的人顺手能启用，没权限的告诉他为什么点不动。
      if (!canToggle) {
        void Taro.showToast({ title: `${table.code} 已停用`, icon: 'none' })
        return
      }
      void Taro.showModal({
        title: `${table.code} 已停用`,
        content: '要重新启用这张桌吗？启用后顾客就能在平面图上预约它。',
        confirmText: '启用',
      }).then((r) => {
        if (r.confirm) toggle(table)
      })
      return
    }
    setOpenId(table.id)
  }

  /** 停用前问一句（2026-10-27 起）：停了这张桌就开不了台、约不了，点错了顾客当场就坐不下。启用不用问。 */
  const disable = (table: ServiceTable) => {
    if (submitting.current || !canToggle) return
    void Taro.showModal({
      title: `停用 ${table.code}？`,
      content: '停用后这张桌开不了台，顾客在平面图上也约不了它。修好了再点「启用」。',
      confirmText: '停用',
      cancelText: '再看看',
    })
      .then((r) => {
        if (r.confirm) toggle(table)
      })
      .catch(() => undefined)
  }

  /** 停用 / 启用 —— 布局固定之后员工端唯一还能改的桌位状态。后端对其余字段一律 400。 */
  const toggle = (table: ServiceTable) => {
    if (submitting.current || !canToggle) return
    submitting.current = true
    setBusyId(table.id)
    setError('')
    void staffApi
      .updateTable(table.id, { enabled: !table.enabled })
      .then(() => data.refresh())
      .catch((e: unknown) => setError(staffMessage(e)))
      .finally(() => {
        submitting.current = false
        setBusyId('')
      })
  }

  return (
    <StaffScreen
      title="桌位"
      loading={data.loading}
      error={data.error}
      stale={data.data !== null}
      onRetry={data.refresh}
      live={live}
      updatedAt={data.updatedAt}
    >
      {error && (
        <View className="inline-error" role="alert">
          {error}
        </View>
      )}

      <View className="tables-filters">
        {FILTERS.map((item) => (
          <Button
            key={item.key}
            className={`tables-filter ${filter === item.key ? 'tables-filter-on' : ''} ${item.key === 'attention' && counts.attention ? 'tables-filter-alert' : ''}`}
            ariaLabel={`${item.label} ${counts[item.key]} 张${filter === item.key ? '，已选中' : ''}`}
            onClick={() => setFilter(item.key)}
          >
            {item.label} {counts[item.key]}
          </Button>
        ))}
      </View>

      {view === 'plan' ? (
        <>
          <View className="tables-plan">
            <Image className="staff-plan-image" src="/assets/seatmap/plan.jpg" mode="widthFix" />
            {planSeats.map((seat) => {
              const table = byCode.get(seat.id)
              const mark = table ? markOf(table) : 'missing'
              const dim = !!table && !matches(table, filter)
              const minutes = table ? minutesOn(table, now) : ''
              return (
                <Button
                  key={seat.id}
                  className={`tables-hit tables-hit-${mark}${dim ? ' tables-hit-dim' : ''}`}
                  style={boxOf(seat)}
                  disabled={!table || dim || !!busyId}
                  ariaLabel={
                    table
                      ? `${seat.id}，${statusText(table, billing)}${minutes && /^\d+$/.test(minutes) ? `，剩 ${minutes} 分钟` : ''}`
                      : `${seat.id}，门店数据里没有这张桌`
                  }
                  onClick={() => table && enter(table)}
                >
                  <Text className="tables-hit-code">{seat.id}</Text>
                  {minutes && <Text className="tables-hit-minutes">{minutes}</Text>}
                </Button>
              )
            })}
          </View>
          <View className="tables-legend">
            {LEGEND.map(([key, label]) => (
              <View className="tables-legend-item" key={key}>
                <View className={`tables-swatch tables-hit-${key}`} />
                <Text>{label}</Text>
              </View>
            ))}
          </View>
        </>
      ) : (
        <View className="table-grid">
          {shown.length === 0 && <Text className="staff-list-meta">没有符合条件的桌位</Text>}
          {shown.map((table) => {
            const mark = markOf(table)
            const z = zoneOf((table.zone || '') as SeatZone)
            const minutes = minutesOn(table, now)
            return (
              <View className="table-tile-wrap" key={table.id}>
                <Button
                  className={`table-tile table-tile-${mark}`}
                  disabled={!!busyId}
                  ariaLabel={`${table.code}，${z?.name || ''}，${statusText(table, billing)}`}
                  onClick={() => enter(table)}
                >
                  <Text className="table-number">{table.code}</Text>
                  <Text className="table-status">
                    {statusText(table, billing)}
                    {minutes && /^\d+$/.test(minutes) ? ` · ${minutes} 分` : ''}
                  </Text>
                  <Text className="table-status">
                    {table.seatCount} 座{table.wholeTable ? ' · 整桌' : ''}
                  </Text>
                </Button>
                {canToggle && (
                  <Button
                    className="table-toggle"
                    loading={busyId === table.id}
                    disabled={!!busyId}
                    onClick={() => (table.enabled ? disable(table) : toggle(table))}
                  >
                    {table.enabled ? '停用' : '启用'}
                  </Button>
                )}
              </View>
            )
          })}
        </View>
      )}

      {alerts.length > 0 && (
        <View className="tables-alerts">
          {alerts.map((alert) => (
            <Button
              key={alert.table.id}
              className="tables-alert"
              ariaLabel={`${alert.table.code}，${alert.text}，查看会话`}
              onClick={() => setOpenId(alert.table.id)}
            >
              <View className={`tables-dot ${alert.overdue ? 'tables-dot-danger' : 'tables-dot-warning'}`} />
              <Text className="tables-alert-text">
                {alert.table.code} {alert.text}
              </Text>
              <Text className="tables-alert-more">查看</Text>
            </Button>
          ))}
        </View>
      )}

      <Button className="tables-view" onClick={() => setView(view === 'plan' ? 'list' : 'plan')}>
        {view === 'plan' ? (canToggle ? '看列表 · 停用或启用桌位' : '看列表') : '看平面图'}
      </Button>

      {opened && <TableSheet table={opened} onClose={() => setOpenId('')} refetchInterval={live.refetchInterval} />}
    </StaffScreen>
  )
}
