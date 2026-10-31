import { Image, Text, View } from '@tarojs/components'
import type { PropsWithChildren } from 'react'
import { Button } from '../button'
import cutIcon from './icons/cut.png'
import flipIcon from './icons/flip.png'
import ratioIcon from './icons/ratio.png'
import resetIcon from './icons/reset.png'
import rotateIcon from './icons/rotate.png'
import toneIcon from './icons/tone.png'

// 悬浮工具栏（docs/plan-bead-maker.md「手机上一屏放下」，2026-10-21 业主定）：画布铺满屏幕，工具浮在画布上面。
// 底下一条深色胶囊放工具；点了要调参数的工具，工具栏上方再浮出一块面板，调完收起。
// 画布要避开它们：页面量出它们占了底下多高，传给画布（框、整张图都放在没被挡住的地方）。

const icons = { ratio: ratioIcon, rotate: rotateIcon, flip: flipIcon, tone: toneIcon, cut: cutIcon, reset: resetIcon }
export type FloatIcon = keyof typeof icons

/** 工具栏上的一个工具：图标加两个字。 */
export function FloatTool({
  icon,
  label,
  selected = false,
  onClick,
}: {
  icon: FloatIcon
  label: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <Button
      className={`maker-float-tool ${selected ? 'maker-float-tool-selected' : ''}`}
      ariaLabel={`${label}${selected ? '，已打开' : ''}`}
      onClick={onClick}
    >
      <Image className="maker-float-icon" src={icons[icon]} mode="aspectFit" />
      <Text className="maker-float-label">{label}</Text>
    </Button>
  )
}

/** 工具栏上方浮出的面板：标题、收起，下面放这个工具的选项。 */
export function FloatPanel({ title, onClose, children }: PropsWithChildren<{ title: string; onClose: () => void }>) {
  return (
    <View className="maker-float-panel">
      <View className="maker-float-panel-head">
        <Text className="maker-float-panel-title">{title}</Text>
        <Button className="maker-float-close" ariaLabel={`收起${title}`} onClick={onClose}>
          收起
        </Button>
      </View>
      {children}
    </View>
  )
}
