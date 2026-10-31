import { Typography } from '@douyinfe/semi-ui'
import type { CSSProperties } from 'react'
import planImage from '../../../../pindou-miniapp/src/assets/seatmap/plan.jpg'
import { clockTime } from '../../lib/format'
import {
  openable,
  remainingSeconds,
  startable,
  seatShortText,
  seatStateNames,
  seatStateOrder,
  stateCounts,
  timingText,
  type BoardSeat,
} from './board'
import { boxOf, planSize } from './layout'

// 底图与小程序同一张（见 layout.ts）。打包后是 assets/plan-<哈希>.jpg，和页面同源。

/** 预约开始的「时:分」（门店时区）。 */
const bookingClock = (seat: BoardSeat) => (seat.booking ? clockTime(seat.booking.reservation.startAt).slice(0, 5) : '')

/** 读屏与悬停说明：「A3，使用中，剩余 12 分钟，14:30 有预约」。 */
function seatLabel(seat: BoardSeat, seconds: number | null): string {
  const parts = [seat.code, seatStateNames[seat.state]]
  const timing = timingText(seat, seconds)
  if (timing !== seatStateNames[seat.state] && seat.state !== 'free' && seat.state !== 'off') parts.push(timing)
  if (seat.booking) parts.push(`${bookingClock(seat)} 有预约`)
  return parts.join('，')
}

/**
 * 平面图：底图上按百分比摆座位热区，颜色表示状态，下方是图例与计数。
 * 有人用的座位（含暂停、待结账）点开会话详情，空闲的点开开台，停用的点了只提示不能开台（由 onSelect 决定）；
 * 有人用但还没读到会话的（两次重读之间）先只看。
 */
export function BoardMap({
  seats,
  now,
  fetchedAt,
  onSelect,
}: {
  seats: BoardSeat[]
  now: number
  fetchedAt: number
  onSelect: (seat: BoardSeat) => void
}) {
  const counts = stateCounts(seats)
  return (
    <div className="board-map" style={{ '--plan-ratio': planSize.width / planSize.height } as CSSProperties}>
      <div className="board-plan" style={{ aspectRatio: `${planSize.width} / ${planSize.height}` }}>
        <img className="board-plan-image" src={planImage} alt="门店平面图" draggable={false} />
        {seats.map((seat) => {
          const seconds = remainingSeconds(seat, now, fetchedAt)
          const label = seatLabel(seat, seconds)
          const content = (
            <>
              <span className="board-seat-code">{seat.code}</span>
              <span className="board-seat-status">{seatShortText(seat, seconds)}</span>
              {seat.booking ? (
                <span className="board-seat-booking" aria-hidden="true">
                  约{bookingClock(seat)}
                </span>
              ) : null}
            </>
          )
          const className = `board-seat board-state-${seat.state}`
          return openable(seat) || startable(seat) || seat.state === 'off' ? (
            <button
              key={seat.code}
              type="button"
              className={className}
              style={boxOf(seat)}
              aria-label={label}
              title={label}
              data-seat={seat.code}
              data-state={seat.state}
              onClick={() => onSelect(seat)}
            >
              {content}
            </button>
          ) : (
            <div
              key={seat.code}
              role="img"
              className={className}
              style={boxOf(seat)}
              aria-label={label}
              title={label}
              data-seat={seat.code}
              data-state={seat.state}
            >
              {content}
            </div>
          )
        })}
      </div>
      <div className="board-legend">
        {seatStateOrder.map((state) => (
          <span key={state} className="board-legend-item">
            <span className={`board-swatch board-state-${state}`} />
            <Typography.Text size="small">
              {seatStateNames[state]} {counts[state]}
            </Typography.Text>
          </span>
        ))}
        <span className="board-legend-item">
          <span className="board-seat-booking board-legend-booking">约</span>
          <Typography.Text size="small">30 分钟内到店的预约</Typography.Text>
        </span>
      </div>
    </div>
  )
}
