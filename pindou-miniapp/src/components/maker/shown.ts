import type { Pixels } from '../../services/maker/image'
import { resize } from '../../services/maker/image'
import type { DrawContext } from './canvas'

/** 画布上显示的图：按画布的物理像素缩好，左上角在 (x, y)（CSS 像素），w、h 是 CSS 像素。 */
export type Shown = { pixels: Pixels; x: number; y: number; w: number; h: number }

export function fitShown(img: Pixels, width: number, height: number, ratio: number): Shown {
  const k = Math.min(width / img.width, height / img.height)
  const w = Math.max(1, Math.floor(img.width * k)),
    h = Math.max(1, Math.floor(img.height * k))
  return {
    pixels: resize(img, Math.round(w * ratio), Math.round(h * ratio)),
    x: (width - w) / 2,
    y: (height - h) / 2,
    w,
    h,
  }
}

/** 透明的地方垫上浅色格子（抠掉的背景）。 */
export function overChecker(img: Pixels, cell = 12): Pixels {
  const out = { ...img, data: img.data.slice() }
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const a = img.data[i + 3] / 255
      const bg = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 236 : 250
      for (let c = 0; c < 3; c++) out.data[i + c] = img.data[i + c] * a + bg * (1 - a)
      out.data[i + 3] = 255
    }
  return out
}

export function putShown(
  ctx: DrawContext,
  shown: Shown,
  ratio: number,
  background: string,
  width: number,
  height: number,
) {
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  const data = ctx.createImageData(shown.pixels.width, shown.pixels.height)
  data.data.set(shown.pixels.data)
  ctx.putImageData(data, Math.round(shown.x * ratio), Math.round(shown.y * ratio))
}
