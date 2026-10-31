import { Banner } from '@douyinfe/semi-ui'
import type { CSSProperties } from 'react'
import type { Order } from '../../api/orders'
import { timingNote } from './timing'

/**
 * 计时会话草稿的计时费说明：后端按发布的规则算好的（超时加收几块、自由计时几块、陪客费），原样显示；
 * 计时明细被员工改过时提醒核对。不是计时会话的草稿什么都不显示。
 */
export function TimingNote({ order, style }: { order: Pick<Order, 'timing'>; style?: CSSProperties }) {
  const note = timingNote(order)
  if (!note) return null
  return (
    <Banner
      type={note.type}
      fullMode={false}
      bordered
      closeIcon={null}
      title={note.title}
      style={style}
      description={
        <div className="checkout-timing">
          {note.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      }
    />
  )
}
