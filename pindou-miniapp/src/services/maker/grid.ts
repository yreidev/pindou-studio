// 图纸在手机上的样子和存到后端的编码（docs/api.yaml 的 BeadPattern）。
//
// 格子是 Uint8Array，按行排，EMPTY 是空，其余是 colors（色号）里的序号；后端的 cells 每格一个字符：
// 「.」是空，0-9、a-z、A-Z、_、- 依次是第 0～63 个颜色。拼完的格子是按行的位图，第 i 格是第 i>>3 字节的第 i&7 位（低位在前），标准 base64。

export const EMPTY = 255
export const MAX_COLORS = 64
export const MIN_SIDE = 4
export const MAX_SIDE = 300
const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'

export type Grid = {
  width: number
  height: number
  palette: string
  /** 用到的色号，cells 里的序号指向它 */
  colors: string[]
  cells: Uint8Array
}

export function blankGrid(width: number, height: number, palette: string): Grid {
  return { width, height, palette, colors: [], cells: new Uint8Array(width * height).fill(EMPTY) }
}

export const cloneGrid = (g: Grid): Grid => ({ ...g, colors: [...g.colors], cells: g.cells.slice() })

/** 色号在 colors 里的序号，没有就加进去；满 64 种时返回 -1。 */
export function colorIndex(g: Grid, code: string): number {
  const at = g.colors.indexOf(code)
  if (at >= 0) return at
  if (g.colors.length >= MAX_COLORS) return -1
  g.colors.push(code)
  return g.colors.length - 1
}

/** 去掉没用到的颜色，序号按第一次出现的先后重排（存之前做，后端只收用到的）。 */
export function compact(g: Grid): Grid {
  const map = new Int16Array(256).fill(-1)
  const colors: string[] = []
  const cells = new Uint8Array(g.cells.length)
  for (let i = 0; i < g.cells.length; i++) {
    const c = g.cells[i]
    if (c === EMPTY) {
      cells[i] = EMPTY
      continue
    }
    if (map[c] < 0) {
      map[c] = colors.length
      colors.push(g.colors[c])
    }
    cells[i] = map[c]
  }
  return { ...g, colors, cells }
}

export function encodeCells(cells: Uint8Array): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) out += cells[i] === EMPTY ? '.' : chars[cells[i]]
  return out
}

export function decodeCells(text: string, colors: number): Uint8Array | undefined {
  const cells = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '.') {
      cells[i] = EMPTY
      continue
    }
    const at = chars.indexOf(ch)
    if (at < 0 || at >= colors) return undefined
    cells[i] = at
  }
  return cells
}

const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += base64Chars[(n >> 18) & 63] + base64Chars[(n >> 12) & 63]
    out += i + 1 < bytes.length ? base64Chars[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? base64Chars[n & 63] : '='
  }
  return out
}

export function fromBase64(text: string): Uint8Array | undefined {
  if (text.length % 4) return undefined
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - pad)
  for (let i = 0, o = 0; i < text.length; i += 4) {
    let n = 0
    for (let j = 0; j < 4; j++) {
      const ch = text[i + j]
      const v = ch === '=' ? 0 : base64Chars.indexOf(ch)
      if (v < 0) return undefined
      n = (n << 6) | v
    }
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** 拼完的格子：位图，一格一位；空格子的位总是 0。 */
export const blankDone = (g: Grid) => new Uint8Array(Math.ceil(g.cells.length / 8))
export const isDone = (done: Uint8Array, i: number) => (done[i >> 3] & (1 << (i & 7))) !== 0
export function setDone(done: Uint8Array, i: number, on: boolean) {
  if (on) done[i >> 3] |= 1 << (i & 7)
  else done[i >> 3] &= ~(1 << (i & 7))
}

/** 存之前：清掉空格子的位，一格都没拼时是空串（后端的规矩）。 */
export function encodeDone(g: Grid, done: Uint8Array): string {
  let any = false
  const bits = done.slice(0, Math.ceil(g.cells.length / 8))
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === EMPTY) setDone(bits, i, false)
    else if (isDone(bits, i)) any = true
  }
  return any ? toBase64(bits) : ''
}

export function decodeDone(g: Grid, text: string): Uint8Array | undefined {
  if (!text) return blankDone(g)
  const bits = fromBase64(text)
  return bits && bits.length === Math.ceil(g.cells.length / 8) ? bits : undefined
}

/** 有豆子的格数、其中拼完的格数。 */
export function beadCounts(g: Grid, done?: Uint8Array) {
  let beads = 0,
    finished = 0
  for (let i = 0; i < g.cells.length; i++) {
    if (g.cells[i] === EMPTY) continue
    beads++
    if (done && isDone(done, i)) finished++
  }
  return { beads, done: finished }
}

/** 每种颜色几颗，按颗数从多到少（同样多的按色号）。 */
export function colorCounts(g: Grid): { index: number; code: string; count: number }[] {
  const counts = new Int32Array(g.colors.length)
  for (let i = 0; i < g.cells.length; i++) if (g.cells[i] !== EMPTY) counts[g.cells[i]]++
  return g.colors
    .map((code, index) => ({ index, code, count: counts[index] }))
    .filter((c) => c.count > 0)
    .sort((x, y) => y.count - x.count || (x.code < y.code ? -1 : 1))
}

/** 随机的 UUID v4（新建的图纸由手机给编号，后端只核对格式）。 */
export function newId(random: () => number = Math.random): string {
  const b = Array.from({ length: 16 }, () => Math.floor(random() * 256))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.map((v) => v.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 名字的规矩和后端一样：去掉首尾空白，1～20 个字，不能有换行等控制字符。不合规矩回 undefined。 */
export function cleanName(v: string): string | undefined {
  const name = v.trim()
  const length = Array.from(name).length
  return length >= 1 && length <= 20 && !/\p{Cc}/u.test(name) ? name : undefined
}
