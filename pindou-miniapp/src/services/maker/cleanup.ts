import { deltaE } from './color'
import { EMPTY, type Grid } from './grid'
import type { Palette } from './palettes'

// 清掉零星小块（docs/plan-bead-maker.md 第 3 节 3）：同色四连通的一小块，颗数少于 minSize 的，并进四周接触最多的颜色
// （一样多时取色差小的）。拼的时候最烦的就是大片颜色里冒出来的单颗。
// 不并的：锁住的格子；和四周差得很大的（CIEDE2000 超过 contrast，比如黑眼珠上的白色高光、描边上断开的一截）；
// 属于一条更长的线的：描边、字的笔画常常是深浅不一的几种颜色连成一串，每种只有一两颗，一块块看都是「零星」，
// 所以从这一块往外（斜着也算连着）找颜色离它比离四周主色更近、而且差得不多的格子，连起来够 stroke 颗就留着。
// 连起来不够一条线、但四周一圈几乎全是同一种颜色的，是一小块显眼的细节（眼睛、高光、扣子），也留着，
// 里面深浅不一的几种颜色并成颗数最多的一种，好拼；质感里的杂色四周是几种颜色交错的，照样并掉。
// 四周全是空格子的孤点删掉（多半是透明底边上留下的渣）。生成时和改图里「去零星」都用它。

export type CleanupOptions = { minSize: number; locked?: Uint8Array; contrast?: number }

// 页面上「清掉零星小块」「去零星」填的是「几颗及以下算零星」（0 是不清、1 是只清单颗），这里的 minSize 是「少于几颗」，差 1。
// 2026-10-21 前页面上直接填 minSize，填 1 等于不清，业主看着填了 1 却写「不清零星」，改成现在这样。
/** minSize → 页面上的数 */
export const strayLimit = (minSize: number) => (minSize > 1 ? minSize - 1 : 0)
/** 页面上的数 → minSize */
export const strayMinSize = (limit: number) => (limit > 0 ? Math.round(limit) + 1 : 0)
/** 「更多设置」那一行怎么写 */
export function strayLabel(minSize: number) {
  const n = strayLimit(minSize)
  return n === 0 ? '不清零星' : n === 1 ? '清掉单颗零星' : `清掉 ${n} 颗及以下的零星`
}

/** 连成一串够这么多颗、颜色相近的，算一条线，不当零星并掉。 */
const STROKE = 4
/** 算「相近」的上限（CIEDE2000）。 */
const STROKE_NEAR = 20
/** 和四周主色差得少于这么多的，是质感里的杂色（毛、草、布纹），照样并掉；差得多的才可能是线。 */
const STROKE_CONTRAST = 15
/** 一小块细节至少几颗（单颗留着就是零星）。 */
const DETAIL = 2
/** 一小块细节四周一圈里，同一种颜色至少占这么多，才算「四周是一整片」。 */
const ISOLATED = 0.8

export function cleanup(g: Grid, palette: Palette, o: CleanupOptions): { grid: Grid; changed: number } {
  const { width: w, height: h } = g
  const cells = g.cells.slice()
  const limit = o.contrast ?? 30
  if (o.minSize <= 1) return { grid: { ...g, cells }, changed: 0 }
  const seen = new Uint8Array(cells.length)
  const stack: number[] = []
  const members: number[] = []
  let changed = 0
  const labOf = (index: number) => palette.colors[palette.index.get(g.colors[index]) ?? 0].lab
  const n = g.colors.length
  const gap = new Float32Array(n * n)
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) gap[a * n + b] = gap[b * n + a] = deltaE(labOf(a), labOf(b))
  const stroke = Math.max(STROKE, o.minSize + 1)
  const mark = new Int32Array(cells.length)
  let markRound = 0
  const queue: number[] = []
  // 从这一块往外找颜色跟它一路的格子，数到 stroke 颗为止
  const strokeSize = (from: number[], color: number, target: number) => {
    markRound++
    queue.length = 0
    for (const i of from) {
      mark[i] = markRound
      queue.push(i)
    }
    for (let q = 0; q < queue.length && queue.length < stroke; q++) {
      const i = queue[q]
      const x = i % w,
        y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          const c = cells[j]
          if (mark[j] === markRound || c === EMPTY || c === target) continue
          if (c !== color && (gap[c * n + color] > STROKE_NEAR || gap[c * n + color] >= gap[c * n + target])) continue
          mark[j] = markRound
          queue.push(j)
        }
    }
    return queue.length
  }
  // strokeSize 找完的那一块（不够 stroke 颗时 queue 里是整块）四周一圈，target 占几成
  const isolated = (target: number) => {
    if (queue.length < DETAIL) return false
    let all = 0,
      same = 0
    for (const i of queue) {
      const x = i % w,
        y = (i / w) | 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = yy * w + xx
          if (mark[j] === markRound || mark[j] === -markRound || cells[j] === EMPTY) continue
          mark[j] = -markRound
          all++
          if (cells[j] === target) same++
        }
    }
    return all > 0 && same >= all * ISOLATED
  }
  // 把 queue 里这一小块并成颗数最多的颜色（一样多时取和四周差得多的）；有锁住的格子就不动。返回改了几颗
  const unify = (target: number) => {
    const count = new Map<number, number>()
    for (const i of queue) {
      if (o.locked?.[i]) return 0
      count.set(cells[i], (count.get(cells[i]) ?? 0) + 1)
    }
    let keep = -1,
      most = 0
    for (const [c, k] of count)
      if (k > most || (k === most && gap[c * n + target] > gap[keep * n + target])) {
        keep = c
        most = k
      }
    let recolored = 0
    for (const i of queue)
      if (cells[i] !== keep) {
        cells[i] = keep
        recolored++
      }
    return recolored
  }
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || cells[start] === EMPTY) continue
    const color = cells[start]
    members.length = 0
    stack.push(start)
    seen[start] = 1
    let lockedInside = false
    while (stack.length) {
      const i = stack.pop()!
      members.push(i)
      if (o.locked?.[i]) lockedInside = true
      const x = i % w,
        y = (i / w) | 0
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || seen[j] || cells[j] !== color) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (members.length >= o.minSize || lockedInside) continue
    // 四周的颜色各接触几次
    const touch = new Map<number, number>()
    for (const i of members) {
      const x = i % w,
        y = (i / w) | 0
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || cells[j] === color) continue
        touch.set(cells[j], (touch.get(cells[j]) ?? 0) + 1)
      }
    }
    const around = [...touch.entries()].filter(([c]) => c !== EMPTY)
    let target: number
    if (!around.length) {
      // 四周全空（或贴着边）：孤点删掉
      if (!touch.size) continue
      target = EMPTY
    } else {
      const top = Math.max(...around.map(([, n]) => n))
      const own = labOf(color)
      const ranked = around
        .filter(([, n]) => n === top)
        .map(([c]) => [c, deltaE(own, labOf(c))] as const)
        .sort((x, y) => x[1] - y[1])
      if (ranked[0][1] > limit) continue
      target = ranked[0][0]
      if (gap[color * n + target] >= STROKE_CONTRAST) {
        if (strokeSize(members, color, target) >= stroke) continue
        if (isolated(target)) {
          changed += unify(target)
          continue
        }
      }
    }
    for (const i of members) cells[i] = target
    changed += members.length
  }
  return { grid: { ...g, cells }, changed }
}
