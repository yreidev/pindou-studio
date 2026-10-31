import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'

// Keep this boundary aligned with styles/_tokens.scss ($staff-wide).
export const STAFF_WIDE = 1024
export const isWideWindow = (width: number) => Number.isFinite(width) && width >= STAFF_WIDE

export function useWideLayout() {
  const read = () => {
    try {
      return isWideWindow(Taro.getWindowInfo().windowWidth)
    } catch {
      return false
    }
  }
  const [wide, setWide] = useState(read)
  useEffect(() => {
    const resize = () => setWide(read())
    Taro.onWindowResize(resize)
    setWide(read())
    return () => Taro.offWindowResize(resize)
  }, [])
  return wide
}
