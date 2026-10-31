import { IconFullScreenStroked, IconRefresh, IconShrinkScreenStroked } from '@douyinfe/semi-icons'
import { Button, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { useMemo, useState } from 'react'
import type { BoardData } from '../../api/board'
import { clockTime } from '../../lib/format'
import type { RealtimeStatus } from '../../realtime/connection'
import { boardSeats, openable, refetchInterval, startable, type BoardSeat } from './board'
import { BoardMap } from './BoardMap'
import { ServiceCallsPanel } from '../service-calls/ServiceCallsPanel'
import { AdmissionsPanel, ArrivalsPanel, panelBody, panelHeader, RemindersPanel } from './BoardPanels'
import { OpenSheet } from './OpenSheet'
import { SessionSheet } from './SessionSheet'
import './board.css'

/** 抽屉对应的座位，和抽屉是不是开着。关的时候记下关那一刻的座位：关闭动画期间内容照旧，不变空、也不跟着重读变。 */
interface SheetTarget {
  code: string
  visible: boolean
  closing?: BoardSeat | null
}

/**
 * 看板主体：左边平面图，右边侧栏。点有人的座位开会话详情（含换桌换座、陪客、撤销误开），点空闲的座位开台（整桌开台），停用的只提示。
 * 侧栏按紧急程度排：呼叫店员、待确认入座（顾客坐着等开始）、快到点与超时、即将到店的预约。
 * 屏幕够宽时并排，窄了侧栏落到图下面。
 */
export function Board({ data, now, fetchedAt }: { data: BoardData; now: number; fetchedAt: number }) {
  // 抽屉开着的是哪个座位。关的时候只把 visible 关掉、座位留着，关闭动画里内容不变空；动画结束再清掉
  const [detail, setDetail] = useState<SheetTarget | null>(null)
  const [opening, setOpening] = useState<SheetTarget | null>(null)
  const seats = useMemo(() => boardSeats(data, now), [data, now])
  const tables = useMemo(() => new Map(data.tables.map((table) => [table.id, table])), [data.tables])
  // 详情、开台面板开着时跟着最新数据走：每次重读后按编码重新取这个座位
  const seatOf = (target: SheetTarget | null) =>
    target
      ? target.visible
        ? (seats.find((seat) => seat.code === target.code) ?? null)
        : (target.closing ?? null)
      : null
  const open = seatOf(detail)
  const start = seatOf(opening)
  const onOpen = (seat: { code: string }) => setDetail({ code: seat.code, visible: true })
  const onSelect = (seat: BoardSeat) => {
    if (openable(seat)) setDetail({ code: seat.code, visible: true })
    else if (startable(seat)) setOpening({ code: seat.code, visible: true })
    else if (seat.state === 'off') Toast.warning(`${seat.code} 已停用，不能开台（启用、停用在小程序桌位页）`)
  }
  const hide = (current: BoardSeat | null) => (target: SheetTarget | null) =>
    target ? { ...target, visible: false, closing: current } : null
  // 关闭动画结束才清掉；动画期间又点开了（visible 又是 true）就留着
  const forget = (target: SheetTarget | null) => (target?.visible ? target : null)

  return (
    <div className="board-body">
      <BoardMap seats={seats} now={now} fetchedAt={fetchedAt} onSelect={onSelect} />
      <div className="board-side">
        <ServiceCallsPanel className="board-panel" headerStyle={panelHeader} bodyStyle={panelBody} />
        <AdmissionsPanel admissions={data.admissions} tables={tables} />
        <RemindersPanel seats={seats} now={now} fetchedAt={fetchedAt} onOpen={onOpen} />
        <ArrivalsPanel reservations={data.reservations} packages={data.packages} tables={tables} now={now} />
      </div>
      <SessionSheet
        seat={open}
        data={data}
        visible={Boolean(detail?.visible && open)}
        now={now}
        fetchedAt={fetchedAt}
        onClose={() => setDetail(hide(open))}
        afterClose={() => setDetail(forget)}
      />
      <OpenSheet
        seat={start}
        visible={Boolean(opening?.visible && start)}
        packages={data.packages}
        closeMinute={data.closeMinute}
        reservations={data.reservations}
        now={now}
        onClose={() => setOpening(hide(start))}
        afterClose={() => setOpening(forget)}
      />
    </div>
  )
}

/** 页头右侧：实时连接状态、最近一次读到的时间、刷新、全屏。 */
export function BoardToolbar({
  status,
  updatedAt,
  refreshing,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
}: {
  status: RealtimeStatus
  updatedAt: number
  refreshing: boolean
  onRefresh: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
}) {
  return (
    <span className="board-status">
      <Tag color={status === 'open' ? 'green' : status === 'connecting' ? 'grey' : 'red'} size="large">
        {status === 'open' ? '实时 · 已连接' : status === 'connecting' ? '实时 · 正在连接' : '实时 · 已断开'}
      </Tag>
      <Typography.Text type="tertiary" size="small">
        {updatedAt ? `更新于 ${clockTime(updatedAt)}` : ''}
        {status === 'open' ? '' : ` · 每 ${refetchInterval(status) / 1000} 秒重读`}
      </Typography.Text>
      <Button icon={<IconRefresh />} loading={refreshing} onClick={onRefresh}>
        刷新
      </Button>
      <Button icon={fullscreen ? <IconShrinkScreenStroked /> : <IconFullScreenStroked />} onClick={onToggleFullscreen}>
        {fullscreen ? '退出全屏' : '全屏'}
      </Button>
    </span>
  )
}
