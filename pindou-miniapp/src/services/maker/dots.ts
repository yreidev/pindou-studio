import { oklabInto } from './color'
import type { Pixels } from './image'
import type { Samples } from './quantize'

// 保住小黑点（docs/plan-bead-maker.md 第 3 节 1，2026-10-21）：眼睛、鼻孔、嘴角、扣子。取色按每格占多数的颜色，
// 一格里只占两三成的瞳孔会被肤色、毛色吃掉。一格里暗的那簇（按亮度分两簇）占得够多、比这格多数色暗得多、
// 比四周 8 格都暗，而且四周这样的格子不超过一个（成片的就是暗纹理，不是点），这格就取暗的那簇，
// 并标成「线」（之后的整张配色、清零星不动它）。挨着的两格是同一个点，取两格暗簇的平均，配成一种颜色
// （2026-10-21：各取各的会配出两种相近的深色，两颗都成了零星）。

export type DotParams = { share: number; contrast: number; around: number; crowd: number }
export const dotDefaults: DotParams = { share: 0.15, contrast: 0.15, around: 0.1, crowd: 1 }

/** small 是缩到「格数 × 4」的图；就地改 s（颜色、lines），返回改了几格。 */
export function keepDots(small: Pixels, s: Samples, P: DotParams = dotDefaults): number {
  const { cols, rows } = s
  const n = cols * rows
  const darkColor = new Float32Array(n * 3)
  const cand = new Uint8Array(n)
  const lab = new Float64Array(3)
  const px: number[][] = []
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * small.height) / rows),
      y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * small.height) / rows))
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx
      if (!s.opaque[i]) continue
      const x0 = Math.floor((cx * small.width) / cols),
        x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * small.width) / cols))
      px.length = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const k = (y * small.width + x) * 4
          if (small.data[k + 3] < 128) continue
          oklabInto(small.data[k], small.data[k + 1], small.data[k + 2], lab)
          px.push([lab[0], lab[1], lab[2]])
        }
      if (px.length < 4) continue
      // 按亮度分两簇
      let lo = Infinity,
        hi = -Infinity
      for (const p of px) {
        lo = Math.min(lo, p[0])
        hi = Math.max(hi, p[0])
      }
      if (hi - lo < P.contrast) continue
      let t = (lo + hi) / 2
      for (let it = 0; it < 4; it++) {
        let a = 0,
          na = 0,
          b = 0,
          nb = 0
        for (const p of px)
          if (p[0] < t) {
            a += p[0]
            na++
          } else {
            b += p[0]
            nb++
          }
        if (!na || !nb) break
        t = (a / na + b / nb) / 2
      }
      let nd = 0
      const dark = [0, 0, 0],
        light = [0, 0, 0]
      for (const p of px) {
        const tgt = p[0] < t ? dark : light
        if (p[0] < t) nd++
        tgt[0] += p[0]
        tgt[1] += p[1]
        tgt[2] += p[2]
      }
      const nl = px.length - nd
      if (nd < px.length * P.share || !nl) continue
      for (let k = 0; k < 3; k++) {
        dark[k] /= nd
        light[k] /= nl
      }
      if (light[0] - dark[0] < P.contrast) continue
      // 这格现在取的已经是暗色了就不用管
      if (s.color[i * 3] <= dark[0] + 0.05) continue
      darkColor.set(dark, i * 3)
      cand[i] = 1
    }
  }
  let changed = 0
  const ok = new Uint8Array(n)
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx
      if (!cand[i]) continue
      let crowd = 0,
        darker = true
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = cx + dx,
            yy = cy + dy
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
          const j = yy * cols + xx
          if (!s.opaque[j]) continue
          if (cand[j]) crowd++
          else if (s.color[j * 3] < darkColor[i * 3] + P.around) darker = false
        }
      if (crowd > P.crowd || !darker) continue
      ok[i] = 1
    }
  for (let i = 0; i < n; i++) {
    if (!ok[i]) continue
    // 和挨着的点一起取平均
    let m = 0
    const sum = [0, 0, 0]
    const cx = i % cols,
      cy = (i / cols) | 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx,
          yy = cy + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        if (!ok[j]) continue
        m++
        for (let k = 0; k < 3; k++) sum[k] += darkColor[j * 3 + k]
      }
    for (let k = 0; k < 3; k++) s.color[i * 3 + k] = sum[k] / m
    if (!s.lines) s.lines = new Uint8Array(cols * rows)
    s.lines[i] = 1
    changed++
  }
  return changed
}
