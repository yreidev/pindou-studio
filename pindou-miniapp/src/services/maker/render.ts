import type { Board } from './boards'
import { boardColors, boardsNeeded, finishedSize } from './boards'
import { lab } from './color'
import { rubberBand } from '../gesture'
import { EMPTY, beadCounts, isDone, type Grid } from './grid'
import type { Palette } from './palettes'

// 画图纸（docs/plan-bead-maker.md 第 1 节「改图」「边拼边看」「存相册」）：只用画布 2D 上下文里最基本的那几个方法，
// 小程序的 Canvas 2D 能画，单元测试用假的上下文数调用。
// 同色的格子按行连成一段、每种颜色一条路径一次填完：300×300 的图一帧也只有几十次填充。

export type Ctx = {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  globalAlpha: number
  font: string
  textAlign: string
  textBaseline: string
  fillRect(x: number, y: number, w: number, h: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  rect(x: number, y: number, w: number, h: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, start: number, end: number): void
  closePath(): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  save(): void
  restore(): void
}

/** 视图：每格多少像素、图纸左上角在画布上的位置。 */
export type View = { scale: number; x: number; y: number }

/** 让整张图放进 width×height 的画布，四周留 margin。 */
export function fitView(g: Grid, width: number, height: number, margin = 8): View {
  const scale = Math.max(0.5, Math.min((width - margin * 2) / g.width, (height - margin * 2) / g.height))
  return { scale, x: (width - g.width * scale) / 2, y: (height - g.height * scale) / 2 }
}

/** 双指缩放：以 (cx, cy) 为中心缩放 factor 倍，每格限在 2～64 像素。 */
export function zoomView(v: View, factor: number, cx: number, cy: number, min = 2, max = 64): View {
  const scale = Math.max(min, Math.min(max, v.scale * factor))
  const k = scale / v.scale
  return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
}

/**
 * 拖动的边界（docs/plan-interaction.md 第 4 节）：图比画布小时整张留在画布里，比画布大时不露出图外的空白；
 * 两种都多给 slack 像素的余地，边上的格子能拖到手指下面。
 */
export function viewBounds(g: Grid, scale: number, width: number, height: number, slack = 24) {
  const axis = (content: number, canvas: number): [number, number] =>
    content <= canvas ? [-slack, canvas - content + slack] : [canvas - content - slack, slack]
  const [minX, maxX] = axis(g.width * scale, width)
  const [minY, maxY] = axis(g.height * scale, height)
  return { minX, maxX, minY, maxY }
}

/** 拖动中拖出边界：超出的部分按橡皮筋阻尼，越往外越拖不动（最多再走画布的四分之一）。 */
export function stretchView(v: View, g: Grid, width: number, height: number): View {
  const b = viewBounds(g, v.scale, width, height)
  const axis = (p: number, lo: number, hi: number, size: number) =>
    p < lo ? lo + rubberBand(p - lo, size / 4) : p > hi ? hi + rubberBand(p - hi, size / 4) : p
  return { scale: v.scale, x: axis(v.x, b.minX, b.maxX, width), y: axis(v.y, b.minY, b.maxY, height) }
}

/** 捏合缩过上下限：超出的倍数按对数阻尼，松手再弹回上下限。 */
export function stretchScale(scale: number, min = 2, max = 64) {
  if (scale > max) return max * Math.exp(rubberBand(Math.log(scale / max), 0.3))
  if (scale < min) return min * Math.exp(rubberBand(Math.log(scale / min), 0.3))
  return scale
}

/** 松手后该回到哪：倍数收回上下限（以 (cx, cy) 为中心），位置收进边界。在界内就是原样。 */
export function settleView(
  v: View,
  g: Grid,
  width: number,
  height: number,
  cx: number,
  cy: number,
  min = 2,
  max = 64,
): View {
  const z = zoomView(v, 1, cx, cy, min, max)
  const b = viewBounds(g, z.scale, width, height)
  return {
    scale: z.scale,
    x: Math.max(b.minX, Math.min(b.maxX, z.x)),
    y: Math.max(b.minY, Math.min(b.maxY, z.y)),
  }
}

/** 画布上一点落在哪一格（可能在图外）。 */
export const cellAt = (v: View, px: number, py: number): [number, number] => [
  Math.floor((px - v.x) / v.scale),
  Math.floor((py - v.y) / v.scale),
]

const hexCache = new Map<string, string>()
/** 格子上的字用黑还是白（看底色亮度）。 */
export function inkOn(hex: string) {
  let ink = hexCache.get(hex)
  if (!ink) {
    ink = lab(parseInt(hex.slice(1), 16)).l > 60 ? '#25231f' : '#ffffff'
    hexCache.set(hex, ink)
  }
  return ink
}

export type DrawOptions = {
  /** 底色（图外和空格子） */
  background: string
  /** 空格子的颜色（编辑时比底色稍深一点，看得出哪里没豆子） */
  emptyColor?: string
  /** 格线颜色，不给不画 */
  gridColor?: string
  /** 只亮这一种颜色（序号），其余调暗 */
  highlight?: number
  /** 只亮这一行 */
  row?: number
  /** 只画这一块板（其余调暗） */
  board?: Board
  /** 拼完的格子画个圆点 */
  done?: Uint8Array
  /** 锁住的格子画把小锁 */
  locked?: Uint8Array
  /** 格子够大时写色号 */
  codes?: boolean
  /** 选区、形状预览（格子序号） */
  preview?: { cells: readonly number[]; color: string }
  selection?: { x: number; y: number; w: number; h: number }
}

/** 画在 width×height 的画布上。palette 给出色号的颜色。 */
export function drawGrid(ctx: Ctx, g: Grid, palette: Palette, v: View, width: number, height: number, o: DrawOptions) {
  ctx.fillStyle = o.background
  ctx.fillRect(0, 0, width, height)
  const s = v.scale
  const x0 = Math.max(0, Math.floor(-v.x / s)),
    y0 = Math.max(0, Math.floor(-v.y / s))
  const x1 = Math.min(g.width, Math.ceil((width - v.x) / s)),
    y1 = Math.min(g.height, Math.ceil((height - v.y) / s))
  if (x1 <= x0 || y1 <= y0) return
  const hex = g.colors.map((code) => palette.colors[palette.index.get(code) ?? 0]?.hex ?? '#000000')
  // 图纸范围的底（空格子）
  ctx.fillStyle = o.emptyColor ?? o.background
  ctx.fillRect(v.x + x0 * s, v.y + y0 * s, (x1 - x0) * s, (y1 - y0) * s)
  const dim = (x: number, y: number, c: number) =>
    (o.highlight !== undefined && c !== o.highlight) ||
    (o.row !== undefined && y !== o.row) ||
    (o.board !== undefined &&
      (x < o.board.x || x >= o.board.x + o.board.w || y < o.board.y || y >= o.board.y + o.board.h))
  const paths: { dimmed: boolean }[] = [{ dimmed: false }, { dimmed: true }]
  for (const pass of paths) {
    ctx.globalAlpha = pass.dimmed ? 0.18 : 1
    for (let c = 0; c < g.colors.length; c++) {
      let any = false
      for (let y = y0; y < y1; y++) {
        let x = x0
        while (x < x1) {
          const i = y * g.width + x
          if (g.cells[i] !== c || dim(x, y, c) !== pass.dimmed) {
            x++
            continue
          }
          let end = x + 1
          while (end < x1 && g.cells[y * g.width + end] === c && dim(end, y, c) === pass.dimmed) end++
          if (!any) {
            ctx.beginPath()
            any = true
          }
          // 多画半像素，免得缩小时格子之间露出细缝
          ctx.rect(v.x + x * s, v.y + y * s, (end - x) * s + 0.5, s + 0.5)
          x = end
        }
      }
      if (any) {
        ctx.fillStyle = hex[c]
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1
  if (o.gridColor && s >= 5) drawLines(ctx, v, x0, y0, x1, y1, o.gridColor, s >= 12)
  // 拼完的圆点、锁、色号：格子够大才画
  if (s >= 8 && (o.done || o.locked || (o.codes && s >= 22))) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `${Math.round(Math.min(14, s * 0.36))}px sans-serif`
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * g.width + x,
          c = g.cells[i]
        const cx = v.x + (x + 0.5) * s,
          cy = v.y + (y + 0.5) * s
        if (c !== EMPTY && o.done && isDone(o.done, i)) {
          ctx.fillStyle = inkOn(hex[c])
          ctx.beginPath()
          ctx.arc(cx, cy, s * 0.18, 0, Math.PI * 2)
          ctx.fill()
        } else if (c !== EMPTY && o.codes && s >= 22 && !dim(x, y, c)) {
          ctx.fillStyle = inkOn(hex[c])
          ctx.fillText(g.colors[c], cx, cy)
        }
        if (o.locked?.[i]) drawLock(ctx, v.x + x * s, v.y + y * s, s, c === EMPTY ? '#706b62' : inkOn(hex[c]))
      }
  }
  if (o.preview?.cells.length) {
    ctx.fillStyle = o.preview.color
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    for (const i of o.preview.cells) ctx.rect(v.x + (i % g.width) * s, v.y + Math.floor(i / g.width) * s, s, s)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  if (o.selection) {
    const r = o.selection
    ctx.strokeStyle = '#b49763'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(v.x + r.x * s, v.y + r.y * s, r.w * s, r.h * s)
    ctx.stroke()
  }
}

function drawLines(ctx: Ctx, v: View, x0: number, y0: number, x1: number, y1: number, color: string, every: boolean) {
  const s = v.scale
  ctx.strokeStyle = color
  for (const thick of [false, true]) {
    if (!thick && !every) continue
    ctx.lineWidth = thick ? 1.5 : 0.5
    ctx.beginPath()
    for (let x = x0; x <= x1; x++) {
      if ((x % 10 === 0) !== thick) continue
      ctx.moveTo(v.x + x * s, v.y + y0 * s)
      ctx.lineTo(v.x + x * s, v.y + y1 * s)
    }
    for (let y = y0; y <= y1; y++) {
      if ((y % 10 === 0) !== thick) continue
      ctx.moveTo(v.x + x0 * s, v.y + y * s)
      ctx.lineTo(v.x + x1 * s, v.y + y * s)
    }
    ctx.stroke()
  }
}

/** 一把小锁：锁身是方块，锁梁是半圆。 */
function drawLock(ctx: Ctx, x: number, y: number, s: number, color: string) {
  const w = s * 0.34
  const left = x + s - w - s * 0.08,
    top = y + s * 0.1
  ctx.fillStyle = color
  ctx.fillRect(left, top + w * 0.45, w, w * 0.6)
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, s * 0.05)
  ctx.beginPath()
  ctx.arc(left + w / 2, top + w * 0.45, w * 0.32, Math.PI, 0)
  ctx.stroke()
}

// —— 存相册的图纸图片 ——

export type ExportInfo = {
  name: string
  /** 「2026-10-21」 */
  date: string
  storeName: string
  beadMm: number
  boardSize: number
  /** 色号 → 盒号（色卡是店里那套时才给） */
  boxes?: Record<string, string>
}

/** 图片的排版：每格多大、整张多大。长边不超过 4000 像素（手机画布太大会画不出来，未在真机上核对上限）。 */
export function exportLayout(g: Grid, legendColors: number) {
  const cell = Math.max(10, Math.min(40, Math.floor(3000 / Math.max(g.width, g.height))))
  const ruler = cell >= 18 ? 28 : 24
  const pad = 32
  const gridW = g.width * cell,
    gridH = g.height * cell
  const width = Math.max(gridW + ruler * 2 + pad * 2, 720)
  const legendColumns = Math.max(2, Math.floor((width - pad * 2) / 220))
  const legendRows = Math.ceil(legendColors / legendColumns)
  const header = 96
  const legendTop = header + gridH + ruler * 2 + 24
  const height = legendTop + 48 + legendRows * 44 + 24 + 88
  return {
    cell,
    ruler,
    pad,
    width,
    height,
    header,
    legendTop,
    legendColumns,
    gridLeft: (width - gridW) / 2,
    gridTop: header + ruler,
  }
}

/** 色号太长（国外的 8 位编号）时格子里写序号，清单里对照。 */
export const longCodes = (g: Grid) => g.colors.some((code) => code.length > 3)

export function drawExport(ctx: Ctx, g: Grid, palette: Palette, info: ExportInfo) {
  const counts = boardColors(g, new Uint8Array(Math.ceil(g.cells.length / 8)))
  const L = exportLayout(g, counts.length)
  const hex = g.colors.map((code) => palette.colors[palette.index.get(code) ?? 0]?.hex ?? '#000000')
  const serial = new Map(counts.map((c, k) => [c.index, String(k + 1)]))
  const numbered = longCodes(g)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, L.width, L.height)
  // 先画格子（drawGrid 会把格子上面那片也涂成底色），再写标题和坐标
  const s = L.cell
  const view = { scale: s, x: L.gridLeft, y: L.gridTop }
  drawGrid(ctx, g, palette, view, L.width, L.gridTop + g.height * s, { background: '#ffffff', emptyColor: '#ffffff' })
  ctx.textBaseline = 'middle'
  // 标题
  ctx.fillStyle = '#25231f'
  ctx.textAlign = 'left'
  ctx.font = 'bold 36px sans-serif'
  ctx.fillText(info.name, L.pad, 40)
  ctx.font = '20px sans-serif'
  ctx.fillStyle = '#706b62'
  ctx.fillText(`${g.width}×${g.height} 格 · ${beadCounts(g).beads} 颗 · ${palette.name}`, L.pad, 76)
  // 坐标
  ctx.font = `${Math.min(16, Math.max(11, s * 0.5))}px sans-serif`
  ctx.textAlign = 'center'
  const step = s >= 18 ? 1 : s >= 12 ? 5 : 10
  for (let x = 0; x < g.width; x++) {
    if ((x + 1) % step && x !== 0) continue
    const cx = L.gridLeft + (x + 0.5) * s
    ctx.fillText(String(x + 1), cx, L.gridTop - L.ruler / 2)
    ctx.fillText(String(x + 1), cx, L.gridTop + g.height * s + L.ruler / 2)
  }
  for (let y = 0; y < g.height; y++) {
    if ((y + 1) % step && y !== 0) continue
    const cy = L.gridTop + (y + 0.5) * s
    ctx.fillText(String(y + 1), L.gridLeft - L.ruler / 2, cy)
    ctx.fillText(String(y + 1), L.gridLeft + g.width * s + L.ruler / 2, cy)
  }
  // 格线（每 10 格一条粗线）、格内色号
  drawLines(ctx, view, 0, 0, g.width, g.height, '#8b8375', true)
  if (s >= 18) {
    ctx.font = `${Math.round(s * (numbered ? 0.42 : 0.36))}px sans-serif`
    ctx.textAlign = 'center'
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) {
        const c = g.cells[y * g.width + x]
        if (c === EMPTY) continue
        ctx.fillStyle = inkOn(hex[c])
        ctx.fillText(numbered ? serial.get(c)! : g.colors[c], L.gridLeft + (x + 0.5) * s, L.gridTop + (y + 0.5) * s)
      }
  }
  // 用豆清单
  ctx.textAlign = 'left'
  ctx.fillStyle = '#25231f'
  ctx.font = 'bold 24px sans-serif'
  ctx.fillText(`用豆清单 · ${counts.length} 色 · ${beadCounts(g).beads} 颗`, L.pad, L.legendTop + 18)
  const colW = (L.width - L.pad * 2) / L.legendColumns
  counts.forEach((c, k) => {
    const col = k % L.legendColumns,
      row = Math.floor(k / L.legendColumns)
    const x = L.pad + col * colW,
      y = L.legendTop + 48 + row * 44
    ctx.fillStyle = hex[c.index]
    ctx.fillRect(x, y + 4, 32, 32)
    ctx.strokeStyle = '#e4ddcf'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.rect(x, y + 4, 32, 32)
    ctx.stroke()
    ctx.fillStyle = '#25231f'
    ctx.font = '18px sans-serif'
    const box = info.boxes?.[c.code]
    ctx.fillText(
      `${numbered ? serial.get(c.index) + ' = ' : ''}${c.code}  ${c.count} 颗${box ? ` · ${box}号盒` : ''}`,
      x + 42,
      y + 20,
    )
  })
  // 底部：成品大小、店名
  const size = finishedSize(g, info.beadMm)
  const bottom = L.height - 88
  ctx.fillStyle = '#706b62'
  ctx.font = '18px sans-serif'
  ctx.fillText(
    `成品约 ${size.width}×${size.height} 厘米（${info.beadMm} 毫米豆）· ${info.boardSize} 格板 ${boardsNeeded(g, info.boardSize)} 块`,
    L.pad,
    bottom + 16,
  )
  ctx.fillStyle = '#25231f'
  ctx.font = 'bold 20px sans-serif'
  ctx.fillText(info.storeName, L.pad, bottom + 52)
  ctx.fillStyle = '#706b62'
  ctx.font = '16px sans-serif'
  ctx.fillText(`小程序「做图纸」做的 · ${info.date}`, L.pad, bottom + 76)
}
