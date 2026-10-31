// 做图纸用的豆子卡片的计算（docs/plan-bead-maker.md 第 2 节）。色卡数据只有一份：仓库根 palettes/palettes.json，
// 小程序、后端用的也是它（后端是复制进去的副本，测试核对一致）。
import data from '../../../../palettes/palettes.json'
import type { BeadSettings, BeadSettingsInput } from '../../api/beads'

export type BeadPalette = {
  id: string
  name: string
  brand: string
  region: 'cn' | 'intl'
  colors: { code: string; hex: string }[]
}

type Raw = { id: string; name: string; brand: string; region: 'cn' | 'intl'; colors: [string, string][] }

export const palettes: BeadPalette[] = (data as unknown as { palettes: Raw[] }).palettes.map((p) => ({
  ...p,
  colors: p.colors.map(([code, hex]) => ({ code, hex })),
}))

export const paletteById = (id: string) => palettes.find((p) => p.id === id)

/** 下拉框的分组：国内、国外。 */
export const paletteGroups = (['cn', 'intl'] as const).map((region) => ({
  label: region === 'cn' ? '国内' : '国外',
  options: palettes.filter((p) => p.region === region).map((p) => ({ value: p.id, label: p.name })),
}))

export const maxBox = 8
export const minBoard = 10
export const maxBoard = 150

/** 编辑中的设置：available 是店里有的色号（全有时是整套）。 */
export type BeadDraft = {
  palette: string
  available: Set<string>
  boxes: Record<string, string>
  boardSize: number
  beadSize: BeadSettings['beadSize']
}

export function draftFrom(s: BeadSettings): BeadDraft {
  const p = paletteById(s.palette)
  return {
    palette: s.palette,
    available: new Set(s.available ?? p?.colors.map((c) => c.code) ?? []),
    boxes: { ...s.boxes },
    boardSize: s.boardSize,
    beadSize: s.beadSize,
  }
}

/** 换色卡：同一个色号在不同牌子里是不同的颜色，店里有没有、盒号都从头填（默认全有、没有盒号）。 */
export function switchPalette(d: BeadDraft, id: string): BeadDraft {
  const p = paletteById(id)
  return { ...d, palette: id, available: new Set(p?.colors.map((c) => c.code) ?? []), boxes: {} }
}

const boxLength = (text: string) => Array.from(text.trim()).length

/** 存的内容：全有存 null，否则按色卡顺序；盒号去掉首尾空白，空的不存，只存这套色卡里的色号。 */
export function toInput(d: BeadDraft, expectedRevision: number): BeadSettingsInput {
  const p = paletteById(d.palette)
  const codes = p?.colors.map((c) => c.code) ?? []
  const all = codes.every((code) => d.available.has(code))
  const boxes: Record<string, string> = {}
  for (const code of codes) {
    const box = d.boxes[code]?.trim()
    if (box) boxes[code] = box
  }
  return {
    expectedRevision,
    palette: d.palette,
    available: all ? null : codes.filter((code) => d.available.has(code)),
    boxes,
    boardSize: d.boardSize,
    beadSize: d.beadSize,
  }
}

/** 和存着的一样吗（决定「保存」「撤销修改」能不能点）。 */
export function sameAsSaved(d: BeadDraft, s: BeadSettings): boolean {
  const a = toInput(d, s.revision)
  const b = toInput(draftFrom(s), s.revision)
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 不能保存的原因；能保存时是 null。 */
export function draftProblem(d: BeadDraft): string | null {
  const p = paletteById(d.palette)
  if (!p) return '这套色卡没有了，请重新选一套'
  if (p.colors.filter((c) => d.available.has(c.code)).length < 2) return '店里有的颜色至少要 2 种'
  if (!Number.isInteger(d.boardSize) || d.boardSize < minBoard || d.boardSize > maxBoard)
    return `底板一边 ${minBoard}～${maxBoard} 格`
  const long = p.colors.find((c) => boxLength(d.boxes[c.code] ?? '') > maxBox)
  if (long) return `${long.code} 的盒号太长，最多 ${maxBox} 个字`
  return null
}

export const boxProblem = (text: string) => (boxLength(text) > maxBox ? `最多 ${maxBox} 个字` : null)

/** 「店里有 218 / 221 种，填了 40 个盒号」 */
export function draftSummary(d: BeadDraft): string {
  const p = paletteById(d.palette)
  if (!p) return ''
  const have = p.colors.filter((c) => d.available.has(c.code)).length
  const boxes = p.colors.filter((c) => d.boxes[c.code]?.trim()).length
  return `店里有 ${have} / ${p.colors.length} 种，填了 ${boxes} 个盒号`
}

export type Series = { key: string; name: string; codes: string[] }

/**
 * 按系列分页：色号开头的字母相同的一组（MARD 的 A、B……，Artkal 的 MA、MB……）；
 * 纯数字的色号（盼盼、咪小窝、Perler）按色卡顺序每 50 个一组。
 */
export function seriesOf(p: BeadPalette): Series[] {
  const out: Series[] = []
  const byLetter = new Map<string, Series>()
  const plain: string[] = []
  for (const { code } of p.colors) {
    const letters = /^[A-Za-z]+/.exec(code)?.[0].toUpperCase()
    if (!letters) {
      plain.push(code)
      continue
    }
    let s = byLetter.get(letters)
    if (!s) {
      s = { key: letters, name: `${letters} 系列`, codes: [] }
      byLetter.set(letters, s)
      out.push(s)
    }
    s.codes.push(code)
  }
  for (let i = 0; i < plain.length; i += 50) {
    const codes = plain.slice(i, i + 50)
    out.push({ key: `#${i}`, name: `第 ${i + 1}～${i + codes.length} 个`, codes })
  }
  return out
}

export const beadSizeOptions: { value: BeadSettings['beadSize']; label: string }[] = [
  { value: 'mini', label: '2.6 毫米（小豆）' },
  { value: 'midi', label: '5 毫米（大豆）' },
]
