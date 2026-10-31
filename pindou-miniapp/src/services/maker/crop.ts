import { rubberBand } from '../gesture'
import type { Placement, Rect } from './image'

// 裁剪（docs/plan-bead-maker.md 第 3 节 0，2026-10-21 改成「框不动、挪照片」）：框按比例固定在画面中间，
// 顾客一指挪照片、两指捏合缩放，下面的滑杆也能缩放。照片始终盖满框，框里不会露出空白。
// 裁剪结果仍是 Placement.crop（占转好、翻好的图的比例，0～1），框的形状就是 crop 的宽高比（按像素）。
// 都是纯函数，画布上的坐标是 CSS 像素。

export type Frame = { x: number; y: number; w: number; h: number }
/** 框的比例：原图、1:1、3:4、4:3、按底板（正好铺满整块的底板） */
export type CropRatio = 'photo' | 'square' | 'portrait' | 'landscape' | 'board'
export type XY = { x: number; y: number }

/** 最多放大几倍：16 倍（2026-10-21 业主嫌 8 倍不够），而且框里至少留 MIN_CROP_PIXELS 像素宽（很小的像素画放不了那么大）。 */
export const MAX_ZOOM = 16
export const MIN_CROP_PIXELS = 8

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 转好之后的宽高（像素）。 */
export function placedDims(width: number, height: number, rotate: Placement['rotate']): [number, number] {
  return rotate % 2 ? [height, width] : [width, height]
}

/** crop 的宽高比（按像素）。 */
export function aspectOf(c: Rect, W: number, H: number) {
  return (c.w * W) / (c.h * H)
}

/** 这个比例下最大的框（放大 1 倍），在图的正中间。 */
export function fullCrop(W: number, H: number, aspect: number): Rect {
  const w = Math.min(1, (aspect * H) / W),
    h = Math.min(1, W / (aspect * H))
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

/** 框不出图：宽高不超过 1，位置收进图里。 */
export function clampCrop(c: Rect): Rect {
  const w = clamp(c.w, 1e-4, 1),
    h = clamp(c.h, 1e-4, 1)
  return { x: clamp(c.x, 0, 1 - w), y: clamp(c.y, 0, 1 - h), w, h }
}

/** 现在放大了几倍（1 是最大的框）。 */
export function zoomOf(c: Rect, W: number, H: number) {
  return fullCrop(W, H, aspectOf(c, W, H)).w / c.w
}

/** 最多能放大几倍。 */
export function maxZoom(c: Rect, W: number, H: number) {
  const full = fullCrop(W, H, aspectOf(c, W, H))
  const side = Math.min(full.w * W, full.h * H)
  return Math.max(1, Math.min(MAX_ZOOM, side / MIN_CROP_PIXELS))
}

/** 放大到 zoom 倍，框里 anchor 这一点（0～1，默认正中）下面的照片不动。 */
export function zoomCrop(c: Rect, W: number, H: number, zoom: number, anchor: XY = { x: 0.5, y: 0.5 }): Rect {
  const full = fullCrop(W, H, aspectOf(c, W, H))
  const z = clamp(zoom, 1, maxZoom(c, W, H))
  const w = full.w / z,
    h = full.h / z
  const u = c.x + anchor.x * c.w,
    v = c.y + anchor.y * c.h
  return clampCrop({ x: u - anchor.x * w, y: v - anchor.y * h, w, h })
}

/** 一指挪：手指在画布上挪了 (dx, dy)，照片跟着手指走（框往反方向挪）。 */
export function panCrop(c: Rect, frame: Frame, dx: number, dy: number): Rect {
  return clampCrop({ ...c, x: c.x - (dx / frame.w) * c.w, y: c.y - (dy / frame.h) * c.h })
}

/**
 * 一指挪（拖动中，docs/plan-interaction.md 第 4 节）：和 panCrop 一样跟手，c 是按下时的框、(dx, dy) 是手指一共挪了多少；
 * 拖到照片边上不硬停，多出去的按橡皮筋阻尼（换成画布上的像素算，最多再走框的四分之一），松手再用 clampCrop 弹回。
 */
export function dragCrop(c: Rect, frame: Frame, dx: number, dy: number): Rect {
  const w = clamp(c.w, 1e-4, 1),
    h = clamp(c.h, 1e-4, 1)
  const axis = (pos: number, size: number, px: number) => {
    if (pos >= 0 && pos <= 1 - size) return pos
    const edge = pos < 0 ? 0 : 1 - size
    return edge + (rubberBand(((pos - edge) / size) * px, px / 4) / px) * size
  }
  return { x: axis(c.x - (dx / frame.w) * c.w, w, frame.w), y: axis(c.y - (dy / frame.h) * c.h, h, frame.h), w, h }
}

/** 两指缩放：两指距离从 d0 变到 d，捏合开始时两指中点 m0 下面的照片跟着现在的中点 m 走。 */
export function pinchCrop(c0: Rect, W: number, H: number, frame: Frame, d0: number, d: number, m0: XY, m: XY): Rect {
  const full = fullCrop(W, H, aspectOf(c0, W, H))
  const z = clamp((full.w / c0.w) * (d / Math.max(1, d0)), 1, maxZoom(c0, W, H))
  const w = full.w / z,
    h = full.h / z
  const u = c0.x + ((m0.x - frame.x) / frame.w) * c0.w,
    v = c0.y + ((m0.y - frame.y) / frame.h) * c0.h
  return clampCrop({ x: u - ((m.x - frame.x) / frame.w) * w, y: v - ((m.y - frame.y) / frame.h) * h, w, h })
}

/** 换比例：中心尽量不动，放大倍数不变（原来是整张就还是整张）。 */
export function changeAspect(c: Rect, W: number, H: number, aspect: number): Rect {
  const zoom = zoomOf(c, W, H)
  const full = fullCrop(W, H, aspect)
  const w = full.w / zoom,
    h = full.h / zoom
  return clampCrop({ x: c.x + c.w / 2 - w / 2, y: c.y + c.h / 2 - h / 2, w, h })
}

/** 框在画布上的位置：按 crop 的比例尽量大，四周留 margin，居中。 */
export function frameRect(width: number, height: number, aspect: number, margin = 16): Frame {
  const aw = Math.max(1, width - margin * 2),
    ah = Math.max(1, height - margin * 2)
  const w = Math.min(aw, ah * aspect),
    h = w / aspect
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
}

/**
 * 原照片上的一点（像素）画到画布上的哪里：先转、翻（和 place() 一样），再按框放好。
 * 返回画布 setTransform 用的 [a, b, c, d, e, f]：画布 x = a·sx + c·sy + e，y = b·sx + d·sy + f。
 */
export function photoTransform(
  width: number,
  height: number,
  p: Placement,
  frame: Frame,
): [number, number, number, number, number, number] {
  const [W, H] = placedDims(width, height, p.rotate)
  // 转：原图 (sx, sy) → 转好的 (u, v)，按 rotate90 的约定（顺时针）
  const rot: [number, number, number, number, number, number][] = [
    [1, 0, 0, 1, 0, 0],
    [0, 1, -1, 0, height, 0],
    [-1, 0, 0, -1, width, height],
    [0, -1, 1, 0, 0, width],
  ]
  const [b, d, f] = [rot[p.rotate][1], rot[p.rotate][3], rot[p.rotate][5]]
  let [a, c, e] = [rot[p.rotate][0], rot[p.rotate][2], rot[p.rotate][4]]
  // 翻：u → W - u
  if (p.flip) [a, c, e] = [-a, -c, W - e]
  // 放：转好的图上 crop 那块正好落在框里
  const s = frame.w / (p.crop.w * W)
  const ox = frame.x - p.crop.x * W * s,
    oy = frame.y - p.crop.y * H * s
  return [a * s, b * s, c * s, d * s, e * s + ox, f * s + oy]
}
