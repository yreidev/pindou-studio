import { Canvas } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useRef, type CSSProperties } from 'react'
import { approach, frames, GLIDE_START, GLIDE_STOP, glideStep, velocityTracker } from '../../services/gesture'
import { canvasNode, pixelRatio, type CanvasNode } from '../../services/maker/device'
import type { Grid } from '../../services/maker/grid'
import type { Palette } from '../../services/maker/palettes'
import {
  cellAt,
  drawGrid,
  fitView,
  settleView,
  stretchScale,
  stretchView,
  zoomView,
  type Ctx,
  type DrawOptions,
  type View,
} from '../../services/maker/render'

// 做图纸的画布：<Canvas type="2d">。
// 画只在 version 变了、或手指动了的那一帧重画；触点都换成画布上的 CSS 像素坐标交给页面。

export type Point = { id: number; x: number; y: number }
export type TouchKind = 'start' | 'move' | 'end'

export type DrawContext = Ctx & {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  putImageData(data: unknown, x: number, y: number): void
  createImageData(width: number, height: number): { data: Uint8ClampedArray }
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void
}

type Props = {
  id: string
  className?: string
  style?: CSSProperties
  /** 变了就重画 */
  version: unknown
  draw: (ctx: DrawContext, width: number, height: number, ratio: number) => void
  onTouch?: (kind: TouchKind, points: Point[]) => void
  /** 量好大小以后（第一次和窗口变了时）：CSS 像素和像素比 */
  onSize?: (width: number, height: number, ratio: number) => void
  /** 页面不经过 React 重新渲染就重画（缩放、拖动每帧都要画，不该每帧都渲染整页） */
  handle?: { current?: () => void }
  /** 画布在页面上的大小可能变了（比如下面弹出了面板）：变了就重新量 */
  layout?: unknown
}

export function MakerCanvas({ id, className = '', style, version, draw, onTouch, onSize, handle, layout }: Props) {
  const box = useRef<{
    node?: CanvasNode
    ctx?: DrawContext
    width: number
    height: number
    ratio: number
    pending: boolean
  }>({
    width: 0,
    height: 0,
    ratio: 1,
    pending: false,
  })
  const latest = useRef({ draw, onTouch, onSize })
  latest.current = { draw, onTouch, onSize }
  const paint = () => {
    const b = box.current
    if (!b.ctx || !b.node || b.pending) return
    b.pending = true
    const run = () => {
      b.pending = false
      if (!b.ctx) return
      b.ctx.setTransform(b.ratio, 0, 0, b.ratio, 0, 0)
      latest.current.draw(b.ctx, b.width, b.height, b.ratio)
    }
    if (b.node.requestAnimationFrame) b.node.requestAnimationFrame(run)
    else setTimeout(run, 16)
  }
  useEffect(() => {
    let alive = true
    const measure = () =>
      void canvasNode(id).then((hit) => {
        if (!alive || !hit || !hit.width) return
        const ratio = pixelRatio()
        hit.node.width = Math.round(hit.width * ratio)
        hit.node.height = Math.round(hit.height * ratio)
        box.current = {
          ...box.current,
          node: hit.node,
          ctx: hit.node.getContext('2d') as DrawContext,
          width: hit.width,
          height: hit.height,
          ratio,
        }
        latest.current.onSize?.(hit.width, hit.height, ratio)
        paint()
      })
    Taro.nextTick(measure)
    // 布局变了的那一次，排版可能还没完：过一会儿再量一遍
    const again = setTimeout(measure, 80)
    const resize = () => setTimeout(measure, 50)
    Taro.onWindowResize(resize)
    return () => {
      alive = false
      clearTimeout(again)
      Taro.offWindowResize(resize)
    }
  }, [id, layout])
  useEffect(paint, [version])
  if (handle) handle.current = paint
  const points = (touches: ArrayLike<{ identifier: number; x: number; y: number }>) =>
    Array.from(touches, (t) => ({ id: t.identifier, x: t.x, y: t.y }))
  return (
    <Canvas
      id={id}
      type="2d"
      className={`maker-canvas ${className}`}
      style={style}
      disableScroll
      onTouchStart={(e) => latest.current.onTouch?.('start', points(e.touches))}
      onTouchMove={(e) => latest.current.onTouch?.('move', points(e.touches))}
      onTouchEnd={(e) => latest.current.onTouch?.('end', points(e.touches))}
      onTouchCancel={(e) => latest.current.onTouch?.('end', points(e.touches))}
    />
  )
}

export type CellEvent = 'start' | 'move' | 'end' | 'cancel'

type GridProps = {
  id: string
  className?: string
  grid: Grid
  palette: Palette
  version: unknown
  options: DrawOptions
  /** draw：单指画（交给 onCell），双指缩放拖动；pan：单指拖动、点一下交给 onTap */
  mode: 'draw' | 'pan'
  onCell?: (event: CellEvent, cell: [number, number]) => void
  onTap?: (cell: [number, number]) => void
  /** 视图换了（缩放、拖动）时告诉页面，比如按行看时把这一行挪进画面 */
  viewRef?: { current: View | undefined }
  /** 画布占掉剩下的高度时，上下的东西变了（收起一块、换了看法）就重新量，图纸重新放进画面 */
  layout?: unknown
}

/**
 * 图纸画布：双指缩放、拖动；单指按 mode 画或拖。
 * 拖出边界、缩过上下限时越拖越难，松手弹回；拖动松手时还在动就接着滑一段、慢慢停下，手指再按下立刻停（docs/plan-interaction.md 第 4 节）。
 */
export function GridCanvas({
  id,
  className,
  grid,
  palette,
  version,
  options,
  mode,
  onCell,
  onTap,
  viewRef,
  layout,
}: GridProps) {
  const view = useRef<View>()
  const size = useRef({ width: 0, height: 0 })
  const gesture = useRef<{
    kind: 'none' | 'one' | 'two'
    start?: Point
    last?: Point
    moved: boolean
    at: number
    pinch?: { d: number; mid: Point; view: View }
  }>({ kind: 'none', moved: false, at: 0 })
  const shape = `${grid.width}x${grid.height}`
  const fitted = useRef('')
  const ensure = () => {
    if (!view.current || fitted.current !== shape) {
      view.current = fitView(grid, size.current.width, size.current.height)
      fitted.current = shape
    }
    if (viewRef) viewRef.current = view.current
    return view.current
  }
  const handle = useRef<() => void>()
  const redraw = () => handle.current?.()
  // 拖动的速度、单指拖时没加阻尼的位置、松手后在跑的滑行或弹回
  const tracker = useRef(velocityTracker())
  const raw = useRef({ x: 0, y: 0 })
  const anchor = useRef({ x: 0, y: 0 })
  const motion = useRef<() => void>()
  const stop = () => {
    motion.current?.()
    motion.current = undefined
  }
  useEffect(() => stop, [])
  // 缩小的下限：每格 2 像素，整张放进画面比这还小时就是整张放进画面那么小
  const minScale = () => Math.min(2, fitView(grid, size.current.width, size.current.height).scale)
  const show = (v: View) => {
    view.current = v
    if (viewRef) viewRef.current = v
    redraw()
  }
  /** 松手：还在动就滑一段（出了边界很快停），停下以后在界外就弹回来 */
  const release = (moving: boolean) => {
    stop()
    const [vx, vy] = tracker.current.get()
    let v = moving && Math.hypot(vx, vy) >= GLIDE_START ? { x: vx, y: vy } : { x: 0, y: 0 }
    const { width, height } = size.current
    motion.current = frames((dt) => {
      const cur = ensure()
      const home = settleView(cur, grid, width, height, anchor.current.x, anchor.current.y, minScale())
      // 比的时候留一点余量：缩放换算有小数误差，严格相等会一直判成界外、一直重画
      const outside =
        Math.abs(home.x - cur.x) > 0.01 || Math.abs(home.y - cur.y) > 0.01 || Math.abs(home.scale - cur.scale) > 1e-4
      if (Math.hypot(v.x, v.y) > GLIDE_STOP) {
        const fx = glideStep(v.x, dt, outside ? 0.6 : 0.92),
          fy = glideStep(v.y, dt, outside ? 0.6 : 0.92)
        v = { x: fx.velocity, y: fy.velocity }
        show({ ...cur, x: cur.x + fx.distance, y: cur.y + fy.distance })
        return true
      }
      if (!outside) return false
      const scale = approach(cur.scale, home.scale, dt, 0.001)
      const k = scale / cur.scale
      const a = anchor.current
      // 倍数和位置一起收：先按回位的倍数以手指中点缩，再把位置往界内拉
      show({
        scale,
        x: approach(a.x - (a.x - cur.x) * k, home.x, dt),
        y: approach(a.y - (a.y - cur.y) * k, home.y, dt),
      })
      return true
    })
  }
  const cell = (p: Point) => cellAt(ensure(), p.x, p.y)
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x < grid.width && y < grid.height
  const touch = (kind: TouchKind, points: Point[]) => {
    const g = gesture.current
    if (kind === 'start') stop()
    const { width, height } = size.current
    if (points.length >= 2) {
      const [a, b] = points
      const mid = { id: 0, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
      tracker.current.push(Date.now(), mid.x, mid.y)
      anchor.current = mid
      if (g.kind !== 'two') {
        if (g.kind === 'one' && mode === 'draw') onCell?.('cancel', [0, 0])
        tracker.current.reset()
        gesture.current = { kind: 'two', moved: true, at: Date.now(), pinch: { d, mid, view: ensure() } }
        return
      }
      const p = g.pinch!
      const zoomed = zoomView(
        p.view,
        stretchScale((p.view.scale * d) / p.d, minScale()) / p.view.scale,
        p.mid.x,
        p.mid.y,
        0,
        Infinity,
      )
      show(
        stretchView({ ...zoomed, x: zoomed.x + mid.x - p.mid.x, y: zoomed.y + mid.y - p.mid.y }, grid, width, height),
      )
      return
    }
    if (kind === 'start' && points.length === 1) {
      const v = ensure()
      raw.current = { x: v.x, y: v.y }
      anchor.current = points[0]
      tracker.current.reset()
      tracker.current.push(Date.now(), points[0].x, points[0].y)
      gesture.current = { kind: 'one', start: points[0], last: points[0], moved: false, at: Date.now() }
      if (mode === 'draw') {
        const c = cell(points[0])
        if (inside(c)) onCell?.('start', c)
      }
      return
    }
    if (kind === 'move' && g.kind === 'one' && points.length === 1) {
      const p = points[0]
      if (Math.hypot(p.x - g.start!.x, p.y - g.start!.y) > 8) g.moved = true
      if (mode === 'draw') {
        const c = cell(p)
        if (inside(c)) onCell?.('move', c)
      } else {
        tracker.current.push(Date.now(), p.x, p.y)
        raw.current = { x: raw.current.x + p.x - g.last!.x, y: raw.current.y + p.y - g.last!.y }
        show(stretchView({ ...ensure(), ...raw.current }, grid, width, height))
      }
      g.last = p
      return
    }
    if (kind === 'end' && points.length === 0) {
      if (g.kind === 'one') {
        if (mode === 'draw') onCell?.('end', cell(g.last!))
        else if (!g.moved && Date.now() - g.at < 500) {
          const c = cell(g.start!)
          if (inside(c)) onTap?.(c)
        } else release(true)
      } else if (g.kind === 'two') release(true)
      gesture.current = { kind: 'none', moved: false, at: 0 }
    }
    // 两指松开一指：剩下那指不再算画，等全部松开；拖着的这下还在动就接着滑
    if (kind === 'end' && points.length === 1 && g.kind === 'two') {
      gesture.current = { kind: 'none', moved: true, at: 0 }
      release(true)
    }
  }
  return (
    <MakerCanvas
      id={id}
      className={className}
      version={version}
      handle={handle}
      layout={layout}
      onSize={(width, height) => {
        size.current = { width, height }
        fitted.current = ''
      }}
      draw={(ctx, width, height) => drawGrid(ctx, grid, palette, ensure(), width, height, options)}
      onTouch={touch}
    />
  )
}
