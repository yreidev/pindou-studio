import { oklabInto } from './color'
import { cleanup } from './cleanup'
import { keepDots } from './dots'
import { EMPTY, type Grid } from './grid'
import { resize, smooth, type Pixels } from './image'
import { wholeImage, type Step } from './mrf'
import type { Palette } from './palettes'
import { choose, sample } from './quantize'

// 「描边」画风（docs/plan-bead-maker.md 第 3 节 2，2026-10-21 业主同意加，默认仍是卡通）：照片 → 平涂色块 + 一格宽的深色描边，
// 像人画的拼豆图纸。适合 3D 表情、毛绒玩具、扁平卡通、宠物；真人照片五官会被抹平、本来就有描边的动漫图会线叠线。
// 1. 在每格 S×S 像素的分辨率上做两次保边平滑，毛、草这类纹理抹平，轮廓留着；
// 2. 在平滑后的图上按 OKLab 颜色梯度找边（Di Zenzo 结构张量 + 非极大值抑制 + 双阈值），透明度的跳变也算边；
// 3. 一格里边像素够多才算「边格」，细化成一格宽、斜着相连的线（Zhang–Suen），去掉短碎线和 L 形拐角上多出来的那格；
//    透明底的图沿最外一圈描；
// 4. 色块按平滑后的图取色、挑色（比颜色上限少两种，留给描边），整张配色（λ 比别的画风大一倍，并得更狠）、清零星，
//    小黑点照样保住；里面的线只画在两边颜色差得够多的地方，不把细的色条整条盖掉；
// 5. 描边格的颜色取它旁边最深的那块颜色再压暗一档，配到色卡上，最多两种描边色。

export type OutlineParams = {
  /** 找边用的分辨率：每格几像素（大图按比例少一点，找边的图长边不超过 1600） */
  S: number
  /** 平滑几遍、半径 */
  passes: number
  radius: number
  /** 双阈值（OKLab 每像素的梯度） */
  high: number
  low: number
  /** 一格里至少几个边像素才算边格 */
  minEdgePixels: number
  /** 短于这么多格的线段去掉 */
  minSegment: number
  /** 描边压暗到原来亮度的几成 */
  darken: number
  /** 色块整张配色的 λ */
  lambda: number
  /** 里面的线只画在两边色块差得够多（OKLab × 100）的地方 */
  innerContrast: number
  /** 一块颜色有超过这么多被线盖住，就不在它上面画里面的线（保住细的色条，比如眼睛周围的黄圈） */
  thinShare: number
  /** 色块每多一种颜色的罚 */
  labelCost: number
}

export const outlineDefaults: OutlineParams = {
  S: 6,
  passes: 2,
  radius: 2,
  high: 0.1,
  low: 0.05,
  minEdgePixels: 3,
  minSegment: 4,
  darken: 0.45,
  lambda: 60,
  innerContrast: 25,
  thinShare: 0.5,
  labelCost: 1000,
}

export type OutlineOptions = {
  cols: number
  rows: number
  palette: Palette
  allowed?: readonly number[]
  maxColors: number
  /** 色块清零星的颗数下限（0、1 是不清） */
  minCluster: number
}

export async function outline(view: Pixels, o: OutlineOptions, step: Step, params: Partial<OutlineParams> = {}) {
  const P = { ...outlineDefaults, ...params }
  const { cols, rows } = o
  const S = Math.max(3, Math.min(P.S, Math.floor(1600 / Math.max(cols, rows))))
  let flat = resize(view, cols * S, rows * S)
  for (let k = 0; k < P.passes; k++) {
    flat = smooth(flat, P.radius)
    await step()
  }
  // 边格
  const e = edges(flat, P.high, P.low)
  const W = flat.width
  const cellEdge = new Uint8Array(cols * rows)
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      let c = 0
      for (let y = cy * S; y < (cy + 1) * S; y++) for (let x = cx * S; x < (cx + 1) * S; x++) c += e[y * W + x]
      cellEdge[cy * cols + cx] = c >= P.minEdgePixels ? 1 : 0
    }
  const inner = tidy(thin(cellEdge, cols, rows), cols, rows, P.minSegment)
  await step()
  // 色块
  const s = sample(resize(flat, cols * 4, rows * 4), cols, rows, false)
  // 小黑点按没平滑的图找（平滑会把瞳孔抹淡）
  keepDots(resize(view, cols * 4, rows * 4), s)
  // 外轮廓：最外一圈不透明的格子（四邻有空格子的），不靠找边，免得落在半透明的格子上断成虚线
  const line = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (!s.opaque[i]) continue
      const out = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < cols && yy < rows && !s.opaque[yy * cols + xx]
      if (out(x - 1, y) || out(x + 1, y) || out(x, y - 1) || out(x, y + 1) || inner[i]) line[i] = 1
    }
  line.set(tidy(line, cols, rows, P.minSegment))
  await step()
  // 色块先不管线，整张配色、清零星，再决定线画在哪
  const first = choose(s, { palette: o.palette, allowed: o.allowed, maxColors: Math.max(2, o.maxColors - 2) })
  await step()
  let g = await wholeImage(
    s,
    first,
    o.palette,
    { lambda: P.lambda, labelCost: P.labelCost, lineHold: 10, okMix: 0, cycles: 4, pruneFirst: false },
    step,
  )
  if (o.minCluster > 1) g = cleanup(g, o.palette, { minSize: o.minCluster, locked: s.lines }).grid
  filterLines(g, line, cols, rows, P, o.palette)
  return lineColors(g, line, cols, rows, P, o)
}

/** 描边色：旁边最深的那块颜色压暗一档，配到色卡上（只在能用的颜色里），最多两种。 */
function lineColors(g: Grid, line: Uint8Array, cols: number, rows: number, P: OutlineParams, o: OutlineOptions): Grid {
  const p = o.palette
  const lab = new Float64Array(3)
  const cellOk = (i: number) => {
    const c = p.colors[p.index.get(g.colors[g.cells[i]])!]
    oklabInto((c.rgb >> 16) & 255, (c.rgb >> 8) & 255, c.rgb & 255, lab)
    return [lab[0], lab[1], lab[2]]
  }
  const want = new Map<number, number[]>()
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (!line[i] || g.cells[i] === EMPTY) continue
      let dark: number[] | undefined
      for (const [dx, dy] of N8) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        if (line[j] || g.cells[j] === EMPTY) continue
        const c = cellOk(j)
        if (!dark || c[0] < dark[0]) dark = c
      }
      const own = cellOk(i)
      if (!dark) dark = own
      const target = [dark[0] * P.darken, dark[1] * 0.8, dark[2] * 0.8]
      want.set(i, own[0] < target[0] ? own : target)
    }
  const candidates = o.allowed?.length ? [...o.allowed] : p.colors.map((_, k) => k)
  const dist = (k: number, t: ArrayLike<number>) =>
    (t[0] - p.oklab[k * 3]) ** 2 + (t[1] - p.oklab[k * 3 + 1]) ** 2 + (t[2] - p.oklab[k * 3 + 2]) ** 2
  const nearestBead = (t: number[]) => {
    let best = candidates[0],
      bd = Infinity
    for (const k of candidates) {
      const d = dist(k, t)
      if (d < bd) {
        bd = d
        best = k
      }
    }
    return best
  }
  const pick = new Map<number, number>()
  const freq = new Map<number, number>()
  for (const [i, t] of want) {
    const b = nearestBead(t)
    pick.set(i, b)
    freq.set(b, (freq.get(b) ?? 0) + 1)
  }
  const keep = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([b]) => b)
  const colors = [...g.colors]
  const cells = g.cells.slice()
  for (const [i, b] of pick) {
    const bLab = p.oklab.subarray(b * 3, b * 3 + 3)
    const k = keep.length > 1 && dist(keep[1], bLab) < dist(keep[0], bLab) ? keep[1] : keep[0]
    const code = p.colors[k].code
    let slot = colors.indexOf(code)
    if (slot < 0) {
      slot = colors.length
      colors.push(code)
    }
    cells[i] = slot
  }
  return { ...g, colors, cells }
}

function blur1(ch: Float32Array, w: number, h: number) {
  // 3×3 近似高斯（σ≈0.85）
  const k = [0.25, 0.5, 0.25]
  const tmp = new Float32Array(w * h),
    out = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -1; i <= 1; i++) s += k[i + 1] * ch[y * w + Math.min(w - 1, Math.max(0, x + i))]
      tmp[y * w + x] = s
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let i = -1; i <= 1; i++) s += k[i + 1] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]
      out[y * w + x] = s
    }
  return out
}

/** 边像素（Canny 式）：返回每像素 0/1。 */
function edges(img: Pixels, high: number, low: number): Uint8Array {
  const { width: w, height: h, data } = img
  const n = w * h
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const lab = new Float64Array(3)
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255
    oklabInto(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], lab)
    // 透明处颜色不算数：按透明度往底板的浅灰拉，透明度本身另算一个通道
    ch[0][i] = lab[0] * a + 0.94 * (1 - a)
    ch[1][i] = lab[1] * a
    ch[2][i] = lab[2] * a
    ch[3][i] = a
  }
  const sm = ch.map((c) => blur1(c, w, h))
  const mag = new Float32Array(n),
    dir = new Float32Array(n)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let gxx = 0,
        gyy = 0,
        gxy = 0
      for (let c = 0; c < 4; c++) {
        const s = sm[c]
        const at = (dx: number, dy: number) => s[(y + dy) * w + x + dx]
        const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / 8
        const gy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / 8
        const wgt = c === 3 ? 0.5 : 1
        gxx += wgt * gx * gx
        gyy += wgt * gy * gy
        gxy += wgt * gx * gy
      }
      const tr = gxx + gyy,
        det = gxx * gyy - gxy * gxy
      const lmax = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
      mag[y * w + x] = Math.sqrt(lmax)
      dir[y * w + x] = 0.5 * Math.atan2(2 * gxy, gxx - gyy)
    }
  // 非极大值抑制
  const nms = new Float32Array(n)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const m = mag[i]
      if (m < low) continue
      const dx = Math.round(Math.cos(dir[i])),
        dy = Math.round(Math.sin(dir[i]))
      if (m >= mag[(y + dy) * w + x + dx] && m >= mag[(y - dy) * w + x - dx]) nms[i] = m
    }
  // 双阈值：强边，以及和强边连着的弱边
  const out = new Uint8Array(n)
  const stack: number[] = []
  for (let i = 0; i < n; i++)
    if (nms[i] >= high && !out[i]) {
      out[i] = 1
      stack.push(i)
      while (stack.length) {
        const j = stack.pop()!
        const x = j % w,
          y = (j / w) | 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx,
              yy = y + dy
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
            const k = yy * w + xx
            if (!out[k] && nms[k] >= low) {
              out[k] = 1
              stack.push(k)
            }
          }
      }
    }
  return out
}

const N8 = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

/** Zhang–Suen 细化：把格子上的边细成一格宽。 */
function thin(mask: Uint8Array, w: number, h: number) {
  const m = mask.slice()
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x])
  let changed = true
  while (changed) {
    changed = false
    for (const step of [0, 1]) {
      const del: number[] = []
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue
          const p = N8.map(([dx, dy]) => get(x + dx, y + dy))
          const B = p.reduce((a, b) => a + b, 0)
          if (B < 2 || B > 6) continue
          let A = 0
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) A++
          if (A !== 1) continue
          if (step === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue
          del.push(y * w + x)
        }
      for (const i of del) m[i] = 0
      if (del.length) changed = true
    }
  }
  return m
}

/** 去掉 L 形拐角多出来的格子（两个相邻方向都是线、对角不是）、短于 minSegment 的线段。 */
function tidy(mask: Uint8Array, w: number, h: number, minSegment: number) {
  const m = mask.slice()
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x])
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      const n = get(x, y - 1),
        e = get(x + 1, y),
        s = get(x, y + 1),
        wv = get(x - 1, y)
      const count = N8.reduce((a, [dx, dy]) => a + get(x + dx, y + dy), 0)
      if (count !== 2) continue
      if (
        (n && e && !get(x + 1, y - 1)) ||
        (e && s && !get(x + 1, y + 1)) ||
        (s && wv && !get(x - 1, y + 1)) ||
        (wv && n && !get(x - 1, y - 1))
      )
        m[y * w + x] = 0
    }
  const seen = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || seen[i]) continue
    const comp: number[] = []
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const j = stack.pop()!
      comp.push(j)
      const x = j % w,
        y = (j / w) | 0
      for (const [dx, dy] of N8) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
        const k = yy * w + xx
        if (m[k] && !seen[k]) {
          seen[k] = 1
          stack.push(k)
        }
      }
    }
    if (comp.length < minSegment) for (const j of comp) m[j] = 0
  }
  return m
}

/** 里面的线要压在两种差得够多的颜色交界上，而且不能把一整条细色块盖掉；外轮廓照留。 */
function filterLines(g: Grid, line: Uint8Array, cols: number, rows: number, P: OutlineParams, p: Palette) {
  const ok = (i: number) =>
    p.oklab.subarray(p.index.get(g.colors[g.cells[i]])! * 3, p.index.get(g.colors[g.cells[i]])! * 3 + 3)
  const outer = (i: number) => {
    const x = i % cols,
      y = (i / cols) | 0
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const xx = x + dx,
        yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && g.cells[yy * cols + xx] === EMPTY) return true
    }
    return false
  }
  // 两边差得够不够
  for (let i = 0; i < line.length; i++) {
    if (!line[i] || g.cells[i] === EMPTY || outer(i)) continue
    const x = i % cols,
      y = (i / cols) | 0
    let most = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        if (g.cells[j] === EMPTY) continue
        // 和 3×3 里任意两格的差都算（线压在交界上时，交界两边的格子可能都不是它自己）
        for (let ey = -1; ey <= 1; ey++)
          for (let ex = -1; ex <= 1; ex++) {
            const x2 = x + ex,
              y2 = y + ey
            if (x2 < 0 || y2 < 0 || x2 >= cols || y2 >= rows) continue
            const k = y2 * cols + x2
            if (g.cells[k] === EMPTY || g.cells[k] === g.cells[j]) continue
            const b = ok(j),
              c = ok(k)
            const d = Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]) * 100
            if (d > most) most = d
          }
      }
    if (most < P.innerContrast) line[i] = 0
  }
  // 细色块：一块（8 邻接同色）里被线盖住的格子超过 thinShare，这块上的里线都不画（外轮廓照画）
  {
    const comp = new Int32Array(line.length).fill(-1)
    const size: number[] = [],
      covered: number[] = []
    for (let i = 0; i < line.length; i++) {
      if (g.cells[i] === EMPTY || comp[i] >= 0) continue
      const id = size.length
      size.push(0)
      covered.push(0)
      const stack = [i]
      comp[i] = id
      while (stack.length) {
        const j = stack.pop()!
        size[id]++
        if (line[j]) covered[id]++
        const x = j % cols,
          y = (j / cols) | 0
        for (const [dx, dy] of N8) {
          const xx = x + dx,
            yy = y + dy
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
          const k = yy * cols + xx
          if (comp[k] < 0 && g.cells[k] === g.cells[j]) {
            comp[k] = id
            stack.push(k)
          }
        }
      }
    }
    for (let i = 0; i < line.length; i++) {
      if (!line[i] || g.cells[i] === EMPTY || outer(i)) continue
      const id = comp[i]
      // 本来就深的细色块（深色条纹、本来的描边）照画
      if (ok(i)[0] < 0.35) continue
      if (covered[id] > size[id] * P.thinShare) line[i] = 0
    }
  }
}
