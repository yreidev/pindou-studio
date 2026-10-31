import { Input, Slider, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { Screen, Status } from '../../../components/customer'
import { GridCanvas, MakerCanvas, type DrawContext, type Point, type TouchKind } from '../../../components/maker/canvas'
import { FloatPanel, FloatTool } from '../../../components/maker/float'
import { PaletteSheet, Sheet, Stepper } from '../../../components/maker/sheets'
import { fitShown, overChecker, putShown } from '../../../components/maker/shown'
import { usePublicQuery } from '../../../hooks/query'
import { navigateApp } from '../../../services/navigation'
import { beadApi, beadMillimetres } from '../../../services/maker/api'
import { finishedSize } from '../../../services/maker/boards'
import {
  aspectOf,
  changeAspect,
  clampCrop,
  dragCrop,
  fullCrop,
  frameRect,
  maxZoom,
  panCrop,
  photoTransform,
  pinchCrop,
  placedDims,
  zoomCrop,
  zoomOf,
  type CropRatio,
  type Frame,
} from '../../../services/maker/crop'
import { cutout } from '../../../services/maker/cutout-device'
import { approach, frames, glideStep, GLIDE_START, GLIDE_STOP, velocityTracker } from '../../../services/gesture'
import { canvasNode } from '../../../services/maker/device'
import { makerPages, pickPhoto } from '../../../services/maker/flow'
import {
  Cancelled,
  make,
  prepare,
  rowsFor,
  styleHints,
  styleNames,
  styleSettings,
  styleTone,
  type MakeOptions,
  type Style,
} from '../../../services/maker/generate'
import { strayLabel, strayLimit, strayMinSize } from '../../../services/maker/cleanup'
import { beadCounts, blankDone, MAX_COLORS, MAX_SIDE, newId, type Grid } from '../../../services/maker/grid'
import {
  crop,
  neutralTone,
  place,
  placedSize,
  resize,
  type Pixels,
  type Placement,
  type Rect,
  type Tone,
} from '../../../services/maker/image'
import { palette as paletteOf } from '../../../services/maker/palettes'
import { defaultSettings, rememberPalette, session, type MakeSettings } from '../../../services/maker/session'
import { saveLocal, deviceStorage, type Draft } from '../../../services/maker/store'
import './index.scss'

// 做图纸第一步：调整照片（裁剪、调色），第二步：格数和颜色（画稿 MPhoto、MPhotoTone、MSetup）。两步都一屏放下、页面不滚。
// 调整照片时不转图（2026-10-21 业主定：不要边调边出预览），点「下一步」进了格数和颜色才转，那一页改设置自动重转。
// 照片只在手机上处理，不上传；转好的图纸存在手机上，进改图页。
// 裁剪是「框不动、挪照片」（2026-10-21 业主定，和微信换头像一样）：框按比例固定在画面中间，一指挪、两指捏合缩放，
// 「比例」面板里的滑杆也能缩放。手指动的时候只重画画布，松手才把裁剪交给页面。
// 调整照片一屏放下（2026-10-21 业主定）：页面不滚，照片占满标题栏以下，底下一条胶囊工具栏（比例、旋转、翻转、调色、还原、下一步），
// 点「比例」「调色」在工具栏上方弹出面板，照片区跟着变矮。工具栏不压在照片上：开发者工具里画布总在最上层，
// 叠上去的按钮看不见，真机上没验过，宁可排在照片下面（框本来也要避开它们，看起来一样）。

/** 浮在工具栏上方的面板：比例和放大、调色；不开是 undefined */
type Panel = 'ratio' | 'tone' | 'cut'
const hintKey = 'maker:crop-hint'
const ratios: { key: CropRatio; label: string; value?: number }[] = [
  { key: 'photo', label: '原图' },
  { key: 'square', label: '1:1', value: 1 },
  { key: 'portrait', label: '3:4', value: 3 / 4 },
  { key: 'landscape', label: '4:3', value: 4 / 3 },
  { key: 'board', label: '按底板' },
]
const toneRows: { key: keyof Tone; label: string; min: number }[] = [
  { key: 'brightness', label: '亮度', min: -100 },
  { key: 'contrast', label: '对比度', min: -100 },
  { key: 'saturation', label: '鲜艳度', min: -100 },
  { key: 'sharpness', label: '清晰度', min: 0 },
]
const presetCols = [29, 52, 78, 104]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export default function MakerPhoto() {
  const { params } = useRouter()
  // ?pick=1：从底部「图纸」点「用照片做图纸」进来，进来就弹选照片
  const [photo, setPhoto] = useState(() => (params.pick ? undefined : session.photo))
  useEffect(() => {
    if (!params.pick) return
    session.photo = undefined
    void pickPhoto().then((ok) => ok && setPhoto(session.photo))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const store = usePublicQuery(['bead-settings'], beadApi.settings, { once: true }).data
  const [step, setStep] = useState<'adjust' | 'setup'>('adjust')
  const [panel, setPanel] = useState<Panel>()
  // 第一次用：照片上浮一句怎么挪、怎么缩放，摸一下照片或几秒后收起，以后不再出
  const [hint, setHint] = useState(() => {
    try {
      return !Taro.getStorageSync(hintKey)
    } catch {
      return false
    }
  })
  const [placement, setPlacement] = useState<Placement>(
    () => photo?.placement ?? { rotate: 0, flip: false, crop: { x: 0, y: 0, w: 1, h: 1 } },
  )
  const [ratio, setRatio] = useState<CropRatio>(() => photo?.ratio ?? 'photo')
  const [tone, setTone] = useState<Tone>(() => photo?.tone ?? styleTone('real'))
  const [style, setStyle] = useState<Style>(() => photo?.style ?? 'real')
  const [original, setOriginal] = useState(false)
  // 抠图（试用）：cut 是顾客选了打开，cutPixels 是抠好的照片，cutNote 是面板里那一行字（走到哪一步、用了多久、为什么没抠成）
  const [cut, setCut] = useState(() => photo?.cut ?? false)
  const [cutPixels, setCutPixels] = useState(() => photo?.cutout)
  const [cutNote, setCutNote] = useState('')
  const cutting = useRef(false)
  const [settings, setSettings] = useState<MakeSettings>(() => session.settings ?? defaultSettings())
  const [customCols, setCustomCols] = useState(!presetCols.includes(settings.cols))
  const [colsText, setColsText] = useState(String(settings.cols))
  const [choosingPalette, setChoosingPalette] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [preview, setPreview] = useState<Grid>()
  const [working, setWorking] = useState(false)
  // 转图出错了（不是改了设置不用算完）：不再一直显示「正在转…」，给「再试一次」
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const touchedPalette = useRef(Boolean(session.settings))
  // 手指、滑杆正在动的裁剪：只给画布重画用，松手才 setPlacement
  const live = useRef<Rect>(placement.crop)
  const repaint = useRef<() => void>()

  // 收起时才记下看过了（页面可能挂载两次，一进来就记的话第二次就不出了）
  const hideHint = () => {
    setHint(false)
    try {
      Taro.setStorageSync(hintKey, 1)
    } catch {
      /* 记不住就下次再提示一次 */
    }
  }
  useEffect(() => {
    if (!hint || !photo) return
    const timer = setTimeout(hideHint, 6000)
    return () => clearTimeout(timer)
  }, [hint, photo])

  // 店里的设置读到了、顾客又没选过色卡：默认用店里那套
  useEffect(() => {
    if (store && !touchedPalette.current)
      setSettings((s) => ({ ...s, paletteId: defaultSettings(store.palette).paletteId }))
  }, [store?.palette]) // eslint-disable-line react-hooks/exhaustive-deps

  // 页面间带着走：返回再进来、去改图再回来都还在
  useEffect(() => {
    if (photo) Object.assign(photo, { placement, tone, style, ratio, cut })
    session.settings = settings
  }, [photo, placement, tone, style, ratio, cut, settings])

  // 换了照片：抠图的选择和结果跟着这张照片走
  useEffect(() => {
    setCut(photo?.cut ?? false)
    setCutPixels(photo?.cutout)
    setCutNote('')
  }, [photo])

  const boardSize = store?.boardSize ?? 52
  const pal = paletteOf(settings.paletteId) ?? paletteOf('mard-221')!
  const isStorePalette = !!store && store.palette === pal.id
  const allowed = useMemo(() => {
    if (!settings.onlyStore || !isStorePalette || !store?.available) return undefined
    return store.available.map((code) => pal.index.get(code)).filter((v): v is number => v !== undefined)
  }, [settings.onlyStore, isStorePalette, store?.available, pal])

  // 调整好的照片（摆好、调好色）；抠了图就用抠好的（背景透明，转出来是空格子）
  const source = photo && (cut && cutPixels ? cutPixels : photo.pixels)
  const prepared = useMemo(() => (source ? prepare(source, placement, tone) : undefined), [source, placement, tone])
  const unToned = useMemo(
    () => (source && original ? prepare(source, placement, neutralTone()) : undefined),
    [source, placement, original],
  )

  // 这次转图要用的照片和设置；预览转好时记下是按哪一份转的，「去改图」时一样就不用再转一遍
  const inputs = useMemo(
    () =>
      prepared && {
        view: prepared,
        options: {
          cols: settings.cols,
          palette: pal,
          allowed,
          maxColors: settings.maxColors,
          minCluster: settings.minCluster,
          style,
        } as MakeOptions,
      },
    [prepared, settings.cols, settings.maxColors, settings.minCluster, pal, allowed, style],
  )
  const previewOf = useRef<typeof inputs>()

  // 只在「格数和颜色」这一步转图（停手 300 毫秒后）；设置又变了、退回调整照片的话上一次不用算完。
  // 照片和设置都没变（退回去没改又进来）就不再转
  useEffect(() => {
    if (!inputs || step !== 'setup' || previewOf.current === inputs) return
    let alive = true
    const timer = setTimeout(() => {
      setWorking(true)
      setFailed(false)
      make(inputs.view, { ...inputs.options, cancelled: () => !alive })
        .then((g) => {
          if (!alive) return
          previewOf.current = inputs
          setPreview(g)
        })
        // 不用算了（Cancelled）不管；转不出来的话记下错误、提示顾客，预览留着上一张
        .catch((error: unknown) => {
          if (!alive || error instanceof Cancelled) return
          console.error('做图纸：转图失败', error)
          setFailed(true)
        })
        .finally(() => alive && setWorking(false))
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [inputs, attempt, step])

  if (!photo)
    return (
      <Screen title="做图纸" back>
        <Status
          kind="empty"
          title="先选一张照片"
          message="照片只在手机上处理，不会上传。"
          action="选照片"
          onAction={() => void pickPhoto().then((ok) => ok && setPhoto(session.photo))}
        />
      </Screen>
    )

  const src = photo.pixels
  const placed = placedSize(src.width, src.height, placement)
  const rows = rowsFor(settings.cols, placed.width, placed.height)
  const meta = preview
    ? `${preview.width}×${preview.height} 格 · ${preview.colors.length} 种颜色 · ${beadCounts(preview).beads} 颗`
    : `${settings.cols}×${rows} 格`
  const size = finishedSize({ width: settings.cols, height: rows } as Grid, beadMillimetres(store?.beadSize ?? 'mini'))
  const [W, H] = placedDims(src.width, src.height, placement.rotate)
  const zoom = zoomOf(placement.crop, W, H)
  const zoomLimit = maxZoom(placement.crop, W, H)

  const retry = () => setAttempt((n) => n + 1)
  /** 打开抠图：这张抠过了直接用；没抠过就在手机上抠一次（第一次要解开模型，慢一些） */
  const startCut = async () => {
    setCut(true)
    if (cutPixels || cutting.current) return
    cutting.current = true
    const target = photo
    const seconds = (ms: number) => (ms / 1000).toFixed(1)
    try {
      const result = await cutout(target.pixels, setCutNote)
      if (session.photo !== target) return
      if (result.share < 0.02) {
        setCut(false)
        setCutNote('没认出主体，换一张主体清楚的照片试试')
        return
      }
      target.cutout = result.pixels
      setCutPixels(result.pixels)
      const t = result.timing
      setCutNote(
        `${result.share > 0.97 ? '几乎整张都是主体，没去掉多少背景' : '抠好了，背景的格子是空的，不用拼'}。用时：` +
          `${t.unpack ? `解开模型 ${seconds(t.unpack)} 秒、` : ''}加载模型 ${seconds(t.load)} 秒、抠图 ${seconds(t.run)} 秒`,
      )
    } catch (error) {
      console.error('做图纸：抠图失败', error)
      if (session.photo !== target) return
      setCut(false)
      setCutNote(`没抠成：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      cutting.current = false
    }
  }
  const changeSettings = (patch: Partial<MakeSettings>) => setSettings((s) => ({ ...s, ...patch }))
  /** 换风格：调色、颜色最多、清掉零星跟着换成这个风格的一套（之后还能自己改） */
  const pickStyle = (s: Style) => {
    setStyle(s)
    setTone(styleTone(s))
    changeSettings(styleSettings(s))
  }
  /** 定下一次裁剪（换比例、转、翻、还原、松手、滑杆停下） */
  const commit = (next: Placement) => {
    live.current = next.crop
    setPlacement(next)
  }
  /** 这个比例的框是多宽（宽 / 高，按像素）；dims 是转好之后的宽高 */
  const aspectFor = (key: CropRatio, [w, h]: [number, number]) =>
    key === 'photo'
      ? w / h
      : key === 'board'
        ? boardAspect(settings.cols, rowsFor(settings.cols, w, h), boardSize)
        : ratios.find((r) => r.key === key)!.value!

  const go = async () => {
    if (!prepared || !inputs) return
    void Taro.showLoading({ title: '正在生成' })
    try {
      const grid = preview && previewOf.current === inputs ? preview : await make(inputs.view, inputs.options)
      const now = new Date()
      const draft: Draft = {
        id: newId(),
        name: `照片图纸 ${now.getMonth() + 1}-${now.getDate()}`,
        grid,
        done: blankDone(grid),
        locked: new Uint8Array(grid.cells.length),
        revision: 0,
        inAccount: false,
        dirty: true,
        updatedAt: Date.now(),
      }
      try {
        saveLocal(deviceStorage, draft)
      } catch {
        void Taro.showToast({ title: '手机存储满了，这张没存在手机上', icon: 'none' })
      }
      session.draft = draft
      session.reference = { id: draft.id, pixels: prepared }
      void Taro.hideLoading()
      void navigateApp(makerPages.pattern(draft.id))
    } catch {
      void Taro.hideLoading()
      void Taro.showToast({ title: '生成失败，换个格数再试', icon: 'none' })
    }
  }

  return (
    <Screen
      title={step === 'adjust' ? '调整照片' : '格数和颜色'}
      back
      dark={step === 'adjust'}
      className={
        step === 'adjust' ? 'maker-screen maker-screen-dark maker-screen-stage' : 'maker-screen maker-screen-fit'
      }
    >
      {step === 'adjust' ? (
        <View className="maker-stage">
          <View className="maker-stage-photo">
            {panel === 'tone' ? (
              <ToneStage image={unToned ?? prepared} layout={`${panel}:${style}`} />
            ) : panel === 'cut' ? (
              <ToneStage image={prepared} layout={panel} checker />
            ) : (
              <CropStage
                photo={photo}
                placement={placement}
                live={live}
                handle={repaint}
                layout={panel ?? ''}
                hint={hint}
                onCommit={commit}
                onTouched={() => hint && hideHint()}
              />
            )}
          </View>
          <View className="maker-float-bottom">
            {panel === 'ratio' && (
              <FloatPanel title="比例和放大" onClose={() => setPanel(undefined)}>
                <View className="maker-float-row">
                  {ratios.map((r) => (
                    <Button
                      key={r.key}
                      className={`maker-chip maker-chip-dark ${ratio === r.key ? 'maker-chip-selected' : ''}`}
                      onClick={() => {
                        setRatio(r.key)
                        commit({ ...placement, crop: changeAspect(placement.crop, W, H, aspectFor(r.key, [W, H])) })
                        if (r.key === 'board') {
                          const bx = Math.max(1, Math.ceil(settings.cols / boardSize))
                          changeSettings({ cols: Math.min(MAX_SIDE, bx * boardSize) })
                          void Taro.showToast({
                            title: `框正好铺满整块的底板（${boardSize} 格一块）`,
                            icon: 'none',
                            duration: 2500,
                          })
                        }
                      }}
                    >
                      {r.label}
                    </Button>
                  ))}
                </View>
                <View className="maker-slider-row">
                  <Text className="maker-slider-label">放大</Text>
                  <Slider
                    className="maker-slider"
                    min={100}
                    max={Math.round(zoomLimit * 100)}
                    step={1}
                    value={Math.round(zoom * 100)}
                    disabled={zoomLimit <= 1}
                    activeColor="#d8c08f"
                    backgroundColor="#4a463e"
                    blockSize={20}
                    onChanging={(e) => {
                      live.current = zoomCrop(placement.crop, W, H, e.detail.value / 100)
                      repaint.current?.()
                    }}
                    onChange={(e) =>
                      commit({ ...placement, crop: zoomCrop(placement.crop, W, H, e.detail.value / 100) })
                    }
                  />
                  <Text className="maker-slider-value">{zoom.toFixed(1)} 倍</Text>
                </View>
              </FloatPanel>
            )}
            {panel === 'tone' && (
              <FloatPanel title="调色" onClose={() => setPanel(undefined)}>
                <View className="maker-float-row">
                  {(Object.keys(styleNames) as Style[]).map((s) => (
                    <Button
                      key={s}
                      className={`maker-chip maker-chip-dark ${style === s ? 'maker-chip-selected' : ''}`}
                      onClick={() => pickStyle(s)}
                    >
                      {styleNames[s]}
                    </Button>
                  ))}
                </View>
                {styleHints[style] && <Text className="maker-float-note">{styleHints[style]}</Text>}
                {toneRows.map((row) => (
                  <View key={row.key} className="maker-slider-row">
                    <Text className="maker-slider-label">{row.label}</Text>
                    <Slider
                      className="maker-slider"
                      min={row.min}
                      max={100}
                      step={1}
                      value={tone[row.key]}
                      activeColor="#d8c08f"
                      backgroundColor="#4a463e"
                      blockSize={18}
                      onChange={(e) => setTone((t) => ({ ...t, [row.key]: e.detail.value }))}
                    />
                    <Text className="maker-slider-value">{tone[row.key]}</Text>
                  </View>
                ))}
                <View className="maker-row-actions">
                  <Button
                    className="maker-action maker-action-dark"
                    onTouchStart={() => setOriginal(true)}
                    onTouchEnd={() => setOriginal(false)}
                    onTouchCancel={() => setOriginal(false)}
                  >
                    按住看原图
                  </Button>
                  <Button className="maker-action maker-action-dark" onClick={() => setTone(styleTone(style))}>
                    恢复这个风格
                  </Button>
                </View>
              </FloatPanel>
            )}
            {panel === 'cut' && (
              <FloatPanel title="抠图（试用）" onClose={() => setPanel(undefined)}>
                <View className="maker-float-row">
                  <Button
                    className={`maker-chip maker-chip-dark ${!cut ? 'maker-chip-selected' : ''}`}
                    onClick={() => setCut(false)}
                  >
                    不抠
                  </Button>
                  <Button
                    className={`maker-chip maker-chip-dark ${cut ? 'maker-chip-selected' : ''}`}
                    onClick={() => void startCut()}
                  >
                    抠出主体
                  </Button>
                </View>
                <Text className="maker-float-note">
                  {cutNote || '认出照片里的主体，背景不做成豆子。照片只在手机上处理，不上传。'}
                </Text>
              </FloatPanel>
            )}
            <View className="maker-dock">
              <FloatTool
                icon="ratio"
                label="比例"
                selected={panel === 'ratio'}
                onClick={() => setPanel(panel === 'ratio' ? undefined : 'ratio')}
              />
              <FloatTool
                icon="rotate"
                label="旋转"
                onClick={() => {
                  // 转了以后宽高对调：同一个比例重新放一个最大的框
                  const rotate = ((placement.rotate + 1) % 4) as Placement['rotate']
                  const dims = placedDims(src.width, src.height, rotate)
                  commit({ ...placement, rotate, crop: fullCrop(dims[0], dims[1], aspectFor(ratio, dims)) })
                }}
              />
              <FloatTool
                icon="flip"
                label="翻转"
                onClick={() =>
                  commit({
                    ...placement,
                    flip: !placement.flip,
                    crop: { ...placement.crop, x: 1 - placement.crop.x - placement.crop.w },
                  })
                }
              />
              <FloatTool
                icon="tone"
                label="调色"
                selected={panel === 'tone'}
                onClick={() => setPanel(panel === 'tone' ? undefined : 'tone')}
              />
              <FloatTool
                icon="cut"
                label="抠图"
                selected={panel === 'cut'}
                onClick={() => setPanel(panel === 'cut' ? undefined : 'cut')}
              />
              <FloatTool
                icon="reset"
                label="还原"
                onClick={() => {
                  setRatio('photo')
                  commit({ rotate: 0, flip: false, crop: { x: 0, y: 0, w: 1, h: 1 } })
                }}
              />
              <Button className="maker-dock-next" onClick={() => setStep('setup')}>
                下一步
              </Button>
            </View>
          </View>
        </View>
      ) : (
        <>
          <View className="maker-setup-preview">
            {/* 开着弹层时预览照常画：真机上画布是同层渲染，弹层盖得住；开发者工具里画布会压在弹层上面，那是工具模拟的问题 */}
            {preview ? (
              <GridCanvas
                id="maker-setup-canvas"
                className="maker-setup-canvas"
                grid={preview}
                palette={pal}
                version={preview}
                options={{ background: '#ffffff', gridColor: '#e4ddcf' }}
                mode="pan"
              />
            ) : failed && !working ? (
              <View className="maker-failed">
                <Text className="maker-note">没转出来</Text>
                <Button className="maker-chip maker-retry" onClick={retry}>
                  再试一次
                </Button>
              </View>
            ) : (
              <Text className="maker-note">正在转…</Text>
            )}
          </View>
          <View className="maker-meta-row">
            <Text className="maker-meta">
              {meta} · 成品约 {size.width}×{size.height} 厘米
              {working ? ' · 正在转…' : failed && preview ? ' · 这次没转出来' : ''}
            </Text>
            {failed && preview && !working && (
              <Button className="maker-meta-retry" onClick={retry}>
                再试一次
              </Button>
            )}
          </View>
          <View className="maker-setup-styles">
            {(Object.keys(styleNames) as Style[]).map((s) => (
              <Button
                key={s}
                className={`maker-chip ${style === s ? 'maker-chip-selected' : ''}`}
                onClick={() => pickStyle(s)}
              >
                {styleNames[s]}
              </Button>
            ))}
          </View>
          <View className="maker-setup-card">
            <View className="maker-setup-row">
              <Text className="maker-setup-label">格数</Text>
              <View className="maker-setup-cols">
                {presetCols.map((c) => (
                  <Button
                    key={c}
                    className={`maker-chip ${!customCols && settings.cols === c ? 'maker-chip-selected' : ''}`}
                    onClick={() => {
                      setCustomCols(false)
                      setColsText(String(c))
                      changeSettings({ cols: c })
                    }}
                  >
                    {String(c)}
                  </Button>
                ))}
                {customCols ? (
                  <Input
                    className="maker-input"
                    type="number"
                    value={colsText}
                    maxlength={3}
                    focus
                    onInput={(e) => setColsText(e.detail.value)}
                    onBlur={() => {
                      const n = clamp(Math.round(Number(colsText) || settings.cols), 8, MAX_SIDE)
                      setColsText(String(n))
                      changeSettings({ cols: n })
                    }}
                  />
                ) : (
                  <Button className="maker-chip" onClick={() => setCustomCols(true)}>
                    自己填
                  </Button>
                )}
              </View>
            </View>
            <View className="maker-setup-row">
              <Text className="maker-setup-label">颜色最多</Text>
              <Stepper
                label="颜色最多"
                value={settings.maxColors}
                min={2}
                max={MAX_COLORS}
                onChange={(maxColors) => changeSettings({ maxColors })}
              />
            </View>
            <Button className="maker-setup-row maker-setup-link" onClick={() => setChoosingPalette(true)}>
              <Text className="maker-setup-label">色卡</Text>
              <Text className="maker-setup-value">
                {pal.name}
                {isStorePalette ? ' · 店里用的' : ''} ›
              </Text>
            </Button>
            <Button className="maker-setup-row maker-setup-link" onClick={() => setMoreOpen(true)}>
              <Text className="maker-setup-label">更多设置</Text>
              <Text className="maker-setup-value">
                {strayLabel(settings.minCluster)}
                {isStorePalette && store?.available && settings.onlyStore ? ' · 只用店里有的' : ''} ›
              </Text>
            </Button>
          </View>
          <View className="maker-bottom maker-bottom-pair">
            <Button className="button button-outline" onClick={() => setStep('adjust')}>
              改照片
            </Button>
            <Button className="button button-primary" disabled={!preview} onClick={() => void go()}>
              就这样，去改图
            </Button>
          </View>
          {choosingPalette && (
            <PaletteSheet
              current={pal.id}
              storePalette={store?.palette}
              onClose={() => setChoosingPalette(false)}
              onPick={(id) => {
                touchedPalette.current = true
                rememberPalette(id)
                changeSettings({ paletteId: id, onlyStore: settings.onlyStore && id === store?.palette })
                setChoosingPalette(false)
              }}
            />
          )}
          {moreOpen && (
            <Sheet title="更多设置" light onClose={() => setMoreOpen(false)}>
              <View className="maker-field maker-field-inline">
                <View className="maker-field-head">
                  <Text className="maker-strong">清掉零星小块</Text>
                  <Text className="maker-note">被一种颜色围着、不超过几颗的小块，并进周围；1 是只清单颗，0 是不清</Text>
                </View>
                <Stepper
                  label="清掉零星小块"
                  value={strayLimit(settings.minCluster)}
                  min={0}
                  max={9}
                  onChange={(n) => changeSettings({ minCluster: strayMinSize(n) })}
                />
              </View>
              {isStorePalette && store?.available && (
                <View className="maker-field">
                  <Text className="maker-strong">用哪些颜色</Text>
                  <View className="maker-segment">
                    <Button
                      className={`maker-segment-item ${!settings.onlyStore ? 'maker-segment-selected' : ''}`}
                      onClick={() => changeSettings({ onlyStore: false })}
                    >
                      这套色卡全部
                    </Button>
                    <Button
                      className={`maker-segment-item ${settings.onlyStore ? 'maker-segment-selected' : ''}`}
                      onClick={() => changeSettings({ onlyStore: true })}
                    >
                      只用店里有的
                    </Button>
                  </View>
                </View>
              )}
              <Text className="maker-note maker-sheet-tip">
                格数：{boardSize} 格正好一块底板；自己填 8～300 格，越多越像，也越费豆子。色卡按手上的豆子选。
              </Text>
            </Sheet>
          )}
        </>
      )}
    </Screen>
  )
}

/** 正好铺满整块底板的宽高比（按现在的格数取整到整块）。 */
function boardAspect(cols: number, rows: number, board: number) {
  const bx = Math.max(1, Math.ceil(cols / board)),
    by = Math.max(1, Math.ceil(rows / board))
  return bx / by
}

type CropProps = {
  photo: NonNullable<typeof session.photo>
  placement: Placement
  /** 手指、滑杆正在动的裁剪（页面和这里共用） */
  live: { current: Rect }
  /** 不经过 React 重画画布 */
  handle: { current?: () => void }
  /** 照片区的大小可能变了（开关面板）：变了就重新量画布 */
  layout: string
  /** 第一次用：照片上方写一句怎么挪、怎么缩放 */
  hint: boolean
  onCommit: (p: Placement) => void
  /** 手指碰到照片了（收起第一次的提示） */
  onTouched?: () => void
}

/**
 * 裁剪：框按 crop 的比例固定在画面中间，照片在下面跟着手指挪、两指缩放；框外压暗，手指按着时框里画三等分线。
 * 照片用原图 drawImage 画（每帧只是换个变换，跟得上手指）；原图还没读好或读不出来时，按像素把框里那块画出来。
 */
function CropStage({ photo, placement, live, handle, layout, hint, onCommit, onTouched }: CropProps) {
  const src = photo.pixels
  const [W, H] = placedDims(src.width, src.height, placement.rotate)
  const size = useRef({ width: 0, height: 0 })
  const [measured, setMeasured] = useState(0)
  const image = useRef<unknown>()
  const [loaded, setLoaded] = useState(false)
  const whole = useRef<{ key: string; pixels: Pixels }>()
  const drag = useRef<{ mode: 'none' | 'pan' | 'pinch'; start?: Point; crop?: Rect; d0?: number; m0?: Point }>({
    mode: 'none',
  })
  const frameOf = (c: Rect): Frame | undefined =>
    size.current.width ? frameRect(size.current.width, size.current.height, aspectOf(c, W, H)) : undefined

  const draw = (ctx: DrawContext, width: number, height: number, r: number) => {
    ctx.fillStyle = '#22211d'
    ctx.fillRect(0, 0, width, height)
    const c = live.current
    const f = frameOf(c)
    if (!f) return
    if (image.current) {
      const [a, b, cc, d, e, ff] = photoTransform(src.width, src.height, { ...placement, crop: c }, f)
      ctx.setTransform(a * r, b * r, cc * r, d * r, e * r, ff * r)
      ctx.drawImage(image.current, 0, 0, src.width, src.height)
      ctx.setTransform(r, 0, 0, r, 0, 0)
    } else {
      const key = `${placement.rotate}:${placement.flip}`
      if (whole.current?.key !== key)
        whole.current = { key, pixels: place(src, { ...placement, crop: { x: 0, y: 0, w: 1, h: 1 } }) }
      const region = crop(whole.current.pixels, { x: c.x * W, y: c.y * H, w: c.w * W, h: c.h * H })
      const pixels = resize(region, Math.max(1, Math.round(f.w * r)), Math.max(1, Math.round(f.h * r)))
      putShown(ctx, { pixels, x: f.x, y: f.y, w: f.w, h: f.h }, r, '#22211d', width, height)
    }
    ctx.fillStyle = 'rgba(34, 33, 29, 0.62)'
    ctx.fillRect(0, 0, width, f.y)
    ctx.fillRect(0, f.y + f.h, width, height - f.y - f.h)
    ctx.fillRect(0, f.y, f.x, f.h)
    ctx.fillRect(f.x + f.w, f.y, width - f.x - f.w, f.h)
    if (drag.current.mode !== 'none') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const k of [1, 2]) {
        ctx.moveTo(f.x + (f.w * k) / 3, f.y)
        ctx.lineTo(f.x + (f.w * k) / 3, f.y + f.h)
        ctx.moveTo(f.x, f.y + (f.h * k) / 3)
        ctx.lineTo(f.x + f.w, f.y + (f.h * k) / 3)
      }
      ctx.stroke()
    }
    ctx.strokeStyle = '#d8c08f'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(f.x, f.y, f.w, f.h)
    ctx.stroke()
    if (hint) drawHint(ctx, width, f)
  }

  // 一指挪的速度、松手后在跑的滑行或弹回（docs/plan-interaction.md 第 4 节）
  const tracker = useRef(velocityTracker())
  const motion = useRef<() => void>()
  const stop = () => {
    motion.current?.()
    motion.current = undefined
  }
  // 页面换了裁剪（换比例、转、翻、还原）就不再接着滑
  useEffect(() => stop, [placement])
  /** 松手：拖出了照片边就弹回来；还在动就接着滑，滑到边上停；停了才交给页面 */
  const release = (f: Frame, moving: boolean) => {
    const [vx, vy] = tracker.current.get()
    let v = moving && Math.hypot(vx, vy) >= GLIDE_START ? { x: vx, y: vy } : { x: 0, y: 0 }
    motion.current = frames((dt) => {
      const c = live.current
      const home = clampCrop(c)
      if (Math.abs(home.x - c.x) > 1e-5 || Math.abs(home.y - c.y) > 1e-5) {
        live.current = { ...c, x: approach(c.x, home.x, dt, 1e-5), y: approach(c.y, home.y, dt, 1e-5) }
      } else if (Math.hypot(v.x, v.y) > GLIDE_STOP) {
        const fx = glideStep(v.x, dt),
          fy = glideStep(v.y, dt)
        const next = panCrop(c, f, fx.distance, fy.distance)
        // 滑到照片边上就停在那一边
        v = { x: next.x === c.x ? 0 : fx.velocity, y: next.y === c.y ? 0 : fy.velocity }
        live.current = next
      } else {
        motion.current = undefined
        onCommit({ ...placement, crop: live.current })
        handle.current?.()
        return false
      }
      handle.current?.()
      return true
    })
  }

  const touch = (kind: TouchKind, points: Point[]) => {
    if (kind === 'start') {
      onTouched?.()
      stop()
    }
    const f = frameOf(live.current)
    if (!f) return
    const d = drag.current
    if (!points.length) {
      if (d.mode === 'none') return
      drag.current = { mode: 'none' }
      release(f, d.mode === 'pan')
      handle.current?.()
      return
    }
    if (points.length >= 2) {
      const [a, b] = points
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { id: 0, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      if (d.mode === 'pinch') live.current = pinchCrop(d.crop!, W, H, f, d.d0!, dist, d.m0!, mid)
      else drag.current = { mode: 'pinch', crop: live.current, d0: dist, m0: mid }
      handle.current?.()
      return
    }
    const p = points[0]
    // 刚按下，或者两指松开了一指：从这一指重新算
    if (d.mode === 'pan' && kind === 'move') live.current = dragCrop(d.crop!, f, p.x - d.start!.x, p.y - d.start!.y)
    else {
      drag.current = { mode: 'pan', start: p, crop: clampCrop(live.current) }
      tracker.current.reset()
    }
    tracker.current.push(Date.now(), p.x, p.y)
    handle.current?.()
  }

  return (
    <MakerCanvas
      id="maker-photo-stage"
      className="maker-photo-canvas"
      version={`${measured}:${loaded}:${hint}:${JSON.stringify(placement)}`}
      layout={layout}
      handle={handle}
      onSize={(width, height) => {
        size.current = { width, height }
        setMeasured((m) => m + 1)
        if (image.current !== undefined) return
        image.current = null
        void canvasNode('maker-photo-stage').then((hit) => {
          const img = hit?.node.createImage?.()
          if (!img) return
          img.onload = () => {
            image.current = img
            setLoaded(true)
          }
          img.onerror = () => undefined
          img.src = photo.path
        })
      }}
      draw={draw}
      onTouch={touch}
    />
  )
}

/** 第一次用的提示：画在框上方的空白里（放不下就压在框的顶上），深色圆角底、两行字。 */
function drawHint(ctx: DrawContext, width: number, f: Frame) {
  const w = Math.min(width - 32, 260),
    h = 46
  const x = (width - w) / 2,
    y = f.y >= h + 16 ? (f.y - h) / 2 : f.y + 8
  ctx.fillStyle = 'rgba(29, 28, 25, 0.82)'
  ctx.beginPath()
  ctx.moveTo(x + 12, y)
  ctx.lineTo(x + w - 12, y)
  ctx.arc(x + w - 12, y + 12, 12, -Math.PI / 2, 0)
  ctx.lineTo(x + w, y + h - 12)
  ctx.arc(x + w - 12, y + h - 12, 12, 0, Math.PI / 2)
  ctx.lineTo(x + 12, y + h)
  ctx.arc(x + 12, y + h - 12, 12, Math.PI / 2, Math.PI)
  ctx.lineTo(x, y + 12)
  ctx.arc(x + 12, y + 12, 12, Math.PI, Math.PI * 1.5)
  ctx.closePath()
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#f7f5f0'
  ctx.font = '13px sans-serif'
  ctx.fillText('单指拖动照片，双指捏合缩放', width / 2, y + 16)
  ctx.fillStyle = '#c7bda9'
  ctx.font = '11px sans-serif'
  ctx.fillText('照片只在手机上处理，不会上传', width / 2, y + 33)
}

/** 调色：显示裁好、调好色的照片；checker 时透明的地方（抠掉的背景）垫上浅色格子。 */
function ToneStage({ image, layout, checker = false }: { image?: Pixels; layout: string; checker?: boolean }) {
  const size = useRef({ width: 0, height: 0, ratio: 1 })
  const [measured, setMeasured] = useState(0)
  // 四周留 16，和裁剪框一样
  const shown = useMemo(() => {
    const { width, height, ratio } = size.current
    if (!image || !width) return undefined
    const m = 16
    const fit = fitShown(image, Math.max(1, width - m * 2), Math.max(1, height - m * 2), ratio)
    const pixels = checker ? overChecker(fit.pixels, Math.round(8 * ratio)) : fit.pixels
    return { ...fit, pixels, x: fit.x + m, y: fit.y + m }
  }, [image, measured, checker]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <MakerCanvas
      id="maker-photo-tone"
      className="maker-photo-canvas"
      version={shown ?? measured}
      layout={layout}
      onSize={(width, height, ratio) => {
        size.current = { width, height, ratio }
        setMeasured((m) => m + 1)
      }}
      draw={(ctx, width, height, r) => {
        if (shown) putShown(ctx, shown, r, '#22211d', width, height)
        else {
          ctx.fillStyle = '#22211d'
          ctx.fillRect(0, 0, width, height)
        }
      }}
    />
  )
}
