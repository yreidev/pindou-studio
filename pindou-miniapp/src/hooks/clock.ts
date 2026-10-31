import { useEffect, useState } from 'react'

/**
 * 现在的时间，每隔 intervalMs 更新一次（0 不更新）：只给「N 分钟前」「还要等几秒」这类两次刷新之间的倒数显示用，
 * 业务状态（过没过期、能不能再叫）仍以接口为准。
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!intervalMs) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
