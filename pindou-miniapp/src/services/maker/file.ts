import {
  cleanName,
  compact,
  decodeCells,
  decodeDone,
  EMPTY,
  encodeCells,
  encodeDone,
  MAX_COLORS,
  MAX_SIDE,
  MIN_SIDE,
  type Grid,
} from './grid'
import { palette } from './palettes'

// 图纸文件和表格（docs/plan-bead-maker.md 第 3 节 7）：导出给朋友、换手机后导回来接着改。
// 文件是 JSON，字段和后端的图纸一样；导入时按后端同样的规矩核对（名字 1～20 字、色卡认得、宽高 4～300、颜色最多 64 种不重复、
// 格子正好宽×高个字符、拼完的位图长度对得上），不合规矩的说清楚哪里不对。
// 表格是 CSV：第一行「宽,高,色卡编号」，往下每行一行格子，每格一个色号，空格子留空。

export const FILE_FORMAT = 'examplebrand-bead-pattern'
export const FILE_VERSION = 1

export { cleanName }

export type PatternData = { name: string; grid: Grid; done: Uint8Array }

export function toFile(p: PatternData): string {
  // 去掉没用到的颜色（序号会变，格子位置不变，拼完的位图照用）
  const g = compact(p.grid)
  return JSON.stringify({
    format: FILE_FORMAT,
    version: FILE_VERSION,
    name: cleanName(p.name) ?? p.name,
    palette: g.palette,
    width: g.width,
    height: g.height,
    colors: g.colors,
    cells: encodeCells(g.cells),
    done: encodeDone(g, p.done),
  })
}

export type Parsed = { ok: true; pattern: PatternData } | { ok: false; error: string }

const fail = (error: string): Parsed => ({ ok: false, error })

export function fromFile(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('这不是图纸文件')
  }
  if (!raw || typeof raw !== 'object') return fail('这不是图纸文件')
  const o = raw as Record<string, unknown>
  if (o.format !== FILE_FORMAT) return fail('这不是图纸文件')
  if (typeof o.version !== 'number' || o.version > FILE_VERSION)
    return fail('这个图纸文件是新版本做的，先把小程序更新到最新')
  const name = typeof o.name === 'string' ? cleanName(o.name) : undefined
  if (!name) return fail('图纸名字要 1～20 个字')
  const p = typeof o.palette === 'string' ? palette(o.palette) : undefined
  if (!p) return fail('没有这套色卡')
  const { width, height } = o
  if (!isSide(width) || !isSide(height)) return fail(`图纸宽、高要在 ${MIN_SIDE}～${MAX_SIDE} 格之间`)
  const colors = o.colors
  if (
    !Array.isArray(colors) ||
    colors.length > MAX_COLORS ||
    new Set(colors).size !== colors.length ||
    !colors.every((c) => typeof c === 'string' && p.index.has(c))
  )
    return fail('颜色最多 64 种，每种都要是这套色卡里的色号，不能重复')
  const cells =
    typeof o.cells === 'string' && o.cells.length === width * height ? decodeCells(o.cells, colors.length) : undefined
  if (!cells) return fail('格子数据不对')
  const grid: Grid = { width, height, palette: p.id, colors: colors as string[], cells }
  const done = decodeDone(grid, typeof o.done === 'string' ? o.done : '')
  if (!done) return fail('拼完的格子数据不对')
  return { ok: true, pattern: { name, grid, done } }
}

const isSide = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= MIN_SIDE && v <= MAX_SIDE

/** 表格：第一行宽、高、色卡编号，往下每行一行格子。 */
export function toCsv(g: Grid): string {
  const lines = [`${g.width},${g.height},${g.palette}`]
  for (let y = 0; y < g.height; y++) {
    const row: string[] = []
    for (let x = 0; x < g.width; x++) {
      const v = g.cells[y * g.width + x]
      row.push(v === EMPTY ? '' : g.colors[v])
    }
    lines.push(row.join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export type ParsedCsv = { ok: true; grid: Grid } | { ok: false; error: string }

export function fromCsv(text: string): ParsedCsv {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const head = (lines.shift() ?? '').split(',').map((v) => v.trim())
  const width = Number(head[0]),
    height = Number(head[1])
  const p = head[2] ? palette(head[2]) : undefined
  if (!isSide(width) || !isSide(height) || !p)
    return { ok: false, error: '第一行要写宽、高和色卡编号，比如 40,40,mard-221' }
  if (lines.length !== height) return { ok: false, error: `表格应该有 ${height} 行格子，实际是 ${lines.length} 行` }
  const grid: Grid = { width, height, palette: p.id, colors: [], cells: new Uint8Array(width * height).fill(EMPTY) }
  const slot = new Map<string, number>()
  for (let y = 0; y < height; y++) {
    const row = lines[y].split(',').map((v) => v.trim().toUpperCase())
    // 行尾全是空格子时有的表格软件会省掉逗号
    if (row.length > width) return { ok: false, error: `第 ${y + 2} 行有 ${row.length} 格，比宽度 ${width} 多` }
    for (let x = 0; x < row.length; x++) {
      const code = row[x]
      if (!code) continue
      if (!p.index.has(code))
        return { ok: false, error: `第 ${y + 2} 行第 ${x + 1} 格的「${code}」不是 ${p.name} 的色号` }
      let i = slot.get(code)
      if (i === undefined) {
        if (grid.colors.length >= MAX_COLORS) return { ok: false, error: '颜色最多 64 种' }
        i = grid.colors.length
        grid.colors.push(code)
        slot.set(code, i)
      }
      grid.cells[y * width + x] = i
    }
  }
  return { ok: true, grid }
}
