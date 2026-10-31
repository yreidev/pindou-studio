// 照片的像素处理（docs/plan-bead-maker.md 第 3 节 0）：旋转、翻转、裁剪、缩放、调色、保边平滑。
// 都是纯函数，输入输出是 RGBA 的像素数组（和画布的 ImageData 一样排），不碰画布，能单元测试。

export type Pixels = { width: number; height: number; data: Uint8ClampedArray }

export const pixels = (width: number, height: number): Pixels => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
})

/** 顺时针转 90°。 */
export function rotate90(src: Pixels): Pixels {
  const out = pixels(src.height, src.width)
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height)
  const d = new Uint32Array(out.data.buffer)
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) d[y * out.width + x] = s[(src.height - 1 - x) * src.width + y]
  return out
}

export function flipH(src: Pixels): Pixels {
  const out = pixels(src.width, src.height)
  const s = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height)
  const d = new Uint32Array(out.data.buffer)
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) d[y * src.width + x] = s[y * src.width + src.width - 1 - x]
  return out
}

export type Rect = { x: number; y: number; w: number; h: number }

export function crop(src: Pixels, r: Rect): Pixels {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.round(r.x)))
  const y0 = Math.max(0, Math.min(src.height - 1, Math.round(r.y)))
  const w = Math.max(1, Math.min(src.width - x0, Math.round(r.w)))
  const h = Math.max(1, Math.min(src.height - y0, Math.round(r.h)))
  const out = pixels(w, h)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * src.width + x0) * 4
    out.data.set(src.data.subarray(from, from + w * 4), y * w * 4)
  }
  return out
}

/** 照片怎么摆：先顺时针转 rotate 个 90°，再左右翻，再按 crop（占转好的图的比例，0～1）裁。 */
export type Placement = { rotate: 0 | 1 | 2 | 3; flip: boolean; crop: Rect }
export const fullPlacement = (): Placement => ({ rotate: 0, flip: false, crop: { x: 0, y: 0, w: 1, h: 1 } })

export function place(src: Pixels, p: Placement): Pixels {
  let img = src
  for (let i = 0; i < p.rotate; i++) img = rotate90(img)
  if (p.flip) img = flipH(img)
  const c = p.crop
  if (c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1) return img === src ? { ...src, data: src.data.slice() } : img
  return crop(img, { x: c.x * img.width, y: c.y * img.height, w: c.w * img.width, h: c.h * img.height })
}

/** 摆好之后的大小（不用真的算像素）。 */
export function placedSize(width: number, height: number, p: Placement) {
  const [w, h] = p.rotate % 2 ? [height, width] : [width, height]
  return { width: Math.max(1, Math.round(p.crop.w * w)), height: Math.max(1, Math.round(p.crop.h * h)) }
}

/**
 * 缩放：缩小按面积平均（每个新像素是它盖住的原像素的加权平均，透明度预乘，边上不发黑），放大取最近的像素。
 * 一步缩到很小会丢细节、出锯齿，所以做图纸时先缩到「格数 × 4」，再按 4×4 取色。
 */
export function resize(src: Pixels, width: number, height: number): Pixels {
  if (width === src.width && height === src.height) return { ...src, data: src.data.slice() }
  const out = pixels(width, height)
  if (width >= src.width && height >= src.height) {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height))
      for (let x = 0; x < width; x++) {
        const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width))
        const s = (sy * src.width + sx) * 4,
          d = (y * width + x) * 4
        out.data[d] = src.data[s]
        out.data[d + 1] = src.data[s + 1]
        out.data[d + 2] = src.data[s + 2]
        out.data[d + 3] = src.data[s + 3]
      }
    }
    return out
  }
  // 先横向、再纵向，各自按覆盖的比例加权
  const mid = new Float32Array(width * src.height * 4)
  const sx = src.width / width
  for (let x = 0; x < width; x++) {
    const from = x * sx,
      to = (x + 1) * sx
    for (let y = 0; y < src.height; y++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let i = Math.floor(from); i < Math.min(src.width, Math.ceil(to)); i++) {
        const w = Math.min(to, i + 1) - Math.max(from, i)
        const s = (y * src.width + i) * 4
        const alpha = src.data[s + 3] * w
        r += src.data[s] * alpha
        g += src.data[s + 1] * alpha
        b += src.data[s + 2] * alpha
        a += alpha
      }
      const d = (y * width + x) * 4
      mid[d] = r
      mid[d + 1] = g
      mid[d + 2] = b
      mid[d + 3] = a / sx
    }
  }
  const sy = src.height / height
  for (let y = 0; y < height; y++) {
    const from = y * sy,
      to = (y + 1) * sy
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0
      for (let j = Math.floor(from); j < Math.min(src.height, Math.ceil(to)); j++) {
        const w = Math.min(to, j + 1) - Math.max(from, j)
        const s = (j * width + x) * 4
        r += mid[s] * w
        g += mid[s + 1] * w
        b += mid[s + 2] * w
        a += mid[s + 3] * w
      }
      const d = (y * width + x) * 4
      const weight = a * sx // 预乘时用的 alpha 总和
      if (weight > 0) {
        out.data[d] = r / weight
        out.data[d + 1] = g / weight
        out.data[d + 2] = b / weight
      }
      out.data[d + 3] = a / sy
    }
  }
  return out
}

/** 调色：亮度、对比度、鲜艳度 -100～100，清晰度 0～100（反锐化掩模）。0 都是不变。 */
export type Tone = { brightness: number; contrast: number; saturation: number; sharpness: number }
export const neutralTone = (): Tone => ({ brightness: 0, contrast: 0, saturation: 0, sharpness: 0 })

export function adjust(src: Pixels, t: Tone): Pixels {
  const out = { ...src, data: src.data.slice() }
  const d = out.data
  if (t.sharpness > 0) {
    const blur = boxBlur(src)
    const amount = t.sharpness / 50
    for (let i = 0; i < d.length; i += 4)
      for (let c = 0; c < 3; c++) d[i + c] = src.data[i + c] + amount * (src.data[i + c] - blur[i + c])
  }
  if (t.brightness || t.contrast || t.saturation) {
    const C = t.contrast * 2.55
    const k = (259 * (C + 255)) / (255 * (259 - C))
    const shift = t.brightness * 1.28
    const sat = 1 + t.saturation / 100
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i],
        g = d[i + 1],
        b = d[i + 2]
      if (sat !== 1) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        r = y + (r - y) * sat
        g = y + (g - y) * sat
        b = y + (b - y) * sat
      }
      d[i] = k * (r + shift - 128) + 128
      d[i + 1] = k * (g + shift - 128) + 128
      d[i + 2] = k * (b + shift - 128) + 128
    }
  }
  return out
}

/** 3×3 均值模糊（先横后竖），边上只算在图里的像素。 */
function boxBlur(src: Pixels): Float32Array {
  const { width: w, height: h, data } = src
  const mid = new Float32Array(data.length)
  const out = new Float32Array(data.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const l = x > 0 ? i - 4 : i,
        r = x < w - 1 ? i + 4 : i
      const n = 1 + (x > 0 ? 1 : 0) + (x < w - 1 ? 1 : 0)
      for (let c = 0; c < 3; c++)
        mid[i + c] = (data[i + c] + (l !== i ? data[l + c] : 0) + (r !== i ? data[r + c] : 0)) / n
    }
  const row = w * 4
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const n = 1 + (y > 0 ? 1 : 0) + (y < h - 1 ? 1 : 0)
      for (let c = 0; c < 3; c++)
        out[i + c] = (mid[i + c] + (y > 0 ? mid[i - row + c] : 0) + (y < h - 1 ? mid[i + row + c] : 0)) / n
    }
  return out
}

/**
 * 保边平滑（Kuwahara）：每个像素看左上、右上、左下、右下四块，取颜色最平的那块的平均。
 * 大片颜色变匀、边缘不糊，卡通风格用，并色更干净。透明的像素不动。
 */
export function smooth(src: Pixels, radius = 2): Pixels {
  const { width: w, height: h, data } = src
  const out = { ...src, data: data.slice() }
  // 亮度的积分图，算每块的方差
  const sum = new Float64Array((w + 1) * (h + 1))
  const sq = new Float64Array((w + 1) * (h + 1))
  const rs = new Float64Array((w + 1) * (h + 1))
  const gs = new Float64Array((w + 1) * (h + 1))
  const bs = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      const at = (y + 1) * (w + 1) + x + 1,
        up = y * (w + 1) + x + 1,
        left = (y + 1) * (w + 1) + x,
        diag = y * (w + 1) + x
      sum[at] = l + sum[up] + sum[left] - sum[diag]
      sq[at] = l * l + sq[up] + sq[left] - sq[diag]
      rs[at] = data[i] + rs[up] + rs[left] - rs[diag]
      gs[at] = data[i + 1] + gs[up] + gs[left] - gs[diag]
      bs[at] = data[i + 2] + bs[up] + bs[left] - bs[diag]
    }
  const W = w + 1
  const box = (t: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    t[(y1 + 1) * W + x1 + 1] - t[y0 * W + x1 + 1] - t[(y1 + 1) * W + x0] + t[y0 * W + x0]
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (data[i + 3] < 128) continue
      let best = Infinity,
        bx0 = 0,
        by0 = 0,
        bx1 = 0,
        by1 = 0
      for (let q = 0; q < 4; q++) {
        const x0 = q & 1 ? x : Math.max(0, x - radius),
          x1 = q & 1 ? Math.min(w - 1, x + radius) : x
        const y0 = q & 2 ? y : Math.max(0, y - radius),
          y1 = q & 2 ? Math.min(h - 1, y + radius) : y
        const n = (x1 - x0 + 1) * (y1 - y0 + 1)
        const mean = box(sum, x0, y0, x1, y1) / n
        const variance = box(sq, x0, y0, x1, y1) / n - mean * mean
        if (variance < best) {
          best = variance
          bx0 = x0
          by0 = y0
          bx1 = x1
          by1 = y1
        }
      }
      const n = (bx1 - bx0 + 1) * (by1 - by0 + 1)
      out.data[i] = box(rs, bx0, by0, bx1, by1) / n
      out.data[i + 1] = box(gs, bx0, by0, bx1, by1) / n
      out.data[i + 2] = box(bs, bx0, by0, bx1, by1) / n
    }
  return out
}
