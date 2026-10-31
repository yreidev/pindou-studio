import { Text, View } from '@tarojs/components'
import { Button } from './button'

const pageSize = 20
export function pageSlice<T>(items: T[], page: number): T[] {
  const current = Math.max(0, Math.min(page, Math.ceil(items.length / pageSize) - 1))
  return items.slice(current * pageSize, (current + 1) * pageSize)
}
export function PageControls({
  page,
  total,
  onChange,
  disabled = false,
}: {
  page: number
  total: number
  onChange: (page: number) => void
  disabled?: boolean
}) {
  const pages = Math.ceil(total / pageSize),
    current = Math.max(0, Math.min(page, pages - 1))
  if (pages <= 1) return null
  return (
    <View className="page-controls">
      <Button className="text-button" disabled={disabled || current === 0} onClick={() => onChange(current - 1)}>
        上一页
      </Button>
      <Text className="muted">
        第 {current + 1} / {pages} 页 · 共 {total} 条
      </Text>
      <Button className="text-button" disabled={disabled || current + 1 >= pages} onClick={() => onChange(current + 1)}>
        下一页
      </Button>
    </View>
  )
}
