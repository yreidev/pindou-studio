// 图纸网格识别（docs/plan-bead-maker.md 第 3 节 6）：从电子图纸 / 社交平台截图里认格子。
//
// 为什么重写：原来 importer.ts 的 detect() 用「内容外接框 ÷ 自相关周期」推算格数，
// 在 160 张合成图 + 5 张真实图上的通过率是 17.5%；这一版是 78.8%。
// 原来那版的四个结构性毛病：
//   1. 格数是「框宽 ÷ 周期」推出来的，首尾线一贴图边就差 1～3 格；
//   2. 周期取自相关的最大值，没处理倍频和约数，2 倍、半格来回跳；
//   3. 轮廓用亮度差的**总和**，每 5/10 格加粗的主格线、黑字笔画权重过大；
//   4. 在整张图上算全局周期，截图里的 UI、底部色号统计全混进来。
//
// 这一版的做法：先按「长边缘」把格线挑出来（字笔画短，进不来），
// 再在区域里做一维轮廓 → 定周期 → 精修 → **数线**得格数（绝不除），
// 两个方向互相校验，最后把裁掉的外框补回来。
// 纯 TypedArray 运算，不依赖 DOM，小程序里直接跑；1080×2400 约 130ms（Node）。

import type { Pixels } from './image'

export type Recognized = {
  /** 格子范围（像素，边坐标）：第 c 列格子占 [x + c·w/cols, x + (c+1)·w/cols) */
  x: number
  y: number
  w: number
  h: number
  cols: number
  rows: number
  /** 一格多宽（像素，可带小数） */
  pitchX: number
  pitchY: number
  /** 0~1，越高越可信；低于 0.5 建议让人确认 */
  confidence: number
  /** 是否画了格线（没格线的纯像素画为 false） */
  lined: boolean
}

type Axis = {
  p: number // 周期（像素）
  phase: number // 第 0 条线的位置（像素中心坐标）
  kFirst: number // 首条线编号
  kLast: number // 末条线编号
  strong: number // 范围内「强线」比例
  lined: boolean
  support: (k: number) => number
}

const TAU = 20 // 边缘阈值：RGB 最大通道差
const MIN_PITCH = 5
const SHORT_RUN = 4

export function recognize(img: Pixels): Recognized | undefined {
  const W = img.width
  const H = img.height
  if (W < 16 || H < 16) return undefined
  const rgb = toRGB(img)
  const ex = edgeX(rgb, W, H)
  const ey = edgeY(rgb, W, H)
  const runV = runsY(ex, W, H) // 竖向边缘（左右不同）的竖向段长
  const runH = runsX(ey, W, H) // 横向边缘（上下不同）的横向段长

  // 2. 粗定位：段长 ≥ 4% 图高的竖线、≥ 4% 图宽的横线
  const Lv = Math.max(8, Math.round(0.04 * H))
  const Lh = Math.max(8, Math.round(0.04 * W))
  let rx0 = 0,
    rx1 = W - 1,
    ry0 = 0,
    ry1 = H - 1
  for (let it = 0; it < 2; it++) {
    const rv = new Float64Array(H)
    for (let y = 0; y < H; y++) {
      let s = 0
      const o = y * W
      for (let x = rx0; x <= rx1; x++) if (runV[o + x] >= Lv) s++
      rv[y] = s
    }
    ;[ry0, ry1] = mainSegment(rv)
    const ch = new Float64Array(W)
    for (let y = ry0; y <= ry1; y++) {
      const o = y * W
      for (let x = 0; x < W; x++) if (runH[o + x] >= Lh) ch[x]++
    }
    ;[rx0, rx1] = mainSegment(ch)
  }

  // 3. 一维轮廓（短段过滤，保留无格线像素画的单格边界）
  const padX = Math.round((rx1 - rx0) * 0.04) + 4
  const padY = Math.round((ry1 - ry0) * 0.04) + 4
  const qx = profileX(runV, W, Math.max(0, ry0 - padY), Math.min(H - 1, ry1 + padY), SHORT_RUN)
  const qy = profileY(runH, W, H, Math.max(0, rx0 - padX), Math.min(W - 1, rx1 + padX), SHORT_RUN)
  const loX = Math.max(0, rx0 - padX),
    hiX = Math.min(W - 1, rx1 + padX)
  const loY = Math.max(0, ry0 - padY),
    hiY = Math.min(H - 1, ry1 + padY)

  const longX = makeLongLines(runV, W, H, true, Math.max(0, ry0 - padY), Math.min(H - 1, ry1 + padY))
  const longY = makeLongLines(runH, W, H, false, Math.max(0, rx0 - padX), Math.min(W - 1, rx1 + padX))
  let ax = fitAxis(qx, loX, hiX, undefined, longX, true, [rx0, rx1])
  let ay = fitAxis(qy, loY, hiY, undefined, longY, true, [ry0, ry1])
  // 一个方向认不出（比如只有一行），按方格借另一个方向的周期
  if (!ax && ay) ax = fitAxis(qx, loX, hiX, ay.p, undefined, true, [rx0, rx1])
  if (!ay && ax) ay = fitAxis(qy, loY, hiY, ax.p, undefined, true, [ry0, ry1])
  if (!ax || !ay) return undefined
  // 两个方向周期差成 2 倍：一边选到了另一半的周期。
  //
  // 方向很重要：**用较大的周期重认较小的那个**。
  // 原因：周期 p/2 意味着「每格中间多出一条线」——格子中间本来没有线，
  // 那条是相邻两格的色差边界，能被误判成格线。反过来，p 的 2 倍意味着
  // 「隔一格才认一条线」，会丢掉一半的真实格线，对比度会明显下降、容易被发现。
  // 所以两倍关系里，大的更可信。
  // （实测：某张 y 方向印着色号的图纸 的 y 方向候选里 20 和 40 得分 0.563 / 0.558 几乎相同，
  //   按「取小的」选了 20，结果 53 行认成 111 行。）
  // 两个方向周期差成倍数：把两个周期在两个方向都打一遍分，取总分高的组合。
  // 不预设「用大的重认小的」——取决于哪个才是真周期，不能靠方向猜。
  const ratio = ax.p / ay.p
  if (ratio > 1.6 || ratio < 1 / 1.6) {
    const scoreOf = (q: Float64Array, lo: number, hi: number, p: number) => contrast(q, lo, hi, p).score
    // 组合 A：x 用 ax.p，y 换成 ax.p；组合 B：x 换成 ay.p，y 用 ay.p
    const aTotal = scoreOf(qx, loX, hiX, ax.p) + scoreOf(qy, loY, hiY, ax.p)
    const bTotal = scoreOf(qx, loX, hiX, ay.p) + scoreOf(qy, loY, hiY, ay.p)
    if (aTotal >= bTotal) {
      const re = fitAxis(qy, loY, hiY, ax.p, undefined, true, [ry0, ry1])
      if (re && re.strong > 0.5) ay = re
    } else {
      const re = fitAxis(qx, loX, hiX, ay.p, undefined, true, [rx0, rx1])
      if (re && re.strong > 0.5) ax = re
    }
  }

  // 7. 外框被裁：另一方向的线伸进了首/末格之外，就补一格
  extendEnds(ax, ay, runH, W, H, true)
  extendEnds(ay, ax, runV, W, H, false)

  const cols = ax.kLast - ax.kFirst
  const rows = ay.kLast - ay.kFirst
  if (cols < 1 || rows < 1) return undefined
  // 像素中心坐标 → 边坐标（+0.5），并夹在图内
  let x0 = ax.phase + ax.kFirst * ax.p + 0.5
  let x1 = ax.phase + ax.kLast * ax.p + 0.5
  let y0 = ay.phase + ay.kFirst * ay.p + 0.5
  let y1 = ay.phase + ay.kLast * ay.p + 0.5
  x0 = Math.max(0, x0)
  y0 = Math.max(0, y0)
  x1 = Math.min(W, x1)
  y1 = Math.min(H, y1)
  const aspect = Math.min(ax.p, ay.p) / Math.max(ax.p, ay.p)
  const confidence = Math.max(0, Math.min(1, Math.min(ax.strong, ay.strong) * (aspect > 0.9 ? 1 : aspect)))
  return {
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
    cols,
    rows,
    pitchX: ax.p,
    pitchY: ay.p,
    confidence,
    lined: ax.lined && ay.lined,
  }
}

// ---------------------------------------------------------------- 边缘

function toRGB(img: Pixels): Uint8Array {
  const { width: W, height: H, data } = img
  const out = new Uint8Array(W * H * 3)
  for (let i = 0, j = 0; i < W * H * 4; i += 4, j += 3) {
    const a = data[i + 3]
    if (a === 255) {
      out[j] = data[i]
      out[j + 1] = data[i + 1]
      out[j + 2] = data[i + 2]
    } else {
      // 透明像素按白底合成
      const t = a / 255
      out[j] = data[i] * t + 255 * (1 - t)
      out[j + 1] = data[i + 1] * t + 255 * (1 - t)
      out[j + 2] = data[i + 2] * t + 255 * (1 - t)
    }
  }
  return out
}

/** 每像素左右两邻的 RGB 最大通道差（中心差分：模糊成 2 像素的边也能拿到全幅对比）。 */
function edgeX(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const e = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const o = y * W
    for (let x = 1; x < W - 1; x++) {
      const a = (o + x - 1) * 3,
        b = (o + x + 1) * 3
      let d = Math.abs(rgb[a] - rgb[b])
      const g = Math.abs(rgb[a + 1] - rgb[b + 1])
      const c = Math.abs(rgb[a + 2] - rgb[b + 2])
      if (g > d) d = g
      if (c > d) d = c
      e[o + x] = d
    }
  }
  return e
}

function edgeY(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const e = new Uint8Array(W * H)
  for (let y = 1; y < H - 1; y++) {
    const o = y * W
    for (let x = 0; x < W; x++) {
      const a = (o - W + x) * 3,
        b = (o + W + x) * 3
      let d = Math.abs(rgb[a] - rgb[b])
      const g = Math.abs(rgb[a + 1] - rgb[b + 1])
      const c = Math.abs(rgb[a + 2] - rgb[b + 2])
      if (g > d) d = g
      if (c > d) d = c
      e[o + x] = d
    }
  }
  return e
}

/**
 * 竖向边缘的竖向段长：x 方向膨胀 1 像素（JPEG、缩放让边左右晃一像素），
 * y 方向允许 ≤3 行的断口（格线交叉处竖边缘会断开几行）。返回每个边缘像素所在段的长度。
 */
function runsY(e: Uint8Array, W: number, H: number): Uint16Array {
  const run = new Uint16Array(W * H)
  const GAP = 3
  for (let x = 0; x < W; x++) {
    let start = -1,
      last = -1
    const xl = x > 0 ? x - 1 : x,
      xr = x < W - 1 ? x + 1 : x
    for (let y = 0; y <= H; y++) {
      let on = false
      if (y < H) {
        const o = y * W
        on = e[o + xl] >= TAU || e[o + x] >= TAU || e[o + xr] >= TAU
      }
      if (on) {
        if (start < 0) start = y
        else if (y - last - 1 > GAP) {
          fillY(run, e, W, x, start, last)
          start = y
        }
        last = y
      } else if (y === H && start >= 0) fillY(run, e, W, x, start, last)
    }
  }
  return run
}

function fillY(run: Uint16Array, e: Uint8Array, W: number, x: number, a: number, b: number) {
  const len = Math.min(65535, b - a + 1)
  for (let y = a; y <= b; y++) if (e[y * W + x] >= TAU) run[y * W + x] = len
}

function runsX(e: Uint8Array, W: number, H: number): Uint16Array {
  const run = new Uint16Array(W * H)
  const GAP = 3
  for (let y = 0; y < H; y++) {
    const o = y * W,
      ou = y > 0 ? o - W : o,
      od = y < H - 1 ? o + W : o
    let start = -1,
      last = -1
    for (let x = 0; x <= W; x++) {
      const on = x < W && (e[ou + x] >= TAU || e[o + x] >= TAU || e[od + x] >= TAU)
      if (on) {
        if (start < 0) start = x
        else if (x - last - 1 > GAP) {
          const len = Math.min(65535, last - start + 1)
          for (let i = start; i <= last; i++) if (e[o + i] >= TAU) run[o + i] = len
          start = x
        }
        last = x
      } else if (x === W && start >= 0) {
        const len = Math.min(65535, last - start + 1)
        for (let i = start; i <= last; i++) if (e[o + i] >= TAU) run[o + i] = len
      }
    }
  }
  return run
}

/** 竖线轮廓：第 x 列在 [y0, y1] 行里有多少比例是长竖边缘，再做 3 点平滑（1 像素宽的线两侧各一个响应，合成一个峰）。 */
function profileX(run: Uint16Array, W: number, y0: number, y1: number, L: number): Float64Array {
  const q = new Float64Array(W)
  for (let y = y0; y <= y1; y++) {
    const o = y * W
    for (let x = 0; x < W; x++) if (run[o + x] >= L) q[x]++
  }
  const n = y1 - y0 + 1
  for (let x = 0; x < W; x++) q[x] /= n
  return smooth3(q)
}

function profileY(run: Uint16Array, W: number, H: number, x0: number, x1: number, L: number): Float64Array {
  const q = new Float64Array(H)
  const n = x1 - x0 + 1
  for (let y = 0; y < H; y++) {
    const o = y * W
    let s = 0
    for (let x = x0; x <= x1; x++) if (run[o + x] >= L) s++
    q[y] = s / n
  }
  return smooth3(q)
}

function smooth3(q: Float64Array): Float64Array {
  const n = q.length
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? q[i - 1] : q[i],
      b = i < n - 1 ? q[i + 1] : q[i]
    out[i] = (a + 2 * q[i] + b) / 4
  }
  return out
}

/** 一条轮廓里最主要的高值段（平滑后 ≥ 25% 峰值，间隔小的段合并，取总量最大的那段）。 */
function mainSegment(v: Float64Array): [number, number] {
  const n = v.length
  const k = Math.max(3, Math.round(n / 100)) | 1
  const sm = new Float64Array(n)
  let acc = 0
  const half = k >> 1
  for (let i = 0; i < n + half; i++) {
    if (i < n) acc += v[i]
    if (i - k >= 0) acc -= v[i - k]
    const c = i - half
    if (c >= 0 && c < n) sm[c] = acc / k
  }
  let mx = 0
  for (let i = 0; i < n; i++) if (sm[i] > mx) mx = sm[i]
  if (mx <= 0) return [0, n - 1]
  const thr = mx * 0.25
  const gap = Math.max(4, Math.round(n / 50))
  let best: [number, number] = [0, n - 1]
  let bestMass = -1
  let a = -1,
    last = -1,
    mass = 0
  const close = () => {
    if (a >= 0 && mass > bestMass) {
      bestMass = mass
      best = [a, last]
    }
  }
  for (let i = 0; i < n; i++) {
    if (sm[i] >= thr) {
      if (a < 0) {
        a = i
        mass = 0
      } else if (i - last - 1 > gap) {
        close()
        a = i
        mass = 0
      }
      for (let j = last < a ? a : last + 1; j <= i; j++) mass += v[j]
      last = i
    }
  }
  close()

  // 往两端扩展：图纸上下常有一大块同色区域（比如浅灰底 M2），
  // 那里的格线很淡、段短，进不了 25% 阈值，于是「最强的一段」只覆盖了
  // 颜色丰富的那一半——某张图纸上半是整片同色浅灰的截图 真值 y0=279，却从 720 才开始。
  // 扩展条件是「这一行仍有明显多于背景的边缘」。
  //
  // 阈值取峰值的 8% 而不是更低，是因为标题文字（「拼豆图纸 17×59」）的竖笔画
  // 也能凑出几段长边，密度大约是图纸行的 10～20%，太低就会把标题吃进区域里
  // （某张 17×59 的图纸 因此多算 3 行）。8% 既能跨过同色区（那里仍有格线的微弱响应），
  // 又低于标题行的密度。
  const low = mx * 0.08
  let [b0, b1] = best
  let run = 0
  while (b0 - 1 >= 0 && sm[b0 - 1] >= low && run < n) {
    b0--
    run++
  }
  run = 0
  while (b1 + 1 < n && sm[b1 + 1] >= low && run < n) {
    b1++
    run++
  }
  return [b0, b1]
}

// ---------------------------------------------------------------- 一维网格拟合

function maxIn(q: Float64Array, a: number, b: number): number {
  let i0 = Math.max(0, Math.ceil(a)),
    i1 = Math.min(q.length - 1, Math.floor(b))
  if (i1 < i0) {
    const c = Math.min(q.length - 1, Math.max(0, Math.round((a + b) / 2)))
    i0 = i1 = c
  }
  let m = 0
  for (let i = i0; i <= i1; i++) if (q[i] > m) m = q[i]
  return m
}

/** 「格线位置 − 格子中间」的平均对比度，以及最佳相位。 */
/**
 * 相位与打分。用「成对对比度」：
 *
 *   对每一对相邻的预测线 k、k+1：
 *     min(q(线k), q(线k+1)) − q(两线中点)
 *   再对所有对取平均。
 *
 * 为什么这么写（2026-10-21 实测，某张 y 方向印着色号的图纸 的 y 方向）：
 *   原来的写法是「q(线) − q(格子中间)」逐条相减再平均。
 *   格子中间印着色号时，格子中间本身也有边缘，q 不低；
 *   于是 p/2 会把每条线都对到「线+中间」上，得分和真周期打平：
 *     周期 20 → 0.598，周期 40 → 0.596，选错成 20（53 行认成 111 行）。
 *   改成一整对一起算，p/2 只对上一半（线对上了，但中点落在真线上，
 *   中点那一项吃掉分数）：
 *     周期 20 → 0.298，周期 40 → 0.580，周期 120 → 0.571，选对 40。
 */
function contrast(q: Float64Array, lo: number, hi: number, p: number): { score: number; phase: number } {
  const t = Math.max(0.75, p * 0.08)
  const step = p > 24 ? 0.5 : 0.25
  let best = -Infinity,
    bestPh = 0
  for (let ph = 0; ph < p; ph += step) {
    let s = 0,
      n = 0
    const k0 = Math.ceil((lo - ph) / p)
    let prev = NaN
    for (let k = k0; ; k++) {
      const x = ph + k * p
      if (x > hi) break
      if (x < lo) {
        prev = maxIn(q, x - t, x + t)
        continue
      }
      const here = maxIn(q, x - t, x + t)
      if (!Number.isNaN(prev)) {
        // 这一对相邻线之间的中点
        const mid = maxIn(q, x - p / 2 - t, x - p / 2 + t)
        s += Math.min(prev, here) - mid
        n++
      }
      prev = here
    }
    if (n >= 2 && s / n > best) {
      best = s / n
      bestPh = ph
    }
  }
  return { score: best, phase: bestPh }
}

/** 峰的亚像素位置：窗口里找最高点，取半高以上连续段的重心。 */
function peakAt(q: Float64Array, c: number, r: number): { pos: number; h: number } | undefined {
  const i0 = Math.max(0, Math.ceil(c - r)),
    i1 = Math.min(q.length - 1, Math.floor(c + r))
  let im = -1,
    vm = 0
  for (let i = i0; i <= i1; i++)
    if (q[i] > vm || (q[i] === vm && im >= 0 && Math.abs(i - c) < Math.abs(im - c))) {
      vm = q[i]
      im = i
    }
  if (im < 0 || vm <= 0) return undefined
  let a = im,
    b = im
  while (a - 1 >= i0 - 1 && a - 1 >= 0 && q[a - 1] >= vm * 0.5) a--
  while (b + 1 <= i1 + 1 && b + 1 < q.length && q[b + 1] >= vm * 0.5) b++
  let s = 0,
    sw = 0
  for (let i = a; i <= b; i++) {
    s += i * q[i]
    sw += q[i]
  }
  return { pos: s / sw, h: vm }
}

/** 判「小周期多出来的线是不是长线」用的轮廓，按大周期现算，结果缓存。 */
type LongLines = {
  ratio(small: number, big: number, lo: number, hi: number, phase: number): number
}

/**
 * 构造长线轮廓函数。
 *
 * 思路（方案第 8 节第 2 条）：真格线贯穿整张图，色号字的笔画跨不过一格。
 * 所以只留段长 ≥ 1.2×大周期的边缘，在这个稀疏轮廓上，
 * 小周期「比大周期多出来」的那些位置还有多少响应——大半有就是真线。
 *
 * 起点必须用大周期的相位对齐，不能从区域左边起步：区域是外扩过的
 * （loX = rx0 − pad），和格线相位差好几像素，对不上的话一条线也命中不了。
 */
function makeLongLines(run: Uint16Array, W: number, H: number, isX: boolean, band0: number, band1: number): LongLines {
  const cache = new Map<number, Float64Array>()
  const profileFor = (L: number) => {
    const key = Math.round(L)
    const hit = cache.get(key)
    if (hit) return hit
    const q = isX ? profileX(run, W, band0, band1, key) : profileY(run, W, H, band0, band1, key)
    cache.set(key, q)
    return q
  }
  return {
    ratio(small, big, lo, hi, phase) {
      const q = profileFor(Math.max(SHORT_RUN, Math.round(big * 1.2)))
      let hit = 0,
        tot = 0
      // 按大周期算出「离 lo 最近的那条大周期线」，从它开始往右铺小周期
      const k0 = Math.ceil((lo - phase) / big)
      const start = phase + k0 * big
      for (let c = start; c <= hi; c += small) {
        if (c < lo) continue
        const off = (c - start) / big
        if (Math.abs(off - Math.round(off)) < 0.15) continue // 落在大周期上的不算
        let m = 0
        for (let i = Math.max(0, Math.floor(c - 2)); i <= Math.min(q.length - 1, Math.ceil(c + 2)); i++)
          if (q[i] > m) m = q[i]
        if (m > 0.15) hit++
        tot++
      }
      return tot ? hit / tot : 0
    },
  }
}

/**
 * 周期候选：自相关最高的几个峰，每个再加上它的约数和倍数。
 *
 * 峰只取前 4 个、约数/倍数各到 1/4 和 4 倍。取满 8 个会到近百个候选，
 * 每个候选还要细调一圈，contrast() 就吃掉整张图四分之三的时间。
 * 倍数那一侧另有 makeLongLines 专门裁决，候选少给几个不影响结果。
 * 倍数必须留：圆豆样式的图里，自相关最高峰是「豆内圆环的间距」（只有真格距的一半），
 * 真格距既不在峰上、也不是它的约数，全靠倍数这一步补进来。
 */
function pickPitches(q: Float64Array, lo: number, hi: number, maxP: number): number[] {
  const A = autocorr(q, lo, hi, maxP)
  const peaks: number[] = []
  for (let L = MIN_PITCH; L < maxP; L++) if (A[L] > 0.05 && A[L] >= A[L - 1] && A[L] >= A[L + 1]) peaks.push(L)
  peaks.sort((a, b) => A[b] - A[a])
  const set = new Set<number>()
  for (const L of peaks.slice(0, 4)) {
    for (let k = 1; k <= 4; k++) {
      const c = L / k
      if (c < MIN_PITCH) break
      set.add(Math.round(c * 4) / 4)
      const m = L * k
      if (m > maxP) break
      set.add(Math.round(m * 4) / 4)
    }
  }
  return [...set]
}

function fitAxis(
  q: Float64Array,
  lo: number,
  hi: number,
  forceP?: number,
  /** 用来判「小周期多出来的线是不是长线」的轮廓，由调用方按需构造（见 longLineScore）。 */
  longQ?: LongLines,
  /** 是否启用频谱集中度兜底（无格线图），默认开。 */
  spectralOn = true,
  /**
   * 数线时用的真实区域 [coreLo, coreHi]（不含算轮廓时外扩的 padding）。
   * 不传就退回 [lo, hi]。外扩是为了让边缘段的统计稳一点，但**不能**让格线
   * 铺到区域外面去——某张 17×59 的图纸 的 loY 比真值上边多留了 45 像素，
   * 于是往上多铺了 2 条线，17×59 认成 17×62。
   */
  core?: [number, number],
): Axis | undefined {
  const n = hi - lo + 1
  if (n < MIN_PITCH * 3) return undefined
  const maxP = Math.min(Math.floor(n / 2), 400)

  // 4. 周期候选
  const cands: number[] = forceP ? [forceP] : pickPitches(q, lo, hi, maxP)
  if (!cands.length) return undefined

  // 每个候选：在 ±4% 内细调周期（对比度最大），记分
  //
  // 细调分两遍：先 ±4% 扫 5 个点定大致区间，再在那一点附近 ±0.8% 扫 3 个点。
  // 一遍扫 33 点太贵——contrast() 内部是「相位 × 线数」的双重循环，
  // 一张 1080×2400 截图有 50 个候选 × 33 点 × 2 方向 ≈ 3300 次调用，
  // 实测 539ms / 总 663ms（2026-10-21 的 CPU profile）。两遍只要 8 点，
  // 精度几乎一样（真周期的峰是平滑的，粗扫不会错过）。
  type C = { p: number; score: number; phase: number }
  const scored: C[] = []
  for (const c of cands) {
    let best: C = { p: c, score: -Infinity, phase: 0 }
    const span = forceP ? 0.03 : 0.04
    const coarse = 8
    for (let i = -coarse; i <= coarse; i++) {
      const p = c * (1 + (span * i) / coarse)
      if (p < MIN_PITCH * 0.9) continue
      const r = contrast(q, lo, hi, p)
      if (r.score > best.score) best = { p, score: r.score, phase: r.phase }
    }
    // 第二遍：在最优点附近（±半个粗步距）再扫 4 点
    if (best.score > 0) {
      const c0 = best.p
      const h = (2 * span) / coarse // 一个粗步距的宽度（相对值）
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue
        const p = c0 * (1 + (h * i) / 4)
        if (p < MIN_PITCH * 0.9) continue
        const r = contrast(q, lo, hi, p)
        if (r.score > best.score) best = { p, score: r.score, phase: r.phase }
      }
      scored.push(best)
    }
  }
  if (!scored.length) return undefined
  scored.sort((a, b) => b.score - a.score)
  // 试过「对前 6 个候选再补一轮细扫」，分数没变、耗时从 205ms 涨到 222ms（1080×2400 从 273 到 452），
  // 不划算，已去掉。粗扫 8 点 + 细扫 4 点的精度对这些图够了。
  const top = scored[0].score
  // 分数接近（≥ 85%）时取周期最小的：3 倍、5 倍周期的对比度和真周期一样高
  let pick = scored[0]
  for (const s of scored) if (s.score >= top * 0.85 && s.p < pick.p * 0.95) pick = s

  // 周期选成倍数或约数时的裁决（方案第 8 节第 2 条，2026-10-21 核实）：
  //   只看对比度分不开 —— 某张每 5 格一条主格线的图纸（每 5 格一条粗线、细线很淡）5p 得 0.835、p 得 0.59，
  //   没过 85% 门槛就选了 5 倍；某张每格里印着小字的图纸（14 像素一格、中间印小字）选了半格。
  //   判法是看「小周期多出来的那些线是不是真线」：只数段长 ≥ 1.2×大周期的长边缘，
  //   在那些位置上取轮廓值。真格线贯穿整张图，色号字的笔画跨不过一格。
  //   实测：某张每 5 格一条主格线的图纸 → 25/25 是长线（应取小周期）；某张 y 方向印着色号的图纸 → 0/46（应取大周期）。
  if (longQ && scored.length >= 2) {
    const sortByScore = [...scored].sort((a, b) => b.score - a.score)
    const hiP = sortByScore[0].p
    // 找和最高分成倍数关系的、更小的候选
    for (const s of sortByScore) {
      if (s.p >= hiP * 0.95) continue
      const m = hiP / s.p
      if (m < 1.8 || Math.abs(m - Math.round(m)) > 0.12) continue
      if (s.score < top * 0.4) continue // 分差太大，没必要争
      const frac = longQ.ratio(s.p, hiP, lo, hi, sortByScore[0].phase)
      // 多出来的线大半是长线 → 小周期才是真的
      if (frac >= 0.6) {
        let best = s
        for (const t of scored) if (t.p <= s.p * 1.05 && t.score > best.score) best = t
        pick = best
      }
      break
    }
  }

  // 无格线的大色块图（方案第 8 节第 3 条）：成对对比度在这里失效，
  // 但频谱集中度很好用。
  //
  //   之前试过「top < 0.15 就换」，大幅退步（66.9% → 36.9%）——很多正常格线图的
  //   top 本来就低于 0.15（细格线、大图、深色块），被误换掉了正确周期。
  //   现在改用**两种打分的相对高低**做判据，实测分得很干净（2026-10-21）：
  //
  //   | 样本 | 真周期 | 对比度 | R 最高 | 比值 |
  //   |---|---|---|---|---|
  //   | 某张无格线图 gridless | 32 | 0.050 | 0.977@32 | 19.5 |
  //   | 某张无格线的大色块图 gridless_full | 16 | 0.031 | 0.903@16 | 29.4 |
  //   | 某张无格线图 gridless | 8.52 | 0.044 | 0.797@8.5 | 18.0 |
  //   | 某张无格线图 gridless | 10 | 0.043 | 0.867@10 | 19.9 |
  //   | 某张白缝样式的图 whitegap | 6.51 | 0.140 | 0.302@6.5 | 2.2 |
  //   | 某张 62×58 的图纸 axes | 12 | 0.495 | 0.795@12 | 1.6 |
  //   | 某张深色块、细格线的图纸 screenshot_small | 8.77 | 0.556 | 0.554@8.8 | 1.0 |
  //
  //   R 远高于对比度（≥5 倍）→ 只有等距、没有贯穿格线的那种图会这样。
  //   这时在 R 的峰上取周期，并允许小周期（R 对 p/2 也给高分，取最小）。
  let spectralHit = false
  if (spectralOn) {
    // 用 FFT 一次算出所有周期的频谱能量，别逐个 p 去扫。
    // 原来写的是「p 从 5 扫到 n/3、步长 0.25，每个 p 做一次 O(n) 求和」，
    // 1080×2400 的截图要 400～670ms（验收要求 < 300ms）。
    // 现在一次 FFT 就能给出全部频率的 |Σq(x)e^{-2πikx/N}|。
    const { rTop, rP } = spectralPeak(q, lo, hi)
    if (rP > 0) {
      // R 对 p 的整数倍也给分（每 1/m 的相位都对齐），所以先看有没有更小的等价周期
      let best = rP
      for (let m = 2; m <= 8; m++) {
        const c = rP / m
        if (c < MIN_PITCH) break
        if (spectral(q, lo, hi, c) > rTop * 0.9) {
          best = c
          break
        }
      }
      if (rTop > top * 3.5) {
        // 用频谱定下来的周期重新细调相位
        const r = contrast(q, lo, hi, best)
        if (r.score > 0) {
          pick = { p: best, score: r.score, phase: r.phase }
          scored.push(pick)
          spectralHit = true
        }
      }
    }
  }

  if (pick.score < 0.02) return undefined

  // 5. 精修：从最强的线往两边长
  let p = pick.p,
    phase = pick.phase
  const r = Math.max(1.5, p * 0.2)
  // 锚点：中段最强的线
  const kMin = Math.ceil((lo - phase) / p),
    kMax = Math.floor((hi - phase) / p)
  let k0 = kMin,
    v0 = -1
  for (let k = kMin; k <= kMax; k++) {
    const v = maxIn(q, phase + k * p - 1, phase + k * p + 1)
    const centrality = 1 - Math.abs(k - (kMin + kMax) / 2) / Math.max(1, kMax - kMin)
    if (v * (0.5 + centrality) > v0) {
      v0 = v * (0.5 + centrality)
      k0 = k
    }
  }
  for (let radius = 4; ; radius *= 2) {
    const ks: number[] = [],
      xs: number[] = [],
      ws: number[] = []
    for (let k = k0 - radius; k <= k0 + radius; k++) {
      const c = phase + k * p
      if (c < lo - 1 || c > hi + 1) continue
      const pk = peakAt(q, c, r)
      if (!pk || pk.h < v0 * 0.15) continue
      ks.push(k)
      xs.push(pk.pos)
      ws.push(pk.h)
    }
    if (ks.length >= 3) {
      const f = wls(ks, xs, ws)
      if (f && f.b > MIN_PITCH * 0.8 && Math.abs(f.b - p) < p * 0.1) {
        p = f.b
        phase = f.a
      }
    }
    if (k0 - radius <= kMin && k0 + radius >= kMax) break
  }
  // 相位归一到 [0, p)，线编号跟着平移
  const shift = Math.floor(phase / p)
  phase -= shift * p

  // 6. 范围：沿格子位置看哪些线「有」
  const t = Math.max(1, p * 0.12)
  const support = (k: number) => {
    const c = phase + k * p
    if (c < -t || c > q.length - 1 + t) return 0
    return maxIn(q, c - t, c + t)
  }
  const mid = (k: number) => maxIn(q, phase + (k + 0.5) * p - t, phase + (k + 0.5) * p + t)
  /**
   * 这条线比它两侧的格子中间高多少（取两侧的**较大**值，要求两边都比它低）。
   *
   * 为什么不能只用 support()（2026-10-21 实测，某张 62×58 的图纸 多算一格）：
   *   真值 62×58，认成 63×59。多出来的那一「条线」落在 x = 8.65，
   *   那里 q = 0.06，正好是左侧空白到第一条格线的缓坡上，不是峰。
   *   但它的 support 0.06 超过了 weakThr，被「两端接弱线」接了上去。
   *   判「是线」的充分条件不是「这里有点响应」，而是「这里比两边都高」——
   *   同一套成对对比度的思想，用到单条线上。
   */
  const lineScore = (k: number) => {
    const c = phase + k * p
    if (c < lo - p || c > hi + p) return 0
    return support(k) - Math.max(mid(k - 1), mid(k))
  }
  const [cLo, cHi] = core ?? [lo, hi]
  const ka = Math.ceil((cLo - t - phase) / p),
    kb = Math.floor((cHi + t - phase) / p)
  const sup: number[] = [],
    mids: number[] = [],
    lsc: number[] = []
  for (let k = ka; k <= kb; k++) {
    sup.push(support(k))
    lsc.push(lineScore(k))
    if (k < kb) mids.push(mid(k))
  }
  const sorted = [...sup].sort((a, b) => b - a)
  const typ = sorted[Math.floor(sorted.length * 0.25)] || 0 // 前 25% 的线有多强
  const noise = median(mids)
  // 是不是「有格线」的图纸。要先判：它决定怎么数线（见下）
  const lined = typ > 0.55 && noise < typ * 0.35
  const strongThr = Math.max(0.03, noise + 0.45 * (typ - noise))
  // 弱线的判据换成 lineScore：必须是局部峰，且比两侧中点高出典型线的一小截
  const posLsc = lsc.filter((v) => v > 0).sort((a, b) => b - a)
  const lscTyp = posLsc.length ? posLsc[Math.floor(posLsc.length * 0.25)] || 0 : 0
  const weakLscThr = Math.max(0.02, lscTyp * 0.18)
  const weakThr = Math.max(0.02, noise * 1.5 + 0.01, typ * 0.08)
  // 最长的强线段（允许中间断 ≤2 条）
  //
  // 有格线的方向不能这么数（方案第 8 节第 1 条，2026-10-21 核实）：
  //   ① 边上那一圈坐标数字、底部色号统计也能凑出够长的段，接进来就多 1～3 格
  //      （某张带坐标数字的图纸 56×34→58×36、某张带坐标数字的图纸、某张带色号统计的图纸 多 4 行）；
  //   ② 反过来，深色块区域的细格线 support 只有 0.25 上下，被 strongThr 判成「没有」，
  //      一条长段在色块交界处就断了（某张深色块、细格线的图纸 真值 119 列只数到 99，同上的截图 109→87）。
  //   ② 的根子在于 support 是「绝对响应强度」，和所在色块有多深有关。
  //   有格线时改用 lineScore > 0：它衡量「线比它两侧格子中间高多少」，
  //   深色块的格线同样是局部峰，lineScore 稳定为正（某张深色块、细格线的图纸 右段 0.12～0.30，从不为负），
  //   而坐标数字、色号统计那些不是等距局部峰，lineScore 会掉到 0 以下。
  let bestA = -1,
    bestB = -1,
    bestLen = 0
  if (!lined) {
    let a = -1,
      lastStrong = -1
    for (let i = 0; i < sup.length; i++) {
      if (sup[i] >= strongThr) {
        if (a < 0 || i - lastStrong - 1 > 2) a = i
        lastStrong = i
        const len = lastStrong - a
        if (len > bestLen || bestA < 0) {
          bestLen = len
          bestA = a
          bestB = lastStrong
        }
      }
    }
  } else {
    // 有格线：把 lineScore 明显为正的线都算上，允许断 ≤3 条。
    //
    // 门槛不能用一个固定小数（先试过 > 0.03，某张带坐标数字的图纸 的 y 方向因此多算 2 行，
    // 把底部色号统计那些「勉强比中间高一点」的位置也算进来了）。
    // 也不宜用 strongThr——它按前 25% 的**绝对**响应定，深色块的格线够不着
    // （某张深色块、细格线的图纸 右段 support 只有 0.24～0.40，真值 119 列会只数到 99）。
    // 折中：拿本方向 lineScore 正中位的一半当门槛，再留 0.015 的地板。
    // 真格线的 lineScore 成片在 0.2 以上，误判位置通常不到 0.05。
    const posL = lsc.filter((v) => v > 0)
    const lMed = posL.length ? median(posL) : 0
    const lThr = Math.max(0.015, lMed * 0.5)
    let a = -1,
      lastGood = -1
    for (let i = 0; i < lsc.length; i++) {
      if (lsc[i] >= lThr) {
        if (a < 0 || i - lastGood - 1 > 3) a = i
        lastGood = i
        const len = lastGood - a
        if (len > bestLen || bestA < 0) {
          bestLen = len
          bestA = a
          bestB = lastGood
        }
      }
    }
  }
  if (bestA < 0) return undefined
  // 两端再接上连续的弱线（只对无格线的像素画）：
  // 它最外那几列边界本来就淡。有格线的方向已经在上面按 lineScore 数过了。
  const isWeak = (i: number) => sup[i] >= weakThr && lsc[i] >= weakLscThr
  if (!lined) {
    while (bestA - 1 >= 0 && isWeak(bestA - 1)) bestA--
    while (bestB + 1 < sup.length && isWeak(bestB + 1)) bestB++
  }

  // 等距外推：把「两端都有线、中间被判成没有」的那一段补回来。
  //
  // 为什么需要（2026-10-21，某张图纸上半是整片同色浅灰的截图 落地）：小红书截图里图纸上半是整片
  // 同色浅灰（M2 × 512），格线比色差还淡，q 和 lineScore 全都是 0；
  // k = 39…47 共 9 条全判成「没有」，rows 就从 60 塌成 30。
  // 但这里是**等距网格**：周期和相位已经从颜色丰富的那一段确认了，
  // 中间那些线必然还在，只是看不出来。两端都有线 → 中间一律算在线。
  //
  // 必须在**整个 ka…kb 范围**上补，不能只在当前最长段里补：
  // 某张图纸上半是整片同色浅灰的截图 的缺口恰好把上下两段切开，只在段内补就等于没补（试过）。
  // 条件：缺口两侧都得有线，缺口长度 ≤ 总线数的 1/3（防止把图外整片空白也算进来）。
  {
    // spectral 命中说明这是一张「严格等距、但没有贯穿格线」的图（色块画、白缝画、圆豆）。
    // 这类图的边缘响应整体很弱（typ 常在 0.1～0.3），按「最长强线段」永远数不全。
    // 既然周期和相位已经由频谱确认，判据就退回最简单的：lineScore > 0 就算有线。
    const isLine = (i: number) =>
      spectralHit ? lsc[i] > 0 : sup[i] >= strongThr || (lined ? lsc[i] >= Math.max(0.015, lscTyp * 0.5) : isWeak(i))
    const total = lsc.length
    const maxGap = Math.max(2, Math.round(total / 3))
    let i = 0
    while (i < total) {
      if (isLine(i)) {
        i++
        continue
      }
      let j = i
      while (j < total && !isLine(j)) j++
      const gapLen = j - i
      if (i > 0 && j < total && gapLen <= maxGap) {
        for (let q2 = i; q2 < j; q2++) lsc[q2] = Math.max(lsc[q2], lscTyp * 0.5)
      }
      i = j
    }

    // 补完洞、门槛也统一了，重新取最长的连续段
    let a2 = -1,
      last2 = -1
    bestLen = 0
    for (let k = 0; k < total; k++) {
      if (isLine(k)) {
        if (a2 < 0 || k - last2 - 1 > 3) a2 = k
        last2 = k
        const len = last2 - a2
        if (len > bestLen) {
          bestLen = len
          bestA = a2
          bestB = last2
        }
      }
    }
  }
  let nStrong = 0
  for (let i = bestA; i <= bestB; i++) if (sup[i] >= strongThr) nStrong++

  // 无格线的像素画：范围直接取整段 ka…kb，不靠「最长连续段」。
  //
  // 为什么（圆豆样式、白缝样式、无格线色块画都会踩）：
  //   这类图里很多格子是同色的一片，格子与格子之间根本没有边界，
  //   于是「有线」的位置是稀疏、断续的。「最长连续段」往往只覆盖图案密集的那一块，
  //   结果范围只有真值的三分之一到二分之一（48×43 认成 29×18、69×36 认成 24×21）。
  //   而这类的边界本来就是「内容到背景的跳变」，区域粗定位那一步已经把它框准了，
  //   周期和相位也已经定下来，直接用整段正是对的。
  //   有格线的图不能这么做：那里外圈可能就是坐标数字、色号统计，会多算格子。
  const sparse = !lined && bestB - bestA < (kb - ka) * 0.6
  if (sparse) {
    bestA = 0
    bestB = sup.length - 1
  }

  const kFirst = ka + bestA,
    kLast = ka + bestB
  return {
    p,
    phase,
    kFirst,
    kLast,
    strong: kLast > kFirst ? nStrong / (kLast - kFirst + 1) : 0,
    lined,
    support,
  }
}

/**
 * 原地 radix-2 FFT（n 必须是 2 的幂）。只用来找频谱峰值，不需要很高精度。
 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang),
      wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],
          ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/**
 * 用一次 FFT 找出频谱最集中的那个周期（代替逐个 p 的 O(n) 扫描）。
 *
 * 返回 { rP: 最集中的周期（像素）, rTop: 归一化集中度 }。
 * 只扫「图上至少 3 个周期」的范围（p ≤ n/3）。
 */
function spectralPeak(q: Float64Array, lo: number, hi: number): { rTop: number; rP: number } {
  const n = hi - lo + 1
  if (n < 16) return { rTop: 0, rP: 0 }
  let m = 1
  while (m < n) m <<= 1
  const re = new Float64Array(m)
  const im = new Float64Array(m)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = q[lo + i]
    if (v > 0) {
      re[i] = v
      sum += v
    }
  }
  if (sum <= 0) return { rTop: 0, rP: 0 }
  fft(re, im)
  // bin k 对应周期 m/k。k ≥ 3 保证图上至少 3 个周期，k ≤ m/MIN_PITCH 保证周期不小于最小格距
  const kMax = Math.floor(m / MIN_PITCH)
  let best = 0,
    bestK = 0
  for (let k = 3; k <= kMax && k < m / 2; k++) {
    const mag = Math.hypot(re[k], im[k])
    if (mag > best) {
      best = mag
      bestK = k
    }
  }
  if (bestK === 0) return { rTop: 0, rP: 0 }
  // 抛物线插值，拿亚 bin 精度
  const y0 = Math.hypot(re[bestK - 1], im[bestK - 1]),
    y1 = best,
    y2 = Math.hypot(re[bestK + 1], im[bestK + 1])
  const den = y0 - 2 * y1 + y2
  const d = Math.abs(den) > 1e-12 ? (0.5 * (y0 - y2)) / den : 0
  const kf = bestK + Math.max(-0.5, Math.min(0.5, d))
  return { rTop: best / sum, rP: m / kf }
}

/**
 * 频谱集中度：q 的能量有多少落在「周期 p」这一个频率上。
 *
 * R(p) = |Σ q(x)·e^{2πix/p}| / Σ q(x)，取值 0～1，1 表示完全等距。
 * 无格线的大色块图（gridless / gridless_full）靠它定周期：那里的边缘短、
 * 成对对比度失效，但位置严格等距，频谱上很集中。实测 某张无格线的大色块图：
 * R(16)=0.903、R(8)=0.660、R(48)=0.248、R(192)=0.413，真周期明显最高。
 */
function spectral(q: Float64Array, lo: number, hi: number, p: number): number {
  let re = 0,
    im = 0,
    sum = 0
  for (let x = lo; x <= hi; x++) {
    const v = q[x]
    if (v <= 0) continue
    sum += v
    const a = (2 * Math.PI * x) / p
    re += v * Math.cos(a)
    im += v * Math.sin(a)
  }
  return sum > 0 ? Math.hypot(re, im) / sum : 0
}

function autocorr(q: Float64Array, lo: number, hi: number, maxLag: number): Float64Array {
  const n = hi - lo + 1
  let m = 0
  for (let i = lo; i <= hi; i++) m += q[i]
  m /= n
  const d = new Float64Array(n)
  let e = 0
  for (let i = 0; i < n; i++) {
    d[i] = q[lo + i] - m
    e += d[i] * d[i]
  }
  const A = new Float64Array(maxLag + 2)
  if (e <= 0) return A
  // 归一化用**固定的** e，不除以 (n − L)。
  //
  // 为什么（2026-10-21 实测，某张 62×58 的图纸 真周期 12 被认成 36）：
  //   原来写的是无偏自相关 s / (n − L) / (e / n)。长滞后时参与求和的项少了，
  //   除以 (n − L) 等于把噪声放大 n / (n − L) 倍：
  //     L = 12 → 0.9941，但 L = 288（n ≈ 745）→ 1.0148。
  //   于是前 6 个「峰」全落在 200～300 的伪峰上，12 和 36 都进不了候选集，
  //   最后选到 3 倍周期，62×58 认成 21×19。
  //   用 biased 定义 r(L) = Σd[i]d[i+L] / Σd[i]²，长滞后自然衰减，伪峰消失。
  for (let L = 1; L <= maxLag + 1 && L < n; L++) {
    let s = 0
    for (let i = 0; i + L < n; i++) s += d[i] * d[i + L]
    A[L] = s / e
  }
  return A
}

function wls(ks: number[], xs: number[], ws: number[]): { a: number; b: number } | undefined {
  let sw = 0,
    sk = 0,
    sx = 0,
    skk = 0,
    skx = 0
  for (let i = 0; i < ks.length; i++) {
    const w = ws[i]
    sw += w
    sk += w * ks[i]
    sx += w * xs[i]
    skk += w * ks[i] * ks[i]
    skx += w * ks[i] * xs[i]
  }
  const den = sw * skk - sk * sk
  if (Math.abs(den) < 1e-9) return undefined
  const b = (sw * skx - sk * sx) / den
  const a = (sx - b * sk) / sw
  return { a, b }
}

function median(v: number[]): number {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/**
 * 外框被裁掉（最后一列格子贴着图边、右边那条线没画出来）时补一格：
 * 看首/末线外面一格宽的条带里，另一方向的格线（或格子边界）有没有伸进来，
 * 伸进来的密度达到里面一格的六成就算图纸还在延续。
 */
function extendEnds(a: Axis, other: Axis, runOther: Uint16Array, W: number, H: number, isX: boolean) {
  const len = isX ? W : H
  // 另一方向的线位置
  const lines: number[] = []
  for (let k = other.kFirst; k <= other.kLast; k++) lines.push(other.phase + k * other.p)
  const o0 = other.phase + other.kFirst * other.p,
    o1 = other.phase + other.kLast * other.p
  const density = (c0: number, c1: number) => {
    // c0..c1 是本方向的像素范围；数另一方向线上（±1）有长边缘的像素比例
    const i0 = Math.max(0, Math.ceil(c0)),
      i1 = Math.min(len - 1, Math.floor(c1))
    if (i1 < i0) return 0
    let hit = 0,
      tot = 0
    for (const lp of lines) {
      const j = Math.round(lp)
      for (let i = i0; i <= i1; i++) {
        let on = false
        for (let dj = -1; dj <= 1 && !on; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= (isX ? H : W)) continue
          const idx = isX ? jj * W + i : i * W + jj
          if (runOther[idx] >= SHORT_RUN) on = true
        }
        if (on) hit++
        tot++
      }
    }
    return tot ? hit / tot : 0
  }
  void o0
  void o1
  const p = a.p
  for (let side = 0; side < 2; side++) {
    for (let rep = 0; rep < 3; rep++) {
      const kEdge = side === 0 ? a.kFirst : a.kLast
      const c = a.phase + kEdge * p
      const room = side === 0 ? c + 0.5 : len - 0.5 - c
      if (room < p * 0.8) break
      const inner = side === 0 ? density(c + 2, c + p - 2) : density(c - p + 2, c - 2)
      const outer = side === 0 ? density(c - p + 2, c - 2) : density(c + 2, c + p - 2)
      if (inner < 0.15 || outer < inner * 0.6) break
      if (side === 0) a.kFirst--
      else a.kLast++
    }
  }
}
