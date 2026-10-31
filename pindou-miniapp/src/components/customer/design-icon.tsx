import { View } from '@tarojs/components'
import './design-icon.scss'

export function DesignIcon({ name, className = '' }: { name: string; className?: string }) {
  return <View className={`design-icon design-icon-${name} ${className}`} aria-hidden />
}
