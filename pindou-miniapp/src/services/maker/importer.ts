import { borderColors } from './background'
import { deltaE, lab, oklabInto } from './color'
import { EMPTY, MAX_COLORS, MAX_SIDE, MIN_SIDE, type Grid } from './grid'
import type { Pixels } from './image'
import type { Palette } from './palettes'
import { choose } from './quantize'
import { recognize } from './recognize'

// 导入像素画、图纸截图（docs/plan-bead-maker.md 第 3 节 6）：一格一颗原样导入，不重新缩小。
// 1. 认格子：交给 recognize()（services/maker/recognize.ts）。它先按长边缘挑出格线、
//    再定周期、精修、数线得格数，两个方向互相校验。认不准时顾客加减格数、
//    拖两个角对齐（页面上做），这里只给第一次的猜测。
// 2. 读格子：每格取中间一半区域的颜色中位数（避开格线和格边上的色号字），和四边背景同色、又和边上连成一片的格子算空，
//    其余对到色卡上最接近的色号（CIEDE2000）；超过 64 种时按生成时的办法挑 64 种。

export type Detected = { x: number; y: number; w: number; h: number; cols: number; rows: number }

/** 认出截图里的格子：范围（像素）和格数。 */
export function detect(img: Pixels): Detected {
  const r = recognize(img)
  const clamp = (n: number) => Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(n)))
  if (!r) return { x: 0, y: 0, w: img.width, h: img.height, cols: clamp(img.width / 16), rows: clamp(img.height / 16) }
  return { x: r.x, y: r.y, w: r.w, h: r.h, cols: clamp(r.cols), rows: clamp(r.rows) }
}

const median = (v: number[]) => {
  v.sort((a, b) => a - b)
  return v[v.length >> 1]
}

/** 按认好的格子读出每格的颜色，对到色卡上。allowed 是能用的颜色（色卡序号），不给就是整套。 */
export function readCells(img: Pixels, d: Detected, palette: Palette, allowed?: readonly number[]): Grid {
  const { width: w, data } = img
  const n = d.cols * d.rows
  const rgb = new Int32Array(n).fill(-1)
  const cw = d.w / d.cols,
    ch = d.h / d.rows
  const r: number[] = [],
    g: number[] = [],
    b: number[] = []
  for (let cy = 0; cy < d.rows; cy++)
    for (let cx = 0; cx < d.cols; cx++) {
      r.length = g.length = b.length = 0
      let total = 0
      const xa = Math.floor(d.x + (cx + 0.25) * cw),
        xb = Math.max(xa + 1, Math.ceil(d.x + (cx + 0.75) * cw))
      const ya = Math.floor(d.y + (cy + 0.25) * ch),
        yb = Math.max(ya + 1, Math.ceil(d.y + (cy + 0.75) * ch))
      for (let y = ya; y < Math.min(yb, img.height); y++)
        for (let x = xa; x < Math.min(xb, w); x++) {
          total++
          const i = (y * w + x) * 4
          if (data[i + 3] < 128) continue
          r.push(data[i])
          g.push(data[i + 1])
          b.push(data[i + 2])
        }
      if (!r.length || r.length * 2 <= total) continue
      rgb[cy * d.cols + cx] = (median(r) << 16) | (median(g) << 8) | median(b)
    }
  // 和背景同色、和边上连成一片的格子算空
  const bg = borderColors(img)
  const ok = new Float64Array(3)
  const isBackground = (c: number) => {
    if (c < 0) return true
    oklabInto((c >> 16) & 255, (c >> 8) & 255, c & 255, ok)
    return bg.some((s) => (s[0] - ok[0]) ** 2 + (s[1] - ok[1]) ** 2 + (s[2] - ok[2]) ** 2 < 0.05 * 0.05)
  }
  const empty = new Uint8Array(n)
  const stack: number[] = []
  const visit = (i: number) => {
    if (empty[i] || !isBackground(rgb[i])) return
    empty[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < d.cols; x++) {
    visit(x)
    visit((d.rows - 1) * d.cols + x)
  }
  for (let y = 0; y < d.rows; y++) {
    visit(y * d.cols)
    visit(y * d.cols + d.cols - 1)
  }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % d.cols,
      y = (i / d.cols) | 0
    if (x > 0) visit(i - 1)
    if (x < d.cols - 1) visit(i + 1)
    if (y > 0) visit(i - d.cols)
    if (y < d.rows - 1) visit(i + d.cols)
  }
  for (let i = 0; i < n; i++) if (rgb[i] < 0) empty[i] = 1

  // 每种颜色对到色卡：OKLab 最近的 6 种里按 CIEDE2000 选
  const set = allowed?.length ? allowed : palette.colors.map((_, i) => i)
  const match = new Map<number, number>()
  const nearestCode = (c: number) => {
    const hit = match.get(c)
    if (hit !== undefined) return hit
    oklabInto((c >> 16) & 255, (c >> 8) & 255, c & 255, ok)
    const ranked = set
      .map(
        (k) =>
          [
            k,
            (palette.oklab[k * 3] - ok[0]) ** 2 +
              (palette.oklab[k * 3 + 1] - ok[1]) ** 2 +
              (palette.oklab[k * 3 + 2] - ok[2]) ** 2,
          ] as const,
      )
      .sort((x, y) => x[1] - y[1])
      .slice(0, 6)
    const target = lab(c)
    let best = ranked[0][0],
      bd = Infinity
    for (const [k] of ranked) {
      const e = deltaE(target, palette.colors[k].lab)
      if (e < bd) {
        bd = e
        best = k
      }
    }
    match.set(c, best)
    return best
  }
  const picked = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) if (!empty[i]) picked[i] = nearestCode(rgb[i])
  const used = [...new Set(picked)].filter((k) => k >= 0)
  if (used.length > MAX_COLORS) {
    // 颜色太多（多半不是像素画，是照片）：按生成时的办法挑
    const color = new Float32Array(n * 3)
    const opaque = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (empty[i]) continue
      opaque[i] = 1
      oklabInto((rgb[i] >> 16) & 255, (rgb[i] >> 8) & 255, rgb[i] & 255, color, i * 3)
    }
    return choose({ cols: d.cols, rows: d.rows, color, opaque }, { palette, allowed, maxColors: MAX_COLORS })
  }
  const count = new Map<number, number>()
  for (const k of picked) if (k >= 0) count.set(k, (count.get(k) ?? 0) + 1)
  const order = used.sort((x, y) => count.get(y)! - count.get(x)! || x - y)
  const slot = new Map(order.map((k, i) => [k, i]))
  return {
    width: d.cols,
    height: d.rows,
    palette: palette.id,
    colors: order.map((k) => palette.colors[k].code),
    cells: Uint8Array.from(picked, (k) => (k < 0 ? EMPTY : slot.get(k)!)),
  }
}
