import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { brandName } from '../../../brand'
import { Button } from '../../../components/button'
import { useCustomer } from '../../../hooks/customer'
import { beginLogin, navigateApp } from '../../../services/navigation'
import { beadMillimetres, type BeadSettings } from '../../../services/maker/api'
import { boardsNeeded, finishedSize } from '../../../services/maker/boards'
import { canvasNode, DeviceError, saveCanvas, shareText } from '../../../services/maker/device'
import type { Editor } from '../../../services/maker/edit'
import { toCsv, toFile } from '../../../services/maker/file'
import { beadCounts, colorCounts } from '../../../services/maker/grid'
import { closest, type Palette } from '../../../services/maker/palettes'
import { drawExport, exportLayout, type Ctx } from '../../../services/maker/render'
import type { Draft } from '../../../services/maker/store'

// 用豆清单（画稿 MList）：每种颜色几颗、总颗数、成品多大、要几块底板；色卡是店里那套时标「店里没有」或盒号，
// 有店里没有的颜色时一键换成最接近的；存到相册、发图纸文件和表格；「来店里拼这张」进预约页。

const reserve = '/pages/customer/reservations/index'

type Props = {
  draft: Draft
  editor: Editor
  palette: Palette
  store?: BeadSettings | null
  version: number
  onChange: () => void
}

export const boardChoices = (store?: BeadSettings | null) =>
  [...new Set([29, 52, store?.boardSize ?? 52])].sort((a, b) => a - b)

export function ListTab({ draft, editor, palette, store, version, onChange }: Props) {
  const auth = useCustomer()
  const g = editor.grid
  const [board, setBoard] = useState(store?.boardSize ?? 52)
  const [beadSize, setBeadSize] = useState(store?.beadSize ?? 'mini')
  const [busy, setBusy] = useState(false)
  const counts = useMemo(() => colorCounts(g), [g, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const beads = beadCounts(g).beads
  const mm = beadMillimetres(beadSize)
  const size = finishedSize(g, mm)
  const isStore = !!store && store.palette === palette.id
  const available = isStore && store.available ? new Set(store.available) : undefined
  const missing = available ? counts.filter((c) => !available.has(c.code)) : []
  const replacements = new Map(missing.map((c) => [c.code, closest(palette, c.code, available ?? []) ?? c.code]))

  const exportImage = async () => {
    if (busy) return
    setBusy(true)
    void Taro.showLoading({ title: '正在生成图片' })
    try {
      const L = exportLayout(g, counts.length)
      const node = (await canvasNode('maker-export'))?.node
      if (!node) throw new DeviceError('图片生成不了，请稍后再试')
      node.width = L.width
      node.height = L.height
      const ctx = node.getContext('2d') as Ctx
      const today = new Date()
      drawExport(ctx, g, palette, {
        name: draft.name,
        date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
        storeName: brandName,
        beadMm: mm,
        boardSize: board,
        boxes: isStore ? store?.boxes : undefined,
      })
      await saveCanvas(node)
      void Taro.hideLoading()
      void Taro.showToast({ title: '已存到相册', icon: 'success' })
    } catch (error) {
      void Taro.hideLoading()
      void Taro.showToast({
        title: error instanceof DeviceError ? error.message : '图片生成不了，请稍后再试',
        icon: 'none',
      })
    } finally {
      setBusy(false)
    }
  }

  const send = async (kind: 'file' | 'csv') => {
    try {
      if (kind === 'file')
        await shareText(`${draft.name}.json`, toFile({ name: draft.name, grid: g, done: draft.done }))
      else await shareText(`${draft.name}.csv`, toCsv(g))
    } catch (error) {
      void Taro.showToast({
        title: error instanceof DeviceError ? error.message : '没发出去，请稍后再试',
        icon: 'none',
      })
    }
  }

  return (
    <View className="maker-list">
      <View className="maker-facts">
        <View className="maker-fact">
          <Text className="maker-fact-label">一共</Text>
          <Text className="maker-fact-value">{beads} 颗</Text>
          <Text className="maker-fact-note">{counts.length} 种颜色</Text>
        </View>
        <View className="maker-fact">
          <Text className="maker-fact-label">成品大约</Text>
          <Text className="maker-fact-value">
            {size.width === size.height ? `${size.width} 厘米` : `${size.width}×${size.height}`}
          </Text>
          <Button className="maker-fact-link" onClick={() => setBeadSize((s) => (s === 'mini' ? 'midi' : 'mini'))}>
            {`${mm} 毫米豆 · 换`}
          </Button>
        </View>
        <View className="maker-fact">
          <Text className="maker-fact-label">要底板</Text>
          <Text className="maker-fact-value">{boardsNeeded(g, board)} 块</Text>
          <Button
            className="maker-fact-link"
            onClick={() => {
              const choices = boardChoices(store)
              setBoard(choices[(choices.indexOf(board) + 1) % choices.length])
            }}
          >
            {`${board} 格板 · 换`}
          </Button>
        </View>
      </View>
      {missing.length > 0 && (
        <View className="maker-banner">
          <Text className="maker-banner-text">
            {`有 ${missing.length} 种颜色店里没有：${missing.map((c) => c.code).join('、')}。换成店里有的、最接近的${
              missing.length === 1 ? ` ${replacements.get(missing[0].code)}` : ''
            }？`}
          </Text>
          <Button
            className="maker-action maker-action-primary"
            onClick={() => {
              const n = editor.recolor(replacements)
              onChange()
              void Taro.showToast({ title: `换了 ${n} 颗`, icon: 'none' })
            }}
          >
            换
          </Button>
        </View>
      )}
      <View className="maker-field-head">
        <Text className="maker-strong">要用的豆子</Text>
        <Text className="maker-note">
          {palette.name}
          {isStore ? ' · 店里用的这套' : ''}
        </Text>
      </View>
      <View className="maker-bead-list">
        {counts.map((c) => {
          const hex = palette.colors[palette.index.get(c.code) ?? 0].hex
          const box = isStore ? store?.boxes?.[c.code] : undefined
          return (
            <View key={c.code} className="maker-bead-row">
              <View className="maker-bead-swatch" style={{ background: hex }} />
              <Text className="maker-bead-code">{c.code}</Text>
              <Text className="maker-bead-count">{c.count} 颗</Text>
              {available && !available.has(c.code) ? (
                <Text className="maker-bead-store maker-bead-missing">店里没有</Text>
              ) : box ? (
                <Text className="maker-bead-store">{box} 号盒</Text>
              ) : null}
            </View>
          )
        })}
      </View>
      <Text className="maker-note">
        屏幕上的颜色和真豆子会有偏差，以实物为准。{isStore ? '盒号是店里豆子盒上的编号。' : ''}
      </Text>
      <View className="maker-row-actions">
        <Button className="maker-action" onClick={() => void send('file')}>
          发图纸文件
        </Button>
        <Button className="maker-action" onClick={() => void send('csv')}>
          发表格
        </Button>
      </View>
      <View className="maker-bottom maker-bottom-pair">
        <Button className="button button-outline" disabled={busy} onClick={() => void exportImage()}>
          存到相册
        </Button>
        <Button
          className="button button-primary"
          onClick={() => {
            if (auth.status === 'authenticated') void navigateApp(reserve)
            else void beginLogin(reserve)
          }}
        >
          来店里拼这张
        </Button>
      </View>
    </View>
  )
}
