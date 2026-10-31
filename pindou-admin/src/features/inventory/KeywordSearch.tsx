import { IconSearch } from '@douyinfe/semi-icons'
import { Input } from '@douyinfe/semi-ui'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import { useState } from 'react'

/** 搜索框：边打边筛，停手 300 毫秒后才写进网址参数，不每个字都改一次网址。 */
export function KeywordSearch({
  value,
  placeholder,
  onSearch,
}: {
  value: string | undefined
  placeholder: string
  onSearch: (keyword: string | undefined) => void
}) {
  const [text, setText] = useState(value ?? '')
  const search = useDebouncedCallback((next: string) => onSearch(next.trim() || undefined), { wait: 300 })
  return (
    <Input
      prefix={<IconSearch />}
      showClear
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      style={{ width: 280 }}
      onChange={(next) => {
        setText(next)
        search(next)
      }}
    />
  )
}
