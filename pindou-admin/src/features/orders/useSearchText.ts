import { useDebouncedValue } from '@tanstack/react-pacer'
import { useEffect, useEffectEvent, useState } from 'react'

/**
 * 搜索框和网址参数之间的防抖：输入框立刻跟手，停手一会儿才把搜索词写进网址（列表按网址筛选）。
 * 网址被外部改了（点侧栏回到列表、浏览器后退）时输入框跟着变；是自己刚写进去的就不动，免得吞掉正在打的字。
 */
export function useSearchText(committed: string, commit: (value: string) => void, wait = 300) {
  const [text, setText] = useState(committed)
  const [debounced] = useDebouncedValue(text, { wait })
  const [seen, setSeen] = useState(committed)
  if (committed !== seen) {
    setSeen(committed)
    if (committed !== debounced.trim()) setText(committed)
  }
  const push = useEffectEvent((value: string) => {
    if (value !== committed) commit(value)
  })
  useEffect(() => {
    push(debounced.trim())
  }, [debounced])
  return [text, setText] as const
}
