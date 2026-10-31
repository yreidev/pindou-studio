import { EMPTY, isDone, setDone, type Grid } from './grid'

// 用豆清单和边拼边看（docs/plan-bead-maker.md 第 1 节）：按底板分块、每块每种颜色几颗、按行的「A6 5 颗、G8 2 颗……」、
// 成品几厘米、要几块底板、进度。

export type Board = { index: number; col: number; row: number; x: number; y: number; w: number; h: number }

/** 按底板（size×size 格）从左到右、从上到下分块；最右、最下的一块可能不满。 */
export function boards(g: Grid, size: number): Board[] {
  const cols = Math.ceil(g.width / size),
    rows = Math.ceil(g.height / size)
  const out: Board[] = []
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const x = col * size,
        y = row * size
      out.push({ index: out.length, col, row, x, y, w: Math.min(size, g.width - x), h: Math.min(size, g.height - y) })
    }
  return out
}

export const boardsNeeded = (g: Grid, size: number) => Math.ceil(g.width / size) * Math.ceil(g.height / size)

/** 成品大约多大（厘米，一位小数）：每颗豆子 beadMm 毫米。 */
export function finishedSize(g: Grid, beadMm: number) {
  const cm = (n: number) => Math.round(n * beadMm) / 10
  return { width: cm(g.width), height: cm(g.height) }
}

/** 一块板（不给就是整张）里每种颜色几颗、拼完几颗，按颗数从多到少。 */
export function boardColors(g: Grid, done: Uint8Array, b?: Board) {
  const total = new Int32Array(g.colors.length),
    finished = new Int32Array(g.colors.length)
  const r = b ?? { x: 0, y: 0, w: g.width, h: g.height }
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = y * g.width + x,
        v = g.cells[i]
      if (v === EMPTY) continue
      total[v]++
      if (isDone(done, i)) finished[v]++
    }
  return g.colors
    .map((code, index) => ({ index, code, count: total[index], done: finished[index] }))
    .filter((c) => c.count > 0)
    .sort((x, y) => y.count - x.count || (x.code < y.code ? -1 : 1))
}

/** 一块板里某种颜色全标成拼完（on 为假是全取消）。返回改了几格。 */
export function markColor(g: Grid, done: Uint8Array, b: Board, color: number, on: boolean) {
  let changed = 0
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      const i = y * g.width + x
      if (g.cells[i] !== color || isDone(done, i) === on) continue
      setDone(done, i, on)
      changed++
    }
  return changed
}

/** 一行从左到右的连续段：同色连着的算一段，空格子也算一段（color 为 EMPTY，「空 3 格」）。 */
export function rowRuns(g: Grid, y: number): { color: number; start: number; count: number }[] {
  const out: { color: number; start: number; count: number }[] = []
  for (let x = 0; x < g.width; x++) {
    const v = g.cells[y * g.width + x]
    const last = out[out.length - 1]
    if (last && last.color === v) last.count++
    else out.push({ color: v, start: x, count: 1 })
  }
  // 行尾的空格子不用说
  if (out.length && out[out.length - 1].color === EMPTY) out.pop()
  return out
}

/** 一行全标成拼完（或全取消）。 */
export function markRow(g: Grid, done: Uint8Array, y: number, on: boolean) {
  for (let x = 0; x < g.width; x++) {
    const i = y * g.width + x
    if (g.cells[i] !== EMPTY) setDone(done, i, on)
  }
}

/** 这一行拼完了没有（没有豆子的行算拼完）。 */
export function rowDone(g: Grid, done: Uint8Array, y: number) {
  for (let x = 0; x < g.width; x++) {
    const i = y * g.width + x
    if (g.cells[i] !== EMPTY && !isDone(done, i)) return false
  }
  return true
}

/** 从第 y 行往下找第一行还没拼完的；都拼完了回 -1。 */
export function nextRow(g: Grid, done: Uint8Array, y: number) {
  for (let r = y; r < g.height; r++) if (!rowDone(g, done, r)) return r
  return -1
}

/** 进度百分比（整数，向下取整；全拼完才是 100）。 */
export function progress(beads: number, finished: number) {
  if (!beads) return 0
  return finished >= beads ? 100 : Math.floor((finished * 100) / beads)
}
