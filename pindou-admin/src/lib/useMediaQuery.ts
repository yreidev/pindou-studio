import { useSyncExternalStore } from 'react'

/** 屏幕宽度等媒体条件，窗口缩放、平板转屏时跟着变。 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  )
}

/** 手机宽度：侧栏收进抽屉，顶栏精简。 */
export const phoneQuery = '(max-width: 767px)'
