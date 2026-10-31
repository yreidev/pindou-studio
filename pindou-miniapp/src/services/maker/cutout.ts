import { pixels, resize, type Pixels } from './image'

// 抠图（试用，2026-10-22）：小模型 u2netp（U²-Net 的小版本，Apache-2.0）在手机上认出主体，背景改成透明，
// 后面转图照常走（透明过半的格子算空）。照片不上传。
// 这里只有纯函数：模型文件解包、模型输入、蒙版后处理、把蒙版套到照片上；调微信接口的部分在 cutout-device.ts。
// 后处理照 2026-10-21 转图科研的做法：模型给的是 0～1 的把握，难的照片整片只有三四成，按 0.5 一刀切会切掉大半主体，
// 所以先拉伸到 0～1，再用大津法定阈值（限在 0.15～0.5），只留大块，填掉主体里的洞。

/** 模型输入的边长：u2netp 固定吃 320×320。 */
export const CUT_SIDE = 320

type Packed = { skeleton: number; tensors: { at: number; n: number; ch: number; q: number; s: number }[] }

/**
 * 模型文件解包。整个模型（4.6 MB）放不进做图纸分包（单个分包上限 2 MB），所以按「骨架 + 8 位权重」打包再 brotli（1.1 MB）：
 * 'U2Q1' | uint32 头长 | 头（JSON）| 骨架 | 各张量的 int8 权重 | 各张量的 float32 比例（每个输出通道一个）。
 * 骨架就是完整的 .onnx，只是这些张量的位置先填了 0；按头里记的字节偏移把「权重 × 比例」填回去，就是能直接用的模型。
 */
export function unpackModel(blob: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(blob)
  const view = new DataView(blob)
  if (ascii(bytes, 0, 4) !== 'U2Q1') throw new Error('不是抠图模型文件')
  const headLength = view.getUint32(4, true)
  const head = JSON.parse(ascii(bytes, 8, headLength)) as Packed
  let p = 8 + headLength
  const out = bytes.slice(p, p + head.skeleton)
  p += head.skeleton
  const weights = new Int8Array(
    blob,
    p,
    head.tensors.reduce((sum, t) => sum + t.n, 0),
  )
  const scalesAt = p + weights.length
  const target = new DataView(out.buffer)
  for (const t of head.tensors) {
    const per = t.n / t.ch
    for (let c = 0; c < t.ch; c++) {
      const scale = view.getFloat32(scalesAt + t.s + c * 4, true)
      for (let i = c * per, end = i + per; i < end; i++) target.setFloat32(t.at + i * 4, weights[t.q + i] * scale, true)
    }
  }
  return out.buffer
}

function ascii(bytes: Uint8Array, from: number, length: number) {
  let s = ''
  for (let i = from; i < from + length; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** 透明的地方垫白（贴纸 PNG）：模型只认 RGB。 */
function onWhite(src: Pixels): Pixels {
  const d = src.data
  let opaque = true
  for (let i = 3; i < d.length; i += 4)
    if (d[i] < 255) {
      opaque = false
      break
    }
  if (opaque) return src
  const out = pixels(src.width, src.height)
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    for (let c = 0; c < 3; c++) out.data[i + c] = d[i + c] * a + 255 * (1 - a)
    out.data[i + 3] = 255
  }
  return out
}

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

/** 模型输入：缩到 320×320（不保比例，和模型训练时一样），除以最亮的值，减均值除标准差；NCHW 排。 */
export function modelInput(src: Pixels): Float32Array {
  const small = resize(onWhite(src), CUT_SIDE, CUT_SIDE)
  const n = CUT_SIDE * CUT_SIDE
  let max = 0
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) max = Math.max(max, small.data[i * 4 + c])
  const k = 1 / Math.max(max, 1e-6)
  const out = new Float32Array(3 * n)
  for (let c = 0; c < 3; c++)
    for (let i = 0; i < n; i++) out[c * n + i] = (small.data[i * 4 + c] * k - MEAN[c]) / STD[c]
  return out
}

/** 大津法：64 格直方图里把「主体」「背景」分得最开的那个阈值。 */
function otsu(v: Float32Array) {
  const hist = new Float64Array(64)
  for (const x of v) hist[Math.min(63, Math.max(0, Math.floor(x * 64)))]++
  const w = new Float64Array(64),
    mu = new Float64Array(64)
  for (let k = 0, sw = 0, sm = 0; k < 64; k++) {
    sw += hist[k]
    sm += (hist[k] * (k + 0.5)) / 64
    w[k] = sw
    mu[k] = sm
  }
  const total = w[63]
  let best = -1,
    t = 0.5
  for (let k = 1; k < 63; k++) {
    const w0 = w[k],
      w1 = total - w[k]
    if (!w0 || !w1) continue
    const m0 = mu[k] / w0,
      m1 = (mu[63] - mu[k]) / w1
    const b = w0 * w1 * (m0 - m1) ** 2
    if (b > best) {
      best = b
      t = (k + 1) / 64
    }
  }
  return t
}

/**
 * 模型输出（side × side，每点是主体的把握）→ 主体蒙版（1 是主体）：拉伸到 0～1，大津法定阈值（限在 0.15～0.5），
 * 只留不小于最大那块 5% 的块（上下左右相连算一块），再把主体里不和四边连着的背景填上。
 */
export function maskFrom(pred: Float32Array, side = CUT_SIDE): Uint8Array {
  const n = side * side
  let lo = Infinity,
    hi = -Infinity
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, pred[i])
    hi = Math.max(hi, pred[i])
  }
  const norm = new Float32Array(n)
  const span = Math.max(1e-6, hi - lo)
  for (let i = 0; i < n; i++) norm[i] = (pred[i] - lo) / span
  const t = Math.min(0.5, Math.max(0.15, otsu(norm)))
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = norm[i] >= t ? 1 : 0

  // 连通块
  const label = new Int32Array(n)
  const sizes = [0]
  const stack = new Int32Array(n)
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start]) continue
    const id = sizes.length
    let top = 0,
      size = 0
    stack[top++] = start
    label[start] = id
    const visit = (j: number) => {
      if (mask[j] && !label[j]) {
        label[j] = id
        stack[top++] = j
      }
    }
    while (top) {
      const i = stack[--top]
      size++
      const x = i % side
      if (i >= side) visit(i - side)
      if (i < n - side) visit(i + side)
      if (x > 0) visit(i - 1)
      if (x < side - 1) visit(i + 1)
    }
    sizes.push(size)
  }
  let biggest = 0
  for (const s of sizes) biggest = Math.max(biggest, s)
  for (let i = 0; i < n; i++) if (mask[i] && sizes[label[i]] < biggest * 0.05) mask[i] = 0

  // 填洞：从四边漫进去的背景才是背景
  const outside = new Uint8Array(n)
  let top = 0
  const push = (i: number) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1
      stack[top++] = i
    }
  }
  for (let x = 0; x < side; x++) {
    push(x)
    push((side - 1) * side + x)
  }
  for (let y = 0; y < side; y++) {
    push(y * side)
    push(y * side + side - 1)
  }
  while (top) {
    const i = stack[--top]
    const x = i % side
    if (i >= side) push(i - side)
    if (i < n - side) push(i + side)
    if (x > 0) push(i - 1)
    if (x < side - 1) push(i + 1)
  }
  for (let i = 0; i < n; i++) mask[i] = outside[i] ? 0 : 1
  return mask
}

/** 主体占整张的多少（0～1）。 */
export function maskShare(mask: Uint8Array): number {
  let s = 0
  for (const v of mask) s += v
  return mask.length ? s / mask.length : 0
}

/** 把 side × side 的蒙版放大套到照片上：主体照旧，背景透明。放大按双线性插值、过半算主体，边不发方。 */
export function applyMask(src: Pixels, mask: Uint8Array, side = CUT_SIDE): Pixels {
  const { width: w, height: h } = src
  const out = { width: w, height: h, data: src.data.slice() }
  const at = (x: number, y: number) =>
    mask[Math.min(side - 1, Math.max(0, y)) * side + Math.min(side - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) {
    const fy = ((y + 0.5) * side) / h - 0.5
    const y0 = Math.floor(fy),
      ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = ((x + 0.5) * side) / w - 0.5
      const x0 = Math.floor(fx),
        tx = fx - x0
      const v =
        (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
        (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      if (v < 0.5) out.data[(y * w + x) * 4 + 3] = 0
    }
  }
  return out
}
