import data from '../../../../palettes/palettes.json'
import { deltaE, lab, oklabInto, parseHex, type Lab } from './color'

// 色卡（仓库根 palettes/palettes.json，来源和许可证见同目录 README）：国内 6 套、国外 11 套。
// 后端只核对色卡编号和色号；取色、配色都在这里算。每种颜色的 Lab、OKLab 在第一次用到这套色卡时算好。

export type PaletteColor = { code: string; hex: string; rgb: number; lab: Lab }
export type Palette = {
  id: string
  name: string
  brand: string
  region: 'cn' | 'intl'
  colors: PaletteColor[]
  /** 每种颜色的 OKLab，三个数一组，和 colors 同序 */
  oklab: Float32Array
  /** 色号 → colors 里的序号 */
  index: Map<string, number>
}

type Raw = { id: string; name: string; brand: string; region: 'cn' | 'intl'; colors: [string, string][] }
const raw = (data as unknown as { palettes: Raw[] }).palettes

/** 没设置过时店里用的色卡（与后端 palettes.Default 一致）。 */
export const defaultPaletteId = 'mard-221'

export const paletteList: readonly { id: string; name: string; brand: string; region: 'cn' | 'intl'; size: number }[] =
  raw.map((p) => ({ id: p.id, name: p.name, brand: p.brand, region: p.region, size: p.colors.length }))

const built = new Map<string, Palette>()

/** 取一套色卡；没有这个编号时为 undefined。 */
export function palette(id: string): Palette | undefined {
  const cached = built.get(id)
  if (cached) return cached
  const source = raw.find((p) => p.id === id)
  if (!source) return undefined
  const oklab = new Float32Array(source.colors.length * 3)
  const colors = source.colors.map(([code, value], i) => {
    const rgb = parseHex(value)
    oklabInto((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, oklab, i * 3)
    return { code, hex: value, rgb, lab: lab(rgb) }
  })
  const result: Palette = {
    id: source.id,
    name: source.name,
    brand: source.brand,
    region: source.region,
    colors,
    oklab,
    index: new Map(colors.map((c, i) => [c.code, i])),
  }
  built.set(id, result)
  return result
}

/** 选色卡页的分组：国内、国外，各自按牌子排（牌子按文件里第一次出现的顺序）。 */
export function paletteGroups() {
  const groups: { region: 'cn' | 'intl'; brands: { brand: string; palettes: typeof paletteList }[] }[] = []
  for (const region of ['cn', 'intl'] as const) {
    const brands: { brand: string; palettes: (typeof paletteList)[number][] }[] = []
    for (const p of paletteList.filter((item) => item.region === region)) {
      let entry = brands.find((b) => b.brand === p.brand)
      if (!entry) brands.push((entry = { brand: p.brand, palettes: [] }))
      entry.palettes.push(p)
    }
    groups.push({ region, brands })
  }
  return groups
}

/** 灰色系：黑白风格只用这些（OKLab 色度小于 0.03）。 */
export function greys(p: Palette): number[] {
  const out: number[] = []
  for (let i = 0; i < p.colors.length; i++) {
    const a = p.oklab[i * 3 + 1],
      b = p.oklab[i * 3 + 2]
    if (Math.hypot(a, b) < 0.03) out.push(i)
  }
  return out
}

/** among 里和 code 最接近的色号（CIEDE2000）；among 是空的时为 undefined。 */
export function closest(p: Palette, code: string, among: Iterable<string>): string | undefined {
  const from = p.colors[p.index.get(code) ?? -1]
  if (!from) return undefined
  let best: string | undefined,
    bd = Infinity
  for (const c of among) {
    const to = p.colors[p.index.get(c) ?? -1]
    if (!to || c === code) continue
    const d = deltaE(from.lab, to.lab)
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best
}
