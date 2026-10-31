import { useEffect, useRef, useState } from 'react'
import { Image, MovableArea, MovableView, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { Button } from './button'
import { useCustomer } from '../hooks/customer'
import { developerModeNames, switchExperienceRole } from '../services/developer-switch'
import roleIcon from '../assets/staff/profile-active.png'

// 默认停在活动区右下角。bounds() 已经把底栏那 80PX 扣掉，y=1 正好落在底栏上方，
// 不压着页面正中的内容（0.65 那会儿压住过首页的服务卡、订单状态标、开台的时长按钮）。
let savedPosition = { x: 1, y: 1 }
const size = 56

function bounds() {
  try {
    const info = Taro.getWindowInfo()
    const top = (info.statusBarHeight ?? 20) + 72
    const bottom = Math.max(0, info.screenHeight - (info.safeArea?.bottom ?? info.screenHeight)) + 80
    return {
      top,
      width: Math.max(size, info.windowWidth - 24),
      height: Math.max(size, info.windowHeight - top - bottom),
    }
  } catch {
    return { top: 92, width: 351, height: 440 }
  }
}

export function DeveloperStatus() {
  const auth = useCustomer()
  const mode = auth.account?.developerMode
  const [area, setArea] = useState(bounds)
  const [position, setPosition] = useState(savedPosition)
  const moved = useRef(false)
  const start = useRef({ x: 0, y: 0 })
  const dragStart = useRef({ x: 0, y: 0 })
  const sync = () => {
    setArea(bounds())
    setPosition({ ...savedPosition })
  }
  useDidShow(sync)
  useEffect(() => {
    Taro.onWindowResize(sync)
    return () => Taro.offWindowResize(sync)
  }, [])
  if (!mode) return null
  return (
    <MovableArea
      className="developer-float-area"
      style={{ top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` }}
    >
      <MovableView
        className="developer-float"
        direction="all"
        inertia={false}
        animation={false}
        outOfBounds={false}
        x={position.x * (area.width - size)}
        y={position.y * (area.height - size)}
        onChange={(event) => {
          if (event.detail.source !== 'touch') return
          if (Math.hypot(event.detail.x - dragStart.current.x, event.detail.y - dragStart.current.y) > 6)
            moved.current = true
          savedPosition = {
            x: Math.max(0, Math.min(1, event.detail.x / Math.max(1, area.width - size))),
            y: Math.max(0, Math.min(1, event.detail.y / Math.max(1, area.height - size))),
          }
        }}
      >
        <Button
          className="developer-float-button"
          ariaLabel={`切换身份，当前${developerModeNames[mode]}`}
          onTouchStart={(event) => {
            moved.current = false
            dragStart.current = { x: savedPosition.x * (area.width - size), y: savedPosition.y * (area.height - size) }
            const touch = event.touches[0]
            if (touch) start.current = { x: touch.clientX, y: touch.clientY }
          }}
          onTouchMove={(event) => {
            const touch = event.touches[0]
            if (touch && Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) > 6)
              moved.current = true
          }}
          onTouchCancel={() => {
            moved.current = true
          }}
          onClick={() => {
            if (!moved.current) void switchExperienceRole()
          }}
        >
          <Image className="developer-float-icon" src={roleIcon} mode="aspectFit" />
          <Text className="developer-float-label">{mode === 'developer' ? '切换' : developerModeNames[mode]}</Text>
        </Button>
      </MovableView>
    </MovableArea>
  )
}
