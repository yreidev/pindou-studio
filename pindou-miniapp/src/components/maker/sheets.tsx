import { ScrollView, Text, View } from '@tarojs/components'
import { useMemo, useState, type PropsWithChildren, type ReactNode } from 'react'
import { Button } from '../button'
import { SheetCloseButton, SheetFrame } from '../sheet'
import { palette as paletteOf, paletteGroups, type Palette } from '../../services/maker/palettes'

// 做图纸的底部弹层：选色卡（国内 6 套、国外 11 套，按牌子分组）、选颜色（这套色卡的全部颜色，可以搜色号）。

export function Sheet({
  title,
  note,
  onClose,
  footer,
  light,
  children,
}: PropsWithChildren<{
  title: string
  note?: string
  onClose: () => void
  footer?: ReactNode
  /** 遮罩很浅：改的东西要边改边看上面的预览（「更多设置」） */
  light?: boolean
}>) {
  return (
    <SheetFrame
      mask={`maker-sheet-mask ${light ? 'maker-sheet-mask-light' : ''}`}
      panel="maker-sheet"
      label={title}
      onClose={onClose}
      catchMove
      head={
        <View className="maker-sheet-head">
          <View className="maker-sheet-heading">
            <Text className="maker-sheet-title">{title}</Text>
            {!!note && <Text className="maker-sheet-note">{note}</Text>}
          </View>
          <SheetCloseButton className="maker-sheet-close">×</SheetCloseButton>
        </View>
      }
    >
      {/* 没有底栏时最下面留出手机底部的安全区 */}
      <ScrollView scrollY className={`maker-sheet-body ${footer ? '' : 'maker-sheet-body-last'}`}>
        {children}
      </ScrollView>
      {footer && <View className="maker-sheet-footer">{footer}</View>}
    </SheetFrame>
  )
}

/** 选色卡。storePalette 是店里用的那套（标「店里用的」）。 */
export function PaletteSheet({
  current,
  storePalette,
  onPick,
  onClose,
}: {
  current: string
  storePalette?: string
  onPick: (id: string) => void
  onClose: () => void
}) {
  return (
    <Sheet title="选色卡" note="按手上的豆子选。颜色是屏幕上的近似，和实物会有偏差。" onClose={onClose}>
      {paletteGroups().map((group) => (
        <View key={group.region} className="maker-palette-group">
          <Text className="maker-sheet-label">{group.region === 'cn' ? '国内' : '国外'}</Text>
          {group.brands.map((brand) => (
            <View key={brand.brand} className="maker-palette-brand">
              <Text className="maker-palette-brand-name">{brand.brand}</Text>
              <View className="maker-palette-options">
                {brand.palettes.map((p) => (
                  <Button
                    key={p.id}
                    className={`maker-chip ${p.id === current ? 'maker-chip-selected' : ''}`}
                    onClick={() => onPick(p.id)}
                  >
                    {`${p.name.replace(brand.brand, '').trim() || p.name}${p.id === storePalette ? ' · 店里用的' : ''}`}
                  </Button>
                ))}
              </View>
            </View>
          ))}
        </View>
      ))}
    </Sheet>
  )
}

/** 选颜色：这套色卡的全部颜色，店里没有的标出来；能按色号搜。 */
export function ColorSheet({
  paletteId,
  title = '选颜色',
  current,
  available,
  onPick,
  onClose,
}: {
  paletteId: string
  title?: string
  current?: string | null
  /** 店里有的色号（色卡是店里那套时才给） */
  available?: ReadonlySet<string>
  onPick: (code: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const p = paletteOf(paletteId) as Palette
  const colors = useMemo(
    () => p.colors.filter((c) => !query || c.code.toLowerCase().startsWith(query.trim().toLowerCase())),
    [p, query],
  )
  const prefixes = useMemo(
    () => [...new Set(p.colors.map((c) => c.code.replace(/[0-9-].*$/, '') || c.code.slice(0, 2)))],
    [p],
  )
  return (
    <Sheet title={title} note={`${p.name} · ${p.colors.length} 色`} onClose={onClose}>
      {prefixes.length > 1 && prefixes.length <= 30 && (
        <View className="maker-palette-options maker-color-prefixes">
          <Button className={`maker-chip ${!query ? 'maker-chip-selected' : ''}`} onClick={() => setQuery('')}>
            全部
          </Button>
          {prefixes.map((prefix) => (
            <Button
              key={prefix}
              className={`maker-chip ${query === prefix ? 'maker-chip-selected' : ''}`}
              onClick={() => setQuery(prefix)}
            >
              {prefix}
            </Button>
          ))}
        </View>
      )}
      <View className="maker-color-grid">
        {colors.map((c) => (
          <Button
            key={c.code}
            className={`maker-color ${c.code === current ? 'maker-color-selected' : ''}`}
            ariaLabel={`${c.code}${available && !available.has(c.code) ? '，店里没有' : ''}`}
            onClick={() => onPick(c.code)}
          >
            <View className="maker-color-swatch" style={{ background: c.hex }} />
            <Text className="maker-color-code">{c.code}</Text>
            {available && !available.has(c.code) && <Text className="maker-color-missing">店里没有</Text>}
          </Button>
        ))}
      </View>
    </Sheet>
  )
}

/** 加减步进器：「− 15 +」。 */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  label: string
}) {
  return (
    <View className="maker-stepper">
      <Button
        className="maker-stepper-button"
        ariaLabel={`${label}减少`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </Button>
      <Text className="maker-stepper-value">{value}</Text>
      <Button
        className="maker-stepper-button"
        ariaLabel={`${label}增加`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </Button>
    </View>
  )
}
