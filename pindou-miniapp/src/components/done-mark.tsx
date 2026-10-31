import { View } from '@tarojs/components'

// 完成时画出来的勾（docs/plan-interaction.md 第 3 节）：圆先弹出来，勾的短笔、长笔依次画出，约 0.5 秒。
// 小程序里不能在页面上直接写 SVG 描线，两笔是两段横条从 0 拉长。样式在 app.scss「完成的勾」。

/** small：放在步骤圆点的位置（14 像素） */
export function DoneMark({ small = false, className = '' }: { small?: boolean; className?: string }) {
  return (
    <View className={`done-mark ${small ? 'done-mark-small' : ''} ${className}`}>
      <View className="done-mark-short" />
      <View className="done-mark-long" />
    </View>
  )
}
