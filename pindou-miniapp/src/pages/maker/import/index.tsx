import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { Screen } from '../../../components/customer'
import { MakerCanvas, type DrawContext, type Point, type TouchKind } from '../../../components/maker/canvas'
import { PaletteSheet, Stepper } from '../../../components/maker/sheets'
import { fitShown, putShown, type Shown } from '../../../components/maker/shown'
import { usePublicQuery } from '../../../hooks/query'
import { navigateApp } from '../../../services/navigation'
import { beadApi } from '../../../services/maker/api'
import { choosePhoto, DeviceError, readPixels } from '../../../services/maker/device'
import { makerPages } from '../../../services/maker/flow'
import { blankDone, MAX_SIDE, MIN_SIDE, newId, type Grid } from '../../../services/maker/grid'
import type { Pixels } from '../../../services/maker/image'
import { detect, readCells, type Detected } from '../../../services/maker/importer'
import { palette as paletteOf } from '../../../services/maker/palettes'
import { rememberedPalette, rememberPalette, session } from '../../../services/maker/session'
import { deviceStorage, saveLocal, type Draft } from '../../../services/maker/store'
import './index.scss'

// 导入像素画、图纸截图（画稿 MImport）：认出格子以后一格一颗原样导入，不重新缩小取色。
// 金色线是认出来的格子；格数不对就加减，对不齐就拖左上、右下两个角。格子按正方形算，行数跟着宽和格数走。

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** 截图不缩到照片那么小：格子细的截图缩小以后格线会糊 */
const IMPORT_SIDE = 2400

const rowsOf = (d: Pick<Detected, 'w' | 'h' | 'cols'>) => clamp(Math.round(d.h / (d.w / d.cols)), MIN_SIDE, MAX_SIDE)

export default function MakerImport() {
  const store = usePublicQuery(['bead-settings'], beadApi.settings, { once: true }).data
  const [img, setImg] = useState<Pixels>()
  const [found, setFound] = useState<Detected>()
  const [paletteId, setPaletteId] = useState(() => rememberedPalette())
  const [choosing, setChoosing] = useState(false)
  const [grid, setGrid] = useState<Grid>()
  const size = useRef({ width: 0, height: 0, ratio: 1 })
  const [measured, setMeasured] = useState(0)
  const handle = useRef<() => void>()
  const drag = useRef<{ corner?: 0 | 1; start?: Point; from?: Detected }>({})
  const pal = paletteOf(paletteId)

  useEffect(() => {
    if (store) setPaletteId(rememberedPalette(store.palette))
  }, [store])

  const pick = async () => {
    let path: string | undefined
    try {
      path = await choosePhoto()
    } catch (error) {
      void Taro.showToast({ title: error instanceof DeviceError ? error.message : '图片打不开', icon: 'none' })
      return
    }
    if (!path) return
    void Taro.showLoading({ title: '正在认格子' })
    try {
      const pixels = await readPixels(path, IMPORT_SIDE)
      const d = detect(pixels)
      setImg(pixels)
      setFound({ ...d, rows: rowsOf(d) })
    } catch (error) {
      void Taro.showToast({ title: error instanceof DeviceError ? error.message : '图片读不出来', icon: 'none' })
    } finally {
      void Taro.hideLoading()
    }
  }

  // 格子、色卡变了：停手 300 毫秒重新读一次（好显示几种颜色）
  useEffect(() => {
    if (!img || !found || !pal) return
    const timer = setTimeout(() => setGrid(readCells(img, found, pal)), 300)
    return () => clearTimeout(timer)
  }, [img, found, pal])

  const shown = useMemo<Shown | undefined>(() => {
    const { width, height, ratio } = size.current
    return img && width ? fitShown(img, width, height, ratio) : undefined
  }, [img, measured]) // eslint-disable-line react-hooks/exhaustive-deps

  const draw = (ctx: DrawContext, width: number, height: number, ratio: number) => {
    if (!shown || !found || !img) {
      ctx.fillStyle = '#f1eadc'
      ctx.fillRect(0, 0, width, height)
      return
    }
    putShown(ctx, shown, ratio, '#f7f5f0', width, height)
    const k = shown.w / img.width
    const x = shown.x + found.x * k,
      y = shown.y + found.y * k,
      w = found.w * k,
      h = found.h * k
    const cw = w / found.cols,
      ch = h / found.rows
    ctx.strokeStyle = 'rgba(180, 151, 99, 0.85)'
    ctx.lineWidth = cw < 4 ? 0.5 : 1
    ctx.beginPath()
    // 格子太细时只画每 5 格一条，免得整片发黄
    const every = cw < 3 ? 5 : 1
    for (let c = 0; c <= found.cols; c += every) {
      ctx.moveTo(x + c * cw, y)
      ctx.lineTo(x + c * cw, y + h)
    }
    for (let r = 0; r <= found.rows; r += every) {
      ctx.moveTo(x, y + r * ch)
      ctx.lineTo(x + w, y + r * ch)
    }
    ctx.stroke()
    ctx.strokeStyle = '#b49763'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.stroke()
    ctx.fillStyle = '#b49763'
    ctx.fillRect(x - 7, y - 7, 14, 14)
    ctx.fillRect(x + w - 7, y + h - 7, 14, 14)
  }

  const touch = (kind: TouchKind, points: Point[]) => {
    if (!shown || !found || !img) return
    if (kind === 'end' || points.length !== 1) {
      drag.current = {}
      return
    }
    const p = points[0]
    const k = shown.w / img.width
    if (kind === 'start') {
      const corners = [
        [shown.x + found.x * k, shown.y + found.y * k],
        [shown.x + (found.x + found.w) * k, shown.y + (found.y + found.h) * k],
      ]
      const hit = corners.findIndex(([cx, cy]) => Math.hypot(cx - p.x, cy - p.y) < 32)
      drag.current = hit >= 0 ? { corner: hit as 0 | 1, start: p, from: found } : {}
      return
    }
    const d = drag.current
    if (d.corner === undefined || !d.start || !d.from) return
    const dx = (p.x - d.start.x) / k,
      dy = (p.y - d.start.y) / k
    const f = d.from
    let next: Detected
    if (d.corner === 0) {
      const x = clamp(f.x + dx, 0, f.x + f.w - 8),
        y = clamp(f.y + dy, 0, f.y + f.h - 8)
      next = { ...f, x, y, w: f.x + f.w - x, h: f.y + f.h - y }
    } else next = { ...f, w: clamp(f.w + dx, 8, img.width - f.x), h: clamp(f.h + dy, 8, img.height - f.y) }
    setFound({ ...next, rows: rowsOf(next) })
  }

  const setCols = (cols: number) => found && setFound({ ...found, cols, rows: rowsOf({ ...found, cols }) })

  const finish = () => {
    if (!img || !found || !pal) return
    const g = grid ?? readCells(img, found, pal)
    if (!g.colors.length) {
      void Taro.showToast({ title: '没认出豆子，换一张图试试', icon: 'none' })
      return
    }
    const draft: Draft = {
      id: newId(),
      name: '导入的图纸',
      grid: g,
      done: blankDone(g),
      locked: new Uint8Array(g.cells.length),
      revision: 0,
      inAccount: false,
      dirty: true,
      updatedAt: Date.now(),
    }
    try {
      saveLocal(deviceStorage, draft)
    } catch {
      /* 手机存储满了也先打开 */
    }
    session.draft = draft
    session.reference = undefined
    void navigateApp(makerPages.pattern(draft.id))
  }

  return (
    <Screen title="导入像素画" back className="maker-screen">
      <View className="maker-intro">
        <Text className="maker-strong">导入像素画</Text>
        <Text className="maker-note">
          选一张像素画，或者别的图纸软件、网上图纸的截图。认出格子以后一格一颗原样导入，不重新缩小取色。
        </Text>
      </View>
      {!img ? (
        <View className="maker-center">
          <Button className="button button-primary" onClick={() => void pick()}>
            选一张图
          </Button>
        </View>
      ) : (
        <>
          <MakerCanvas
            id="maker-import-stage"
            className="maker-photo-canvas"
            version={`${measured}:${JSON.stringify(found)}`}
            handle={handle}
            onSize={(width, height, ratio) => {
              size.current = { width, height, ratio }
              setMeasured((m) => m + 1)
            }}
            draw={draw}
            onTouch={touch}
          />
          <Text className="maker-hint">金色线是认出来的格子；对不齐就拖两个角</Text>
          {found && (
            <View className="maker-panel">
              <View className="maker-field maker-field-inline">
                <Text className="maker-strong">认出来</Text>
                <Text className="maker-note">
                  {found.cols}×{found.rows} 格{grid ? ` · ${grid.colors.length} 种颜色` : ''}
                </Text>
              </View>
              <View className="maker-field maker-field-inline">
                <Text className="maker-strong">格数不对</Text>
                <Stepper label="格数" value={found.cols} min={MIN_SIDE} max={MAX_SIDE} step={1} onChange={setCols} />
              </View>
              <Button className="maker-field maker-field-link" onClick={() => setChoosing(true)}>
                <View className="maker-field-head">
                  <Text className="maker-strong">对到哪套色卡</Text>
                  <Text className="maker-note">每种颜色换成这套里最接近的</Text>
                </View>
                <Text className="maker-link">{`${pal?.name ?? '选色卡'}${store?.palette === paletteId ? ' · 店里用的' : ''} ›`}</Text>
              </Button>
              <Text className="maker-note">
                截图、像素画认得准；拍纸上的图纸、有透视和反光的照片不保证，认不出来就请用「用照片做」。
              </Text>
            </View>
          )}
          <View className="maker-bottom maker-bottom-pair">
            <Button className="button button-outline" onClick={() => void pick()}>
              换一张
            </Button>
            <Button className="button button-primary" disabled={!found || !pal} onClick={finish}>
              就这样导入，去改图
            </Button>
          </View>
        </>
      )}
      {choosing && (
        <PaletteSheet
          current={paletteId}
          storePalette={store?.palette}
          onPick={(id) => {
            setPaletteId(id)
            rememberPalette(id)
            setChoosing(false)
          }}
          onClose={() => setChoosing(false)}
        />
      )}
    </Screen>
  )
}
