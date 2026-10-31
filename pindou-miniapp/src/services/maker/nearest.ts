import { okDistance2, oklabInto, oklabToRgb } from './color'
import { EMPTY, MAX_COLORS, type Grid } from './grid'
import type { Pixels } from './image'
import type { Step } from './mrf'
import type { Palette } from './palettes'
import type { Samples } from './quantize'

// 「写实」风格（2026-10-21 业主定为默认）：每格取「主色」，直接对到色卡里最接近的颜色（OKLab 距离），不先挑颜色、不整张平滑；
// 代价是颜色多、单颗的杂色多（生成时再清掉单颗）。
// 主色是格子里出现次数最多的那个像素颜色（RGB 一模一样才算同一个），学的是 pixelbeads.art 默认的「卡通（主色）」（看过它网页里的代码）：
// 不求平均，眼线、嘴唇、眉毛这种颜色匀的细节不会和旁边的皮肤混成一团——渐变里每个像素都略有不同，各自只出现一两次，
// 颜色匀的细节哪怕只占一小块也能胜出，所以 AI 图、插画、动漫图的五官特别清楚；52 格时按两簇取平均（第 3 节 1）连眼睛都没了。
// 照片太小（一格只有几个像素）或噪点多时，格子里的像素几乎各不相同，主色就成了随手挑的一个像素、满图杂色，
// 所以没有哪个颜色出现够 repeat 次的格子退回按两簇取平均（fallback）。
// 颜色超过 maxColors（最多 64 种：图纸文件和后端每张最多存 64 种）时，一次去掉用得最少的那种，它的格子改配剩下里最接近的，直到不超。
// 不学它的「颜色合并」（按颗数把相近颜色并进多的那种）：人像的皮肤会匀一些，但猫、夕阳这类暖色背景会被并成灰色。

export const modeDefaults = { repeat: 3 }

/**
 * 按格取主色：格子里出现最多的那个 RGB（一样多取先遇到的）。透明（alpha < 128）的像素不算，过半透明的格子是空的。img 不用先缩小。
 * 给了 fallback 时，最多的颜色也不到 repeat 次的格子照抄 fallback 的那格。
 */
export function modeSample(
  img: Pixels,
  cols: number,
  rows: number,
  fallback?: Samples,
  repeat = modeDefaults.repeat,
): Samples {
  const n = cols * rows
  const color = new Float32Array(n * 3)
  const opaque = new Uint8Array(n)
  // 一格最多多少像素；开放定址的散列表，大小是它的两倍以上（2 的幂），每格用完只清用过的槽
  const most = (Math.ceil(img.width / cols) + 1) * (Math.ceil(img.height / rows) + 1)
  let bits = 4
  while (1 << bits < most * 2) bits++
  const mask = (1 << bits) - 1
  const keys = new Int32Array(1 << bits).fill(-1)
  const counts = new Int32Array(1 << bits)
  const used = new Int32Array(most)
  const { width: W, data } = img
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * img.height) / rows),
      y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * img.height) / rows))
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * W) / cols),
        x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * W) / cols))
      let filled = 0,
        seen = 0,
        best = -1,
        max = 0
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4
          if (data[i + 3] < 128) continue
          seen++
          const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
          let h = Math.imul(key, 0x9e3779b1) >>> (32 - bits)
          while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & mask
          if (keys[h] === -1) {
            keys[h] = key
            counts[h] = 0
            used[filled++] = h
          }
          const c = ++counts[h]
          if (c > max) {
            max = c
            best = key
          }
        }
      for (let k = 0; k < filled; k++) keys[used[k]] = -1
      const cell = cy * cols + cx
      if (fallback && max < repeat) {
        opaque[cell] = fallback.opaque[cell]
        color.set(fallback.color.subarray(cell * 3, cell * 3 + 3), cell * 3)
        continue
      }
      if (seen * 2 <= (y1 - y0) * (x1 - x0)) continue
      opaque[cell] = 1
      oklabInto((best >> 16) & 255, (best >> 8) & 255, best & 255, color, cell * 3)
    }
  }
  return { cols, rows, color, opaque }
}

/** 每格配最接近的颜色。allowed 是能用的颜色（色卡序号），不给是整套。 */
export async function nearestGrid(
  s: Samples,
  p: Palette,
  o: { allowed?: readonly number[]; maxColors: number },
  step: Step,
): Promise<Grid> {
  const n = s.cols * s.rows
  const candidates = o.allowed?.length ? [...o.allowed] : p.colors.map((_, i) => i)
  const limit = Math.max(1, Math.min(MAX_COLORS, Math.round(o.maxColors)))
  // 每格配的色卡序号；空格 -1。同一个颜色（按 RGB 取整）只找一次
  const pick = new Int16Array(n).fill(-1)
  const cache = new Map<number, number>()
  const best = (i: number, among: readonly number[]) => {
    let at = among[0],
      bd = Infinity
    for (const c of among) {
      const d = okDistance2(s.color, i * 3, p.oklab, c * 3)
      if (d < bd) {
        bd = d
        at = c
      }
    }
    return at
  }
  for (let i = 0; i < n; i++) {
    if (!s.opaque[i]) continue
    const key = oklabToRgb(s.color[i * 3], s.color[i * 3 + 1], s.color[i * 3 + 2])
    let c = cache.get(key)
    if (c === undefined) cache.set(key, (c = best(i, candidates)))
    pick[i] = c
    if ((i & 4095) === 4095) await step()
  }

  // 颜色太多：去掉用得最少的，格子改配剩下的颜色里最接近的
  const count = new Map<number, number>()
  for (let i = 0; i < n; i++) if (pick[i] >= 0) count.set(pick[i], (count.get(pick[i]) ?? 0) + 1)
  while (count.size > limit) {
    let drop = -1,
      least = Infinity
    for (const [c, k] of count)
      if (k < least) {
        least = k
        drop = c
      }
    count.delete(drop)
    const rest = [...count.keys()]
    for (let i = 0; i < n; i++)
      if (pick[i] === drop) {
        const c = best(i, rest)
        pick[i] = c
        count.set(c, (count.get(c) ?? 0) + 1)
      }
    await step()
  }

  const colors: string[] = []
  const slot = new Map<number, number>()
  const cells = new Uint8Array(n).fill(EMPTY)
  for (let i = 0; i < n; i++) {
    const c = pick[i]
    if (c < 0) continue
    let at = slot.get(c)
    if (at === undefined) {
      at = colors.length
      slot.set(c, at)
      colors.push(p.colors[c].code)
    }
    cells[i] = at
  }
  return { width: s.cols, height: s.rows, palette: p.id, colors, cells }
}
