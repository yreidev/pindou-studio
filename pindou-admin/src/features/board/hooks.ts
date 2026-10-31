import { useCallback, useEffect, useState } from 'react'

/** 每隔 intervalMs 毫秒换一次的「此刻」，倒数显示用；渲染时不直接读时钟。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** 全屏时在 <html> 上挂的标记：app.css 据此藏起侧栏和顶栏，内容区只留看板。 */
export const fullscreenAttribute = 'data-board-fullscreen'

const browserFullscreen = () =>
  typeof document.documentElement.requestFullscreen === 'function' && document.fullscreenEnabled !== false

/**
 * 看板全屏：整页进浏览器全屏（不是只把看板元素全屏——那样抽屉、弹窗、提示渲染在 body 下面会看不见），
 * 同时藏起后台的侧栏与顶栏。浏览器不支持或拒绝全屏（如部分平板浏览器）时只藏侧栏和顶栏。
 * 离开这一页时退出全屏、恢复侧栏。
 */
export function useBoardFullscreen() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    // 用户按 Esc 退出浏览器全屏时跟着恢复侧栏
    const sync = () => setActive(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    document.documentElement.toggleAttribute(fullscreenAttribute, active)
    return () => document.documentElement.removeAttribute(fullscreenAttribute)
  }, [active])

  const toggle = useCallback(() => {
    if (active) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => setActive(false))
      else setActive(false)
      return
    }
    setActive(true)
    // 浏览器拒绝（被策略禁止等）时仍是「只藏侧栏」
    if (browserFullscreen()) void document.documentElement.requestFullscreen().catch(() => undefined)
  }, [active])

  return { active, toggle }
}
