import { View, type ITouchEvent } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react'
import { Button } from './button'
import { resist, shouldDismiss, velocityTracker } from '../services/gesture'

// 底部弹层的外壳（docs/plan-interaction.md 第 2 节）：从底下升起，关的时候滑下去、遮罩渐隐，完了再从页面上拿掉。
// 按住把手或标题行往下拖，面板跟着手指走；松手拖过三分之一或往下一甩就关，不够就弹回，不停在半路。
// 只有把手和标题行能拖，面板里的列表照常滚。正在提交（locked）时拖不动、点遮罩不关。
// 弹层里填了字（dirty）时点遮罩也不关，免得误碰把填的内容丢了；点关闭、往下拖是有意的，照常关（2026-10-28 业主定）。
// 样子还是各自的（mask、panel 传各自的类名），这里只管开关和拖动；动画的样式在 app.scss「底部弹层」。
// 弹层里的业务做完、由页面直接把弹层拿掉的，照旧立刻消失：动画只在点遮罩、点关闭、拖下去时有。

const LEAVE_MS = 240
let serial = 0

const SheetClose = createContext<() => void>(() => undefined)

/** 弹层里的关闭按钮：先滑下去再关。 */
export function SheetCloseButton({
  className,
  ariaLabel = '关闭',
  disabled,
  children,
}: PropsWithChildren<{ className: string; ariaLabel?: string; disabled?: boolean }>) {
  const close = useContext(SheetClose)
  return (
    <Button className={className} ariaLabel={ariaLabel} disabled={disabled} onClick={close}>
      {children}
    </Button>
  )
}

/** 触点的纵坐标：View 的触摸事件在 Taro 的类型里没带 touches */
const touchY = (event: unknown) => (event as ITouchEvent).touches[0]?.clientY ?? 0

export function SheetFrame({
  mask,
  panel,
  handle = 'sheet-handle',
  label,
  locked = false,
  dirty = false,
  onClose,
  head,
  catchMove = false,
  children,
}: PropsWithChildren<{
  /** 遮罩的类名 */
  mask: string
  /** 面板的类名 */
  panel: string
  /** 把手的类名 */
  handle?: string
  /** 读屏念的弹层名字 */
  label?: string
  locked?: boolean
  /** 弹层里填了字：点遮罩不关，只能点关闭或往下拖 */
  dirty?: boolean
  onClose: () => void
  /** 标题行：和把手一起是能拖的地方 */
  head: ReactNode
  /** 遮罩挡住手指滑动（面板里只有 ScrollView 要滚时用）；不挡时面板里普通的长内容才滚得动 */
  catchMove?: boolean
}>) {
  const id = useRef(`sheet-${++serial}`).current
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const drag = useRef({ active: false, y0: 0, height: 0, tracker: velocityTracker() })
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const latest = useRef({ onClose, locked, dirty })
  latest.current = { onClose, locked, dirty }
  useEffect(() => () => clearTimeout(timer.current), [])

  const close = () => {
    if (latest.current.locked || timer.current) return
    setDragging(false)
    setLeaving(true)
    timer.current = setTimeout(() => latest.current.onClose(), LEAVE_MS)
  }

  const start = (event: unknown) => {
    if (locked || leaving) return
    const y = touchY(event)
    drag.current = { active: true, y0: y - offset, height: drag.current.height, tracker: velocityTracker() }
    drag.current.tracker.push(Date.now(), 0, y)
    setDragging(true)
    // 量面板多高：拖过三分之一才关
    Taro.createSelectorQuery()
      .select(`#${id}`)
      .boundingClientRect((rect) => {
        const box = Array.isArray(rect) ? rect[0] : rect
        if (box?.height) drag.current.height = box.height
      })
      .exec()
  }
  const move = (event: unknown) => {
    const d = drag.current
    if (!d.active) return
    const y = touchY(event)
    d.tracker.push(Date.now(), 0, y)
    const dy = y - d.y0
    setOffset(dy >= 0 ? dy : resist(dy))
  }
  const end = () => {
    const d = drag.current
    if (!d.active) return
    d.active = false
    setDragging(false)
    if (shouldDismiss(offset, d.height || 320, d.tracker.get()[1])) close()
    else setOffset(0)
  }

  return (
    <SheetClose.Provider value={close}>
      <View
        className={`${mask} sheet-motion-mask ${leaving ? 'sheet-motion-leaving' : ''}`}
        onClick={() => {
          if (!latest.current.dirty) close()
        }}
        catchMove={catchMove}
      >
        <View
          id={id}
          className={`${panel} sheet-motion-panel ${dragging ? 'sheet-motion-dragging' : ''}`}
          style={{ transform: leaving ? 'translateY(102%)' : `translateY(${offset}px)` }}
          role="dialog"
          ariaLabel={label}
          onClick={(event) => event.stopPropagation()}
        >
          {/* 拖把手时页面不跟着滚 */}
          <View
            className="sheet-drag"
            catchMove
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
            onTouchCancel={end}
          >
            <View className={handle} />
            {head}
          </View>
          {children}
        </View>
      </View>
    </SheetClose.Provider>
  )
}
