import { deltaE, lab, oklabInto, oklabToRgb } from './color'
import { EMPTY, type Grid } from './grid'
import { Flow } from './maxflow'
import type { Palette } from './palettes'
import type { Samples } from './quantize'

// 整张配色（docs/plan-bead-maker.md 第 3 节 2，2026-10-21 起所有画风都用）：挑好的颜色当起点，每格配哪种颜色整张一起求。
//   能量 = Σ 每格配色的误差 + λ Σ 相邻两格配了不同颜色 ×（β + exp(−(两格原色差 / σ)²)）× 方向权重 + 每多用一种颜色的罚
// 原图里本来就差得多的两格（轮廓、眼睛、高光）分开几乎不罚，差得少的（毛、草、噪点、渐变的台阶）分开罚得重，
// 所以零星和碎块是「整张权衡」掉的，不是按颗数一刀切；8 邻接（斜邻权重 1/√2），一格宽的斜线不算零星。
// 只占几颗、去掉以后整张几乎不变的颜色去掉，同一条描边不在几种相近的颜色之间跳；
// 但眼睛、鼻子这类只有一两颗、和旁边差得多的小细节留着（2026-10-21 起）。
// 求解：α 扩展（每次让所有格子决定「换成 α 还是不换」，一次图割求最优，Boykov 2001），去颜色按 Delong 2012 的标签代价。
// 参数按转图基准和 51 张留出照片定（2026-10-21 科研，报告不进仓库）。

export type MrfParams = {
  /** 平滑项总权重 */
  lambda: number
  /** 原色差多少（OKLab × 100）以上分开几乎不罚 */
  sigma: number
  /** 不管原色差多少，分开都有的一点罚 */
  beta: number
  /** 配色误差截断在这个色差的平方（再不像也就这么不像，免得一格离谱的颜色拖着整片走） */
  truncate: number
  /** α 扩展最多几轮 */
  cycles: number
  /** 认出来的暗线、小黑点格子：配别的颜色的误差乘这么多（1 是不特别照顾） */
  lineHold: number
  /** 每多用一种颜色的罚；0 是不去颜色 */
  labelCost: number
  /** 只试着去掉用量不到这个比例的颜色 */
  labelShare: number
  /** 小细节（眼睛、鼻子）不去：最多几颗 */
  detailCells: number
  /** 小细节最多连成几块（8 邻接） */
  detailParts: number
  /** 小细节和去掉后改配的颜色平均差多少（CIEDE2000）以上才留；0 是不管，都按罚去 */
  detailContrast: number
  /** 先在挑色结果上去颜色、再整张配（快），否则整张配、去颜色、再配 */
  pruneFirst: boolean
  /** 配色误差里 OKLab 距离平方占几成（其余是 CIEDE2000 的平方）：只用 CIEDE2000 会把灰路面配成偏紫的褐色 */
  okMix: number
}

export const mrfDefaults: MrfParams = {
  lambda: 30,
  sigma: 10,
  beta: 0.02,
  truncate: 40,
  cycles: 2,
  lineHold: 1,
  labelCost: 1000,
  labelShare: 0.05,
  detailCells: 3,
  detailParts: 2,
  detailContrast: 15,
  pruneFirst: true,
  okMix: 0.75,
}

/** 两步之间让出主线程、看看是不是不用算了（生成流水线给的）。 */
export type Step = () => Promise<void>

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, Math.SQRT1_2],
  [-1, 1, Math.SQRT1_2],
]
const N8: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT1_2],
  [-1, 1, Math.SQRT1_2],
  [1, -1, Math.SQRT1_2],
  [-1, -1, Math.SQRT1_2],
]

/** 配色误差：格子颜色（按 RGB 取整后）× 色卡颜色，一次生成里共用，同色的格子只算一次。 */
function costs(s: Samples, p: Palette, P: MrfParams) {
  const cache = new Map<number, number>()
  const T2 = P.truncate * P.truncate
  const ok = new Float64Array(3)
  const rgbOf = new Int32Array(s.cols * s.rows)
  for (let i = 0; i < rgbOf.length; i++)
    rgbOf[i] = s.opaque[i] ? oklabToRgb(s.color[i * 3], s.color[i * 3 + 1], s.color[i * 3 + 2]) : -1
  const labs = new Map<number, ReturnType<typeof lab>>()
  return (i: number, c: number) => {
    const rgb = rgbOf[i]
    const key = rgb * 1024 + c
    let v = cache.get(key)
    if (v === undefined) {
      let t = labs.get(rgb)
      if (!t) labs.set(rgb, (t = lab(rgb)))
      const d = deltaE(t, p.colors[c].lab)
      oklabInto((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, ok)
      const o2 =
        ((ok[0] - p.oklab[c * 3]) ** 2 + (ok[1] - p.oklab[c * 3 + 1]) ** 2 + (ok[2] - p.oklab[c * 3 + 2]) ** 2) * 1e4
      v = Math.min(T2, P.okMix * o2 + (1 - P.okMix) * d * d)
      cache.set(key, v)
    }
    return v
  }
}

type Cost = ReturnType<typeof costs>

/** 相邻两格分开的罚：原色差得越多罚得越少。 */
function pairWeight(s: Samples, a: number, b: number, g: number, P: MrfParams) {
  const { color } = s
  const dl = (color[a * 3] - color[b * 3]) * 100,
    da = (color[a * 3 + 1] - color[b * 3 + 1]) * 100,
    db = (color[a * 3 + 2] - color[b * 3 + 2]) * 100
  return P.lambda * g * (P.beta + Math.exp(-(dl * dl + da * da + db * db) / (P.sigma * P.sigma)))
}

/** 每格在 labels（色卡序号）里配色，init 是起点（labels 里的下标，空格 -1）。返回 labels 里的下标。 */
async function relabel(
  s: Samples,
  labels: number[],
  cost: Cost,
  init: Int32Array,
  P: MrfParams,
  step: Step,
): Promise<Int32Array> {
  const { cols, rows, opaque } = s
  const n = cols * rows
  const L = labels.length
  const data = new Float64Array(n * L)
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue
    for (let l = 0; l < L; l++) data[i * L + l] = cost(i, labels[l])
    if (P.lineHold !== 1 && s.lines?.[i] === 1) {
      const own = init[i]
      for (let l = 0; l < L; l++) if (l !== own) data[i * L + l] = data[i * L + l] * P.lineHold + 50 * (P.lineHold - 1)
    }
  }
  // 相邻对（每对只存一次）
  const pa: number[] = [],
    pb: number[] = [],
    pw: number[] = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const a = y * cols + x
      if (!opaque[a]) continue
      for (const [dx, dy, g] of DIRS) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy >= rows || xx >= cols) continue
        const b = yy * cols + xx
        if (!opaque[b]) continue
        pa.push(a)
        pb.push(b)
        pw.push(pairWeight(s, a, b, g, P))
      }
    }
  const M = pa.length
  // 每格所有相邻罚的和：换成 α 多出来的配色误差比这还大的格子怎么都不会换，直接不进图
  const sumW = new Float64Array(n)
  for (let k = 0; k < M; k++) {
    sumW[pa[k]] += pw[k]
    sumW[pb[k]] += pw[k]
  }
  const f = init.slice()
  const nodes: number[] = []
  for (let i = 0; i < n; i++) if (opaque[i]) nodes.push(i)
  const energy = () => {
    let e = 0
    for (const i of nodes) e += data[i * L + f[i]]
    for (let k = 0; k < M; k++) if (f[pa[k]] !== f[pb[k]]) e += pw[k]
    return e
  }
  let current = energy()
  const ids = new Int32Array(n)
  const capS = new Float64Array(nodes.length),
    capT = new Float64Array(nodes.length)
  const act: number[] = []
  const g = new Flow(nodes.length + 2, M + 2 * nodes.length)
  for (let cycle = 0; cycle < P.cycles; cycle++) {
    let improved = false
    for (let alpha = 0; alpha < L; alpha++) {
      await step()
      // 进图的格子：现在不是 α、换成 α 有可能更好的
      act.length = 0
      ids.fill(-1)
      for (const i of nodes)
        if (f[i] !== alpha && data[i * L + alpha] - data[i * L + f[i]] < sumW[i]) {
          ids[i] = act.length
          act.push(i)
        }
      if (!act.length) continue
      const N = act.length
      const S = N,
        T = N + 1
      g.reset(N + 2)
      // 每点两头：capS 是换成 α 的代价（割断 s→p 表示 p 在汇点一侧，就是换），capT 是不换的代价
      for (let k = 0; k < N; k++) {
        const i = act[k]
        capT[k] = data[i * L + f[i]]
        capS[k] = data[i * L + alpha]
      }
      for (let k = 0; k < M; k++) {
        const a = pa[k],
          b = pb[k]
        const ka = ids[a],
          kb = ids[b]
        if (ka < 0 && kb < 0) continue
        const w = pw[k]
        const fp = f[a],
          fq = f[b]
        if (ka >= 0 && kb >= 0) {
          const A = fp !== fq ? w : 0 // 都不换
          const B = fp !== alpha ? w : 0 // p 不换、q 换
          const C = alpha !== fq ? w : 0 // p 换、q 不换
          // 都换成 α 是 0；E = A + (C − A)·x_p − C·x_q + (B + C − A)·(1 − x_p)·x_q
          const cp = C - A
          if (cp >= 0) capS[ka] += cp
          else capT[ka] -= cp
          capT[kb] += C
          const e = B + C - A
          if (e > 1e-12) g.add(ka, kb, e, 0)
        } else {
          // 一头不在图里（不换）：变成在图里那头自己的代价
          const k2 = ka >= 0 ? ka : kb
          const mine = ka >= 0 ? fp : fq,
            other = ka >= 0 ? fq : fp
          if (mine !== other) capT[k2] += w
          if (alpha !== other) capS[k2] += w
        }
      }
      for (let k = 0; k < N; k++) {
        const m = Math.min(capS[k], capT[k])
        if (capS[k] - m > 1e-12) g.add(S, k, capS[k] - m)
        if (capT[k] - m > 1e-12) g.add(k, T, capT[k] - m)
      }
      g.max(S, T)
      const side = g.sourceSide(S)
      const before = f.slice()
      for (let k = 0; k < N; k++) if (!side[k]) f[act[k]] = alpha
      const e = energy()
      if (e < current - 1e-6) {
        current = e
        improved = true
      } else f.set(before)
    }
    if (!improved) break
  }
  for (let i = 0; i < n; i++) if (!opaque[i]) f[i] = -1
  return f
}

/**
 * 去掉不值得的颜色：用得少的颜色按用量从少到多试，去掉后总能量涨得比 labelCost 少就去掉。
 * 涨多少只在这种颜色的格子上局部估：每格改成剩下颜色里局部能量最低的，来回两遍——估出来的只会比整张重配多，
 * 所以估得比 labelCost 少就一定该去。只有一两颗、连成一两块、和改配的颜色差得多的不去：眼睛、鼻子、眼白，
 * 去掉它整张的误差涨得不多（颗数少），一眼就看得出来；散在各处的杂色连成好几块，照样去。
 * 返回剩下的颜色（labels 里的下标）和改过的起点。
 */
function prune(s: Samples, labels: number[], cost: Cost, f: Int32Array, P: MrfParams, p: Palette) {
  const { cols, rows, opaque } = s
  const lab2 = f.slice()
  const gone = new Uint8Array(labels.length)
  const counts = new Array<number>(labels.length).fill(0)
  let total = 0
  for (const v of lab2)
    if (v >= 0) {
      counts[v]++
      total++
    }
  counts.forEach((c, l) => {
    if (!c) gone[l] = 1
  })
  const order = counts
    .map((c, l) => [c, l])
    .filter(([c]) => c > 0 && c < total * P.labelShare)
    .sort((a, b) => a[0] - b[0])
  const left = () => labels.length - gone.reduce((a, b) => a + b, 0)
  for (const [, drop] of order) {
    if (left() <= 2) break
    const cells: number[] = []
    for (let i = 0; i < lab2.length; i++) if (lab2[i] === drop) cells.push(i)
    const trial = new Map<number, number>()
    const get = (j: number) => trial.get(j) ?? lab2[j]
    // 格子 i 配 l 时：它自己的配色误差 + 和邻格分开的罚
    const local = (i: number, l: number) => {
      let e = cost(i, labels[l])
      const x = i % cols,
        y = (i / cols) | 0
      for (const [dx, dy, g] of N8) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        if (opaque[j] && get(j) !== l) e += pairWeight(s, i, j, g, P)
      }
      return e
    }
    for (let pass = 0; pass < 2; pass++)
      for (const i of cells) {
        let best = -1,
          be = Infinity
        for (let l = 0; l < labels.length; l++) {
          if (gone[l] || l === drop) continue
          const e = local(i, l)
          if (e < be) {
            be = e
            best = l
          }
        }
        trial.set(i, best)
      }
    if (P.detailContrast > 0 && cells.length <= P.detailCells && parts(cells, cols, rows) <= P.detailParts) {
      let far = 0
      for (const [, l] of trial) far += deltaE(p.colors[labels[drop]].lab, p.colors[labels[l]].lab)
      if (far / cells.length >= P.detailContrast) continue
    }
    // 精确算这些格子改色后的能量差（相邻对只算一次）
    const inSet = new Set(cells)
    let delta = 0
    for (const i of cells) {
      delta += cost(i, labels[trial.get(i)!]) - cost(i, labels[drop])
      const x = i % cols,
        y = (i / cols) | 0
      for (const [dx, dy, g] of N8) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        if (!opaque[j] || (inSet.has(j) && j < i)) continue
        const before = lab2[i] !== lab2[j] ? 1 : 0
        const after = trial.get(i) !== get(j) ? 1 : 0
        if (before !== after) delta += (after - before) * pairWeight(s, i, j, g, P)
      }
    }
    if (delta < P.labelCost) {
      for (const [i, l] of trial) lab2[i] = l
      gone[drop] = 1
    }
  }
  const keep = labels.map((_, l) => l).filter((l) => !gone[l])
  const slot = new Int32Array(labels.length).fill(-1)
  keep.forEach((l, k) => (slot[l] = k))
  const init = new Int32Array(lab2.length)
  for (let i = 0; i < lab2.length; i++) init[i] = lab2[i] < 0 ? -1 : slot[lab2[i]]
  return { labels: keep.map((l) => labels[l]), init }
}

/** cells 连成几块（8 邻接）。 */
function parts(cells: number[], cols: number, rows: number) {
  const left = new Set(cells)
  const stack: number[] = []
  let n = 0
  for (const start of cells) {
    if (!left.delete(start)) continue
    n++
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % cols,
        y = (i / cols) | 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
          const j = yy * cols + xx
          if (left.delete(j)) stack.push(j)
        }
    }
  }
  return n
}

/** 整张配色：first 是挑色的结果（颜色和每格的起点），返回重新配过、去过颜色的图纸（格子的颜色序号是新的）。 */
export async function wholeImage(
  s: Samples,
  first: Grid,
  p: Palette,
  params: Partial<MrfParams>,
  step: Step,
): Promise<Grid> {
  const P = { ...mrfDefaults, ...params }
  const cost = costs(s, p, P)
  let labels = first.colors.map((code) => p.index.get(code)!)
  let init = new Int32Array(first.cells.length)
  for (let i = 0; i < init.length; i++) init[i] = first.cells[i] === EMPTY ? -1 : first.cells[i]
  let f: Int32Array
  if (P.labelCost > 0 && P.pruneFirst) {
    ;({ labels, init } = prune(s, labels, cost, init, P, p))
    f = await relabel(s, labels, cost, init, P, step)
  } else {
    f = await relabel(s, labels, cost, init, P, step)
    if (P.labelCost > 0) {
      ;({ labels, init } = prune(s, labels, cost, f, P, p))
      f = await relabel(s, labels, cost, init, { ...P, cycles: 2 }, step)
    }
  }
  const cells = new Uint8Array(f.length).fill(EMPTY)
  for (let i = 0; i < f.length; i++) if (f[i] >= 0) cells[i] = f[i]
  return { ...first, colors: labels.map((c) => p.colors[c].code), cells }
}
