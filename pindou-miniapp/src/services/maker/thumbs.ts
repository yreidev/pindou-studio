import Taro from '@tarojs/taro'
import { decodeCells, EMPTY, encodeCells, type Grid } from './grid'
import { palette } from './palettes'
import { indexedPng } from './png'

// 「我的图纸」列表的缩略图：后端给的缩略格子（长边 32 以内）编成 PNG。
// 写成本地文件再给 <Image>（文档写明支持本地路径）。

const emptyColor = 0xf1eadc

export type Thumb = {
  id: string
  revision: number
  palette: string
  colors: string[]
  preview: string
  previewWidth: number
  previewHeight: number
}

/** 编码好的 PNG；格子不对时是 undefined。 */
export function thumbPng(t: Thumb): Uint8Array | undefined {
  const p = palette(t.palette)
  const cells = decodeCells(t.preview, t.colors.length)
  if (!p || !cells || cells.length !== t.previewWidth * t.previewHeight) return undefined
  const colors = [emptyColor, ...t.colors.map((code) => p.colors[p.index.get(code) ?? 0]?.rgb ?? 0)]
  const index = cells.map((v) => (v === EMPTY ? 0 : v + 1))
  const scale = Math.max(1, Math.floor(128 / Math.max(t.previewWidth, t.previewHeight)))
  return indexedPng(index, t.previewWidth, t.previewHeight, colors, scale)
}

const PREVIEW_SIDE = 32

/** 手机上的图纸自己算缩略格子，取法和后端 Preview 一样：每 step×step 一块，空格子过半是空，否则取最多的颜色（一样多取序号小的）。 */
export function previewOf(g: Grid): Pick<Thumb, 'preview' | 'previewWidth' | 'previewHeight'> {
  const step = Math.ceil(Math.max(g.width, g.height) / PREVIEW_SIDE)
  const pw = Math.ceil(g.width / step),
    ph = Math.ceil(g.height / step)
  const out = new Uint8Array(pw * ph)
  const counts = new Int32Array(64)
  for (let py = 0; py < ph; py++)
    for (let px = 0; px < pw; px++) {
      counts.fill(0)
      let total = 0,
        empty = 0
      for (let y = py * step; y < Math.min((py + 1) * step, g.height); y++)
        for (let x = px * step; x < Math.min((px + 1) * step, g.width); x++) {
          total++
          const v = g.cells[y * g.width + x]
          if (v === EMPTY) empty++
          else counts[v]++
        }
      let best = 0
      for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k
      out[py * pw + px] = empty * 2 > total ? EMPTY : best
    }
  return { preview: encodeCells(out), previewWidth: pw, previewHeight: ph }
}

/** 给 <Image> 的地址。 */
export function thumbSrc(t: Thumb): string {
  const png = thumbPng(t)
  if (!png) return ''
  const fs = Taro.getFileSystemManager()
  const dir = Taro.env.USER_DATA_PATH ?? ''
  const name = `maker-thumb-${t.id}-${t.revision}.png`
  try {
    fs.accessSync(`${dir}/${name}`)
    return `${dir}/${name}`
  } catch {
    /* 还没写过 */
  }
  try {
    // 同一张的旧版本删掉
    for (const file of fs.readdirSync(dir))
      if (file.startsWith(`maker-thumb-${t.id}-`) && file !== name) fs.unlinkSync(`${dir}/${file}`)
    fs.writeFileSync(`${dir}/${name}`, png.buffer as ArrayBuffer)
    return `${dir}/${name}`
  } catch {
    return ''
  }
}
