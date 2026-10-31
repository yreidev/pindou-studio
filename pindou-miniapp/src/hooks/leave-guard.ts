import { useEffect, useRef } from 'react'
import { useDidHide, useDidShow, useRouter } from '@tarojs/taro'
import { registerLeaveGuard } from '../services/navigation'

export function useLeaveGuard(dirty: boolean, busy = false) {
  const { path } = useRouter()
  const state = useRef({ dirty, busy })
  state.current = { dirty, busy }
  const cleanup = useRef<() => void>(() => {})
  const attach = () => {
    cleanup.current()
    cleanup.current = registerLeaveGuard('/' + path.replace(/^\//, ''), () => state.current)
  }
  useEffect(() => {
    attach()
    return () => cleanup.current()
    // 只随页面路径重新登记；attach 每次渲染都是新函数，但它只读 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])
  useDidShow(attach)
  useDidHide(() => cleanup.current())
}
