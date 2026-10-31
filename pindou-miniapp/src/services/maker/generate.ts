import { cleanup } from './cleanup'
import { keepDots } from './dots'
import { compact, EMPTY, MAX_COLORS, MAX_SIDE, MIN_SIDE, type Grid } from './grid'
import { adjust, place, resize, smooth, type Pixels, type Placement, type Tone } from './image'
import { wholeImage, type Step } from './mrf'
import { outline } from './outline'
import { modeSample, nearestGrid } from './nearest'
import { greys, type Palette } from './palettes'
import { choose, sample } from './quantize'

// 照片 → 图纸的整条流水线（docs/plan-bead-maker.md 第 3 节）：摆好（转、翻、裁）→ 调色 →
// 缩到「格数 × 4」→（卡通）保边平滑 → 按格取主色、保细线、保小黑点 → 挑颜色 → 整张配色 → 清掉零星小块。
// 「描边」画风另走 outline.ts；「写实」（默认）每格直接对到最接近的颜色，另走 nearest.ts。每一步之间让出主线程（await pause()），大图生成时界面还能动；
// 给了 cancelled 的话让出时看一眼，不用算了就抛 Cancelled（照片页改了设置，上一次的预览不用算完）。

/**
 * 风格：写实（默认，2026-10-21 业主定：每格直接对到最接近的颜色，最像照片）、卡通（并色更干净、颜色少，好拼）、
 * 原样、鲜艳、黑白（只用色卡里的灰色系）、描边（平涂加一格宽的深色描边）。styleNames 的顺序就是页面上的顺序。
 */
export type Style = 'real' | 'plain' | 'cartoon' | 'vivid' | 'mono' | 'outline'
export const styleNames: Record<Style, string> = {
  real: '写实',
  cartoon: '卡通',
  plain: '原样',
  vivid: '鲜艳',
  mono: '黑白',
  outline: '描边',
}
/** 选了这种风格时的提示 */
export const styleHints: Partial<Record<Style, string>> = {
  real: '最像照片，颜色多、豆子种类也多',
  cartoon: '色块干净、颜色少，好拼',
  outline: '适合卡通、玩偶、宠物，真人照片建议用写实或卡通',
}

/** 选风格时「颜色最多」「清掉零星小块」跟着变成这一套，之后还能自己改：写实颜色放到最多 64 种、只清单颗的杂色。 */
export function styleSettings(style: Style): { maxColors: number; minCluster: number } {
  return style === 'real' ? { maxColors: MAX_COLORS, minCluster: 2 } : { maxColors: 15, minCluster: 3 }
}

/** 选风格时调色的几项跟着变成这一套，之后还能自己拖。 */
export function styleTone(style: Style): Tone {
  switch (style) {
    case 'cartoon':
    case 'outline':
      return { brightness: 0, contrast: 6, saturation: 8, sharpness: 0 }
    case 'vivid':
      return { brightness: 0, contrast: 12, saturation: 45, sharpness: 10 }
    case 'mono':
      return { brightness: 0, contrast: 12, saturation: -100, sharpness: 0 }
    default:
      return { brightness: 0, contrast: 0, saturation: 0, sharpness: 0 }
  }
}

export type MakeOptions = {
  /** 宽多少格，高按照片比例算 */
  cols: number
  palette: Palette
  /** 能用的颜色（色卡序号）；不给是整套 */
  allowed?: readonly number[]
  maxColors: number
  /** 清掉少于几颗的零星小块，0 或 1 是不清 */
  minCluster: number
  style: Style
  /** 返回 true 时不用算了（让出主线程时看） */
  cancelled?: () => boolean
}

export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 生成到一半不用算了。 */
export class Cancelled extends Error {}

/** 整张配色的 λ：原样并得轻一点（颜色差不许比第一代大），其余按卡通（转图基准和 51 张留出照片定的）。 */
const lambdaOf = (style: Style) => (style === 'plain' ? 15 : 30)

/** 高按比例算，限在 4～300 格。 */
export function rowsFor(cols: number, width: number, height: number) {
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round((cols * height) / width)))
}

/** 调整好的照片（摆好、调好色）。调整照片页的大图和生成都用它。 */
export function prepare(src: Pixels, placement: Placement, tone: Tone): Pixels {
  return adjust(place(src, placement), tone)
}

export async function make(view: Pixels, o: MakeOptions): Promise<Grid> {
  const cols = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(o.cols)))
  const rows = rowsFor(cols, view.width, view.height)
  let last = Date.now()
  const yieldNow = async () => {
    await pause()
    last = Date.now()
    if (o.cancelled?.()) throw new Cancelled()
  }
  // 整张配色里每解一次图割都可能让出，但隔 30 毫秒以上才真让（setTimeout 本身就要几毫秒）
  const step: Step = async () => {
    if (Date.now() - last >= 30) await yieldNow()
  }
  if (o.style === 'real') {
    // 主色直接从调整好的照片上取（长边最多 1600 像素），不先缩小：缩小就是求平均，细节会和旁边混掉。
    // 格子里没有哪个颜色出现够 3 次的（照片太小、噪点多），退回按两簇取平均（第 3 节 1）
    const small = resize(view, cols * 4, rows * 4)
    await yieldNow()
    const samples = modeSample(view, cols, rows, sample(small, cols, rows, false))
    await yieldNow()
    let grid = await nearestGrid(samples, o.palette, { allowed: o.allowed, maxColors: o.maxColors }, step)
    await yieldNow()
    if (o.minCluster > 1) grid = cleanup(grid, o.palette, { minSize: o.minCluster }).grid
    return sortByCount(compact(grid))
  }
  if (o.style === 'outline') {
    // 描边的色块并得更狠：清零星比设置的多一颗（默认 3 → 4）
    const minCluster = o.minCluster > 1 ? o.minCluster + 1 : 0
    const g = await outline(
      view,
      { cols, rows, palette: o.palette, allowed: o.allowed, maxColors: o.maxColors, minCluster },
      step,
    )
    return sortByCount(compact(g))
  }
  const small = resize(view, cols * 4, rows * 4)
  await yieldNow()
  const samples = sample(small, cols, rows)
  await yieldNow()
  if (o.style === 'cartoon') {
    // 卡通：取保边平滑以后的颜色，大片更匀。平滑会抹掉不到两像素宽的细线（嘴、胡须），
    // 所以取了细线颜色的格子、平滑前后明暗差得多（细节被抹掉了）的格子照原图
    const flat = sample(smooth(small, 2), cols, rows, false)
    for (let i = 0; i < cols * rows; i++)
      if (!samples.lines?.[i] && Math.abs(samples.color[i * 3] - flat.color[i * 3]) < 0.12)
        samples.color.set(flat.color.subarray(i * 3, i * 3 + 3), i * 3)
    await yieldNow()
  }
  // 一两格的小黑点（眼睛、鼻孔）不被肤色、毛色吃掉，标成线
  keepDots(small, samples)
  let allowed = o.allowed
  if (o.style === 'mono') {
    const grey = greys(o.palette)
    const narrowed = allowed?.length ? grey.filter((c) => allowed!.includes(c)) : grey
    allowed = narrowed.length ? narrowed : allowed
  }
  const first = choose(samples, { palette: o.palette, allowed, maxColors: o.maxColors })
  await yieldNow()
  let grid = await wholeImage(samples, first, o.palette, { lambda: lambdaOf(o.style) }, step)
  await yieldNow()
  // 取样时认出来的暗线（描边、眼睛、字的笔画）和小黑点不当零星并掉
  const strokes = samples.lines?.map((v) => (v === 1 ? 1 : 0))
  if (o.minCluster > 1) grid = cleanup(grid, o.palette, { minSize: o.minCluster, locked: strokes }).grid
  return sortByCount(compact(grid))
}

/** colors 按颗数从多到少重排（生成、去零星之后用）。 */
export function sortByCount(g: Grid): Grid {
  const counts = new Int32Array(g.colors.length)
  for (const c of g.cells) if (c !== EMPTY) counts[c]++
  const order = g.colors.map((_, i) => i).sort((a, b) => counts[b] - counts[a] || a - b)
  const slot = new Uint8Array(g.colors.length)
  order.forEach((old, i) => (slot[old] = i))
  return {
    ...g,
    colors: order.map((i) => g.colors[i]),
    cells: g.cells.map((c) => (c === EMPTY ? EMPTY : slot[c])),
  }
}
