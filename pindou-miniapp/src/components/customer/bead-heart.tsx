import { View } from '@tarojs/components'
import './bead-heart.scss'

export function BeadHeart() {
  return (
    <View className="bead-heart" aria-hidden>
      <View className="bead-heart-art" />
    </View>
  )
}
