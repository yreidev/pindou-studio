import Taro from '@tarojs/taro'
import type { CropRatio } from './crop'
import { styleSettings, styleTone, type Style } from './generate'
import { fullPlacement, type Pixels, type Placement, type Tone } from './image'
import { defaultPaletteId, palette } from './palettes'
import type { Draft } from './store'

// 做图纸几页之间传的东西：照片的像素很大，不进存储、不进页面参数，只放在内存里。
// 小程序被关掉就没了——图纸本身每一步都存在手机上（store.ts），照片没了只影响「改照片」和「对照原图」。
// 照片不上传：只在手机上缩小、取色（docs/plan-bead-maker.md 第 0 节）。

export type Photo = {
  path: string
  pixels: Pixels
  placement: Placement
  tone: Tone
  style: Style
  /** 裁剪框选的比例（框的形状本身记在 placement.crop 里） */
  ratio: CropRatio
  /** 抠图（试用，2026-10-22）：开着时转图用抠好的照片；抠好的结果记着，关了再开不用重抠 */
  cut?: boolean
  cutout?: Pixels
}

export type MakeSettings = {
  cols: number
  maxColors: number
  paletteId: string
  /** 只用店里有的颜色（色卡是店里那套时才有这个选项） */
  onlyStore: boolean
  minCluster: number
}

const paletteKey = 'maker:palette'

/** 这台手机上次选的色卡；没选过用店里的，店里没设置用 MARD 221。 */
export function rememberedPalette(storePalette?: string): string {
  try {
    const saved = Taro.getStorageSync(paletteKey)
    if (typeof saved === 'string' && palette(saved)) return saved
  } catch {
    /* 读不到就用默认 */
  }
  return storePalette && palette(storePalette) ? storePalette : defaultPaletteId
}

export function rememberPalette(id: string) {
  try {
    Taro.setStorageSync(paletteKey, id)
  } catch {
    /* 记不住也不影响这次 */
  }
}

export const session: {
  photo?: Photo
  settings?: MakeSettings
  /** 刚生成或刚打开、还没进改图页的图纸 */
  draft?: Draft
  /** 生成这张图纸用的照片（调整好的），改图页「对照原图」用；按图纸编号记 */
  reference?: { id: string; pixels: Pixels }
} = {}

export function startPhoto(path: string, pixels: Pixels) {
  session.photo = {
    path,
    pixels,
    placement: fullPlacement(),
    tone: styleTone('real'),
    style: 'real',
    ratio: 'photo',
  }
}

export const defaultSettings = (storePalette?: string): MakeSettings => ({
  cols: 52,
  ...styleSettings('real'),
  paletteId: rememberedPalette(storePalette),
  onlyStore: false,
})
