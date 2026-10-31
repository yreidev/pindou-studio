import { deltaE, lab, oklabInto, oklabToRgb, okDistance2 } from './color'
import { EMPTY, type Grid } from './grid'
import type { Pixels } from './image'
import type { Palette } from './palettes'

// 照片 → 格子（docs/plan-bead-maker.md 第 3 节 1、2）。
//
// 1. 取主色、保细线：每格的像素在 OKLab 里分成两簇，取占多数那簇的平均色——直接平均会把黑色描边和旁边的颜色混成褐灰。
//    少数那簇明显更暗（或更亮）、而且和邻格连成线的，这一格取少数那簇：描边、眼睛、胡须就不会断。
//    线正好压在两格交界时两格都会想取线色，线就变两格粗；这时只留线的像素多的那一格。
//    少数那簇只是旁边一片同色的边（色块边上的格子、线本身占多数的格子里线两旁的底色）时不取，不然色块胖一圈、线被底色吃掉。
// 2. 整张一起挑颜色：每格先配色卡里最近的颜色；多于上限时，每次去掉「去掉后总误差增加最少」的那种
//    （误差按 OKLab 距离的平方再加一个四次方项算：差得越多罚得越重，一两格但很显眼的颜色——比如眼睛的白色高光——
//    去掉的代价比一大片渐变里并掉一档还大，会留下来；只按平方算的话一格高光敌不过几十格的小误差），
//    然后按剩下的颜色做几轮 k-means，中心吸附回色卡里的颜色；最后每格在最近的三种里按 CIEDE2000 选。

/** 每格的取色结果：OKLab 三个数一组；opaque 为 0 的格子是空的；lines 不为 0 的格子取的是细线（少数那簇）的颜色，1 是暗线、2 是亮线。 */
export type Samples = { cols: number; rows: number; color: Float32Array; opaque: Uint8Array; lines?: Uint8Array }

type Minor = { color: Float32Array; share: Float32Array; dx: Float32Array; dy: Float32Array; has: Uint8Array }

/** 按格取色。img 应该已经缩到大约「格数 × 4」（每格 4×4 个像素）。 */
export function sample(img: Pixels, cols: number, rows: number, keepLines = true): Samples {
  const n = cols * rows
  const color = new Float32Array(n * 3)
  const opaque = new Uint8Array(n)
  const minor: Minor = {
    color: new Float32Array(n * 3),
    share: new Float32Array(n),
    dx: new Float32Array(n),
    dy: new Float32Array(n),
    has: new Uint8Array(n),
  }
  // 一格最多多少像素
  const most = (Math.ceil(img.width / cols) + 1) * (Math.ceil(img.height / rows) + 1)
  const px = new Float32Array(most * 3)
  const pos = new Float32Array(most * 2)
  const groups = new Uint8Array(most)
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * img.height) / rows),
      y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.height) / rows))
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * img.width) / cols),
        x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * img.width) / cols))
      const cell = cy * cols + cx
      let count = 0,
        total = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          total++
          const i = (y * img.width + x) * 4
          if (img.data[i + 3] < 128) continue
          // 逐像素精确换算：按 15 位分桶查表时渐变会被切成台阶，台阶交界处的格子在两种颜色之间来回跳
          oklabInto(img.data[i], img.data[i + 1], img.data[i + 2], px, count * 3)
          pos[count * 2] = (x - x0 + 0.5) / (x1 - x0) - 0.5
          pos[count * 2 + 1] = (y - y0 + 0.5) / (y1 - y0) - 0.5
          count++
        }
      if (count * 2 <= total) continue
      opaque[cell] = 1
      twoMeans(px, pos, count, groups, cell, color, minor)
    }
  }
  const lines = keepLines ? preserveLines(cols, rows, color, opaque, minor) : undefined
  return { cols, rows, color, opaque, lines }
}

/** 两簇中心距离的平方至少是簇内平均方差的几倍，才当成两种颜色。 */
const SPLIT = 16

const centers = new Float64Array(6)
const sums = new Float64Array(6)

function twoMeans(
  px: Float32Array,
  pos: Float32Array,
  count: number,
  groups: Uint8Array,
  cell: number,
  color: Float32Array,
  minor: Minor,
) {
  // 起点：最暗和最亮的像素；顺便量三个通道的范围，范围小于两簇的门槛就直接整格平均（照片里大多数格子是这样）
  let lo = 0,
    hi = 0
  let aMin = Infinity,
    aMax = -Infinity,
    bMin = Infinity,
    bMax = -Infinity,
    sl = 0,
    sa = 0,
    sb = 0
  for (let i = 0; i < count; i++) {
    const L = px[i * 3],
      A = px[i * 3 + 1],
      B = px[i * 3 + 2]
    if (L < px[lo * 3]) lo = i
    if (L > px[hi * 3]) hi = i
    if (A < aMin) aMin = A
    if (A > aMax) aMax = A
    if (B < bMin) bMin = B
    if (B > bMax) bMax = B
    sl += L
    sa += A
    sb += B
  }
  const dL = px[hi * 3] - px[lo * 3]
  if (dL * dL + (aMax - aMin) ** 2 + (bMax - bMin) ** 2 < 0.07 * 0.07) {
    color[cell * 3] = sl / count
    color[cell * 3 + 1] = sa / count
    color[cell * 3 + 2] = sb / count
    return
  }
  const c = centers
  for (let k = 0; k < 3; k++) {
    c[k] = px[lo * 3 + k]
    c[3 + k] = px[hi * 3 + k]
  }
  let n0 = 0,
    n1 = 0
  for (let round = 0; round < 4; round++) {
    const s = sums.fill(0)
    n0 = n1 = 0
    for (let i = 0; i < count; i++) {
      const L = px[i * 3],
        A = px[i * 3 + 1],
        B = px[i * 3 + 2]
      const d0 = (L - c[0]) ** 2 + (A - c[1]) ** 2 + (B - c[2]) ** 2
      const d1 = (L - c[3]) ** 2 + (A - c[4]) ** 2 + (B - c[5]) ** 2
      const g = d0 <= d1 ? 0 : 1
      groups[i] = g
      if (g) n1++
      else n0++
      s[g * 3] += L
      s[g * 3 + 1] += A
      s[g * 3 + 2] += B
    }
    for (let k = 0; k < 3; k++) {
      if (n0) c[k] = s[k] / n0
      if (n1) c[3 + k] = s[3 + k] / n1
    }
  }
  const gap = n0 && n1 ? okDistance2(c, 0, c, 3) : 0
  // 两簇隔得远、各自又很集中，才是真有两种颜色（描边压着底色、色块的边）；毛、草、布纹这种一片散开的杂色分成两簇只是硬切，
  // 取多的那簇会偏色、出零星，这时整格平均
  let within = 0
  for (let i = 0; i < count; i++) {
    const g = groups[i] * 3
    within += (px[i * 3] - c[g]) ** 2 + (px[i * 3 + 1] - c[g + 1]) ** 2 + (px[i * 3 + 2] - c[g + 2]) ** 2
  }
  if (gap < 0.07 * 0.07 || gap < SPLIT * (within / count)) {
    // 颜色差不多，整格平均
    for (let k = 0; k < 3; k++) color[cell * 3 + k] = (c[k] * n0 + c[3 + k] * n1) / (n0 + n1)
    return
  }
  const major = n0 >= n1 ? 0 : 1
  for (let k = 0; k < 3; k++) {
    color[cell * 3 + k] = c[major * 3 + k]
    minor.color[cell * 3 + k] = c[(1 - major) * 3 + k]
  }
  let dx = 0,
    dy = 0
  for (let i = 0; i < count; i++)
    if (groups[i] !== major) {
      dx += pos[i * 2]
      dy += pos[i * 2 + 1]
    }
  const m = major ? n0 : n1
  minor.has[cell] = 1
  minor.share[cell] = m / count
  minor.dx[cell] = dx / m
  minor.dy[cell] = dy / m
}

const near = (p: Float32Array, i: number, q: Float32Array, j: number, limit: number) =>
  okDistance2(p, i * 3, q, j * 3) < limit * limit

function preserveLines(cols: number, rows: number, color: Float32Array, opaque: Uint8Array, minor: Minor) {
  const n = cols * rows
  const candidate = new Uint8Array(n)
  const highlight = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!minor.has[i]) continue
    const dl = minor.color[i * 3] - color[i * 3]
    if (minor.share[i] >= 0.18 && (dl < -0.12 || dl > 0.18)) candidate[i] = 1
    else if (minor.share[i] >= 0.12 && dl > 0.25) highlight[i] = 1
  }
  // 邻格的主色就是这一格少数那簇的颜色。少数那簇比主色亮时放宽一点（2026-10-21）：深色描边压着色块边上的格子，
  // 少数那簇（色块那边）混进了描边边上的过渡像素，比旁边的色块暗一截，按 0.08 会被当成一条亮线，描边就断了；
  // 放到 0.12 以上，蓝眼睛的虹膜会被眼眶吃掉
  const same = (i: number, xx: number, yy: number) => {
    if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) return false
    const j = yy * cols + xx
    return !!opaque[j] && near(minor.color, i, color, j, minor.color[i * 3] > color[i * 3] ? 0.11 : 0.08)
  }
  const side = (v: number) => (v > 0.1 ? 1 : v < -0.1 ? -1 : 0)
  // 少数那簇只是旁边一片同色的边：往少数像素所在的那边看，邻格的主色就是它；少数像素在两边（线占多数、两旁是底色）时看两边
  const edgeOfArea = (i: number, x: number, y: number) => {
    const sx = side(minor.dx[i]),
      sy = side(minor.dy[i])
    if (!sx && !sy) return (same(i, x - 1, y) && same(i, x + 1, y)) || (same(i, x, y - 1) && same(i, x, y + 1))
    return (!!sx && same(i, x + sx, y)) || (!!sy && same(i, x, y + sy)) || (!!sx && !!sy && same(i, x + sx, y + sy))
  }
  const take = new Uint8Array(n)
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (!candidate[i] && !highlight[i]) continue
      if (candidate[i] && edgeOfArea(i, x, y)) continue
      let continues = false,
        darkAround = true
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx,
            yy = y + dy
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
          const j = yy * cols + xx
          if (!opaque[j]) continue
          if ((candidate[j] && near(minor.color, i, minor.color, j, 0.1)) || near(minor.color, i, color, j, 0.08))
            continues = true
          if (color[j * 3] > 0.45) darkAround = false
        }
      if (candidate[i] && continues) take[i] = 1
      // 黑眼珠上的白色高光：一小点、四周都暗
      else if (highlight[i] && !continues && darkAround) take[i] = 1
    }
  // 线压在两格交界：只留线的像素多的那格
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (!take[i] || highlight[i]) continue
      const horizontal = Math.abs(minor.dx[i]) >= Math.abs(minor.dy[i])
      const toward = horizontal ? Math.sign(minor.dx[i]) : Math.sign(minor.dy[i])
      if (Math.abs(horizontal ? minor.dx[i] : minor.dy[i]) < 0.15 || !toward) continue
      const xx = horizontal ? x + toward : x,
        yy = horizontal ? y : y + toward
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
      const j = yy * cols + xx
      if (!take[j] || !near(minor.color, i, minor.color, j, 0.1)) continue
      const back = horizontal ? Math.sign(minor.dx[j]) : Math.sign(minor.dy[j])
      if (back !== -toward) continue
      if (minor.share[j] > minor.share[i] || (minor.share[j] === minor.share[i] && j < i)) take[i] = 2
    }
  const lines = new Uint8Array(n)
  for (let i = 0; i < n; i++)
    if (take[i] === 1) {
      // 1 是比主色暗的线（描边、眼睛、字的笔画），2 是比主色亮的（亮线、高光）
      lines[i] = minor.color[i * 3] < color[i * 3] ? 1 : 2
      for (let k = 0; k < 3; k++) color[i * 3 + k] = minor.color[i * 3 + k]
    }
  return lines
}

export type ChooseOptions = {
  palette: Palette
  /** 能用的颜色（色卡里的序号）；不给就是整套 */
  allowed?: readonly number[]
  maxColors: number
}

type Groups = { of: Int32Array; color: Float32Array; weight: number[] }

/** 把 n 个 OKLab 颜色按每 1/scale 一档分桶，返回每个属于哪桶（-1 是不要的）、每桶的加权平均色和总权重。 */
function group(
  color: Float32Array,
  n: number,
  include: (i: number) => boolean,
  weightOf: (i: number) => number,
  scale: number,
): Groups {
  const keyOf = new Map<number, number>()
  const of = new Int32Array(n).fill(-1)
  const sums: number[] = []
  const weight: number[] = []
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue
    const L = color[i * 3],
      A = color[i * 3 + 1],
      B = color[i * 3 + 2]
    const key = Math.round(L * scale) * 1e6 + (Math.round(A * scale) + 500) * 1e3 + (Math.round(B * scale) + 500)
    let bin = keyOf.get(key)
    if (bin === undefined) {
      bin = weight.length
      keyOf.set(key, bin)
      weight.push(0)
      sums.push(0, 0, 0)
    }
    const w = weightOf(i)
    of[i] = bin
    weight[bin] += w
    sums[bin * 3] += L * w
    sums[bin * 3 + 1] += A * w
    sums[bin * 3 + 2] += B * w
  }
  const out = new Float32Array(weight.length * 3)
  for (let b = 0; b < weight.length; b++) for (let k = 0; k < 3; k++) out[b * 3 + k] = sums[b * 3 + k] / weight[b]
  return { of, color: out, weight }
}

/** 第 b 个颜色在 set 里最近的那种（OKLab）。 */
function nearest(color: Float32Array, b: number, oklab: Float32Array, set: readonly number[]) {
  const L = color[b * 3],
    A = color[b * 3 + 1],
    B = color[b * 3 + 2]
  let best = -1,
    bd = Infinity
  for (const c of set) {
    const dl = L - oklab[c * 3],
      da = A - oklab[c * 3 + 1],
      db = B - oklab[c * 3 + 2]
    const d = dl * dl + da * da + db * db
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}

/** 挑颜色并给每格配色，返回格子（colors 按颗数从多到少）。 */
export function choose(s: Samples, o: ChooseOptions): Grid {
  const p = o.palette
  const allowed = o.allowed?.length ? [...o.allowed] : p.colors.map((_, i) => i)
  // 颜色相近的格子并成一桶（OKLab 每 0.01 一档），最后配色按桶算；挑哪几种颜色按粗一档（0.025）的桶算，
  // 一张 300 格的照片细桶有两三万个，粗桶少一个数量级，挑色快得多，结果几乎一样
  const n = s.cols * s.rows
  const fine = group(
    s.color,
    n,
    (i) => s.opaque[i] === 1,
    () => 1,
    100,
  )
  const { of: binOf, color: bc, weight: counts } = fine
  const bins = counts.length
  const coarse = group(
    bc,
    bins,
    () => true,
    (b) => counts[b],
    40,
  )

  // 每桶最近的色卡颜色
  const used = new Set<number>()
  for (let b = 0; b < coarse.weight.length; b++) used.add(nearest(coarse.color, b, p.oklab, allowed))
  let chosen = [...used]
  const limit = Math.max(1, o.maxColors)

  if (chosen.length > limit) chosen = reduce(coarse.color, coarse.weight, p, chosen, limit)
  chosen = refine(coarse.color, coarse.weight, p, chosen, allowed)

  // 每桶在最近的三种里按 CIEDE2000 选
  const pick = new Int32Array(bins)
  const near3 = new Int32Array(3),
    dist3 = new Float64Array(3)
  for (let b = 0; b < bins; b++) {
    near3.fill(-1)
    dist3.fill(Infinity)
    for (const c of chosen) {
      const d = okDistance2(bc, b * 3, p.oklab, c * 3)
      if (d >= dist3[2]) continue
      let k = 2
      while (k > 0 && d < dist3[k - 1]) {
        dist3[k] = dist3[k - 1]
        near3[k] = near3[k - 1]
        k--
      }
      dist3[k] = d
      near3[k] = c
    }
    pick[b] = near3[0]
    // 最近的那种已经很近（看不出差别），或者第二近的远得多，就不用再按 CIEDE2000 比
    if (near3[1] < 0 || dist3[0] < 0.0001 || dist3[1] > dist3[0] * 4) continue
    const target = lab(oklabToRgb(bc[b * 3], bc[b * 3 + 1], bc[b * 3 + 2]))
    let bd = Infinity
    for (let k = 0; k < 3 && near3[k] >= 0; k++) {
      const d = deltaE(target, p.colors[near3[k]].lab)
      if (d < bd) {
        bd = d
        pick[b] = near3[k]
      }
    }
  }
  // 颜色按颗数排序
  const tally = new Map<number, number>()
  for (let b = 0; b < bins; b++) tally.set(pick[b], (tally.get(pick[b]) ?? 0) + counts[b])
  const order = [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).map(([c]) => c)
  const slot = new Map(order.map((c, i) => [c, i]))
  const cells = new Uint8Array(binOf.length).fill(EMPTY)
  for (let i = 0; i < binOf.length; i++) if (binOf[i] >= 0) cells[i] = slot.get(pick[binOf[i]])!
  return { width: s.cols, height: s.rows, palette: p.id, colors: order.map((c) => p.colors[c].code), cells }
}

/** 一格的误差（d2 是 OKLab 距离的平方）：距离 0.07 以上四次方项占大头。 */
const penalty = (d2: number) => d2 + (d2 * d2) / 0.005

/** 每次去掉「去掉后总误差增加最少」的颜色，直到不超过 limit 种。 */
function reduce(bc: Float32Array, counts: number[], p: Palette, start: number[], limit: number): number[] {
  const set = new Set(start)
  const bins = counts.length
  const best = new Int32Array(bins),
    second = new Int32Array(bins)
  const db = new Float64Array(bins),
    ds = new Float64Array(bins)
  const rank = (b: number) => {
    let b1 = -1,
      b2 = -1,
      d1 = Infinity,
      d2 = Infinity
    for (const c of set) {
      const d = okDistance2(bc, b * 3, p.oklab, c * 3)
      if (d < d1) {
        b2 = b1
        d2 = d1
        b1 = c
        d1 = d
      } else if (d < d2) {
        b2 = c
        d2 = d
      }
    }
    best[b] = b1
    second[b] = b2
    db[b] = d1
    ds[b] = d2
  }
  for (let b = 0; b < bins; b++) rank(b)
  const cost = new Float64Array(p.colors.length)
  while (set.size > limit) {
    cost.fill(0)
    for (let b = 0; b < bins; b++) cost[best[b]] += counts[b] * (penalty(ds[b]) - penalty(db[b]))
    let drop = -1,
      low = Infinity
    for (const c of set)
      if (cost[c] < low || (cost[c] === low && c > drop)) {
        low = cost[c]
        drop = c
      }
    set.delete(drop)
    for (let b = 0; b < bins; b++) if (best[b] === drop || second[b] === drop) rank(b)
  }
  return [...set]
}

/** 几轮 k-means：按剩下的颜色分组，组的平均色吸附回能用的色卡颜色里最近的那种（不和别的组撞）。 */
function refine(bc: Float32Array, counts: number[], p: Palette, start: number[], allowed: number[]): number[] {
  let centers = [...start]
  const bins = counts.length
  for (let round = 0; round < 3; round++) {
    const sum = new Float64Array(centers.length * 3)
    const weight = new Float64Array(centers.length)
    for (let b = 0; b < bins; b++) {
      let k = 0,
        d = Infinity
      for (let j = 0; j < centers.length; j++) {
        const e = okDistance2(bc, b * 3, p.oklab, centers[j] * 3)
        if (e < d) {
          d = e
          k = j
        }
      }
      weight[k] += counts[b]
      for (let t = 0; t < 3; t++) sum[k * 3 + t] += bc[b * 3 + t] * counts[b]
    }
    let changed = false
    const taken = new Set(centers)
    for (let j = 0; j < centers.length; j++) {
      if (!weight[j]) continue
      const mean = [sum[j * 3] / weight[j], sum[j * 3 + 1] / weight[j], sum[j * 3 + 2] / weight[j]]
      let best = centers[j],
        bd = okDistance2(mean, 0, p.oklab, centers[j] * 3)
      for (const c of allowed) {
        if (taken.has(c)) continue
        const d = okDistance2(mean, 0, p.oklab, c * 3)
        if (d < bd) {
          bd = d
          best = c
        }
      }
      if (best !== centers[j]) {
        taken.delete(centers[j])
        taken.add(best)
        centers[j] = best
        changed = true
      }
    }
    if (!changed) break
  }
  centers = [...new Set(centers)]
  return centers
}
