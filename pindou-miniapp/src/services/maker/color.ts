import { differenceCiede2000 } from 'culori/fn'

// 颜色换算（docs/plan-bead-maker.md 第 3 节）。照片的每个像素都要换算，culori 每次换算都新建对象，太慢，
// 所以 sRGB → OKLab、Lab（D65）这两步自己按公式算、放进类型数组；只有色差 CIEDE2000 用 culori（只在挑出来的几个候选上算）。
// 颜色用 0xRRGGBB 的整数传。

export type Lab = { l: number; a: number; b: number }

const linear = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  linear[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** sRGB → OKLab（Björn Ottosson 的公式），写进 out 的 offset 处（L、a、b 三个数）。 */
export function oklabInto(r: number, g: number, b: number, out: Float32Array | Float64Array, offset = 0) {
  const lr = linear[r],
    lg = linear[g],
    lb = linear[b]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  out[offset] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  out[offset + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  out[offset + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
}

/** OKLab → sRGB（超出色域的截到 0～255）。 */
export function oklabToRgb(L: number, A: number, B: number): number {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3)
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3)
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3)
  const channel = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
    return Math.max(0, Math.min(255, Math.round(c * 255)))
  }
  return (
    (channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) << 16) |
    (channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) << 8) |
    channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  )
}

const epsilon = 216 / 24389
const kappa = 24389 / 27
const f = (t: number) => (t > epsilon ? Math.cbrt(t) : (kappa * t + 16) / 116)

/** sRGB → CIELAB（D65 白点，与 culori 的 lab65 一致）。 */
export function lab(rgb: number): Lab {
  const r = linear[(rgb >> 16) & 255],
    g = linear[(rgb >> 8) & 255],
    b = linear[rgb & 255]
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047)
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b)
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883)
  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) }
}

const ciede = differenceCiede2000()

/** CIEDE2000 色差：1 左右人眼刚能分辨，10 以上一眼能看出是两种颜色。 */
export const deltaE = (x: Lab, y: Lab) => ciede({ mode: 'lab65', ...x }, { mode: 'lab65', ...y })

/** OKLab 欧氏距离的平方（挑颜色、聚类用；比 CIEDE2000 快得多）。 */
export function okDistance2(p: ArrayLike<number>, i: number, q: ArrayLike<number>, j: number) {
  const dl = p[i] - q[j],
    da = p[i + 1] - q[j + 1],
    db = p[i + 2] - q[j + 2]
  return dl * dl + da * da + db * db
}

export const hex = (rgb: number) => '#' + (rgb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()
export const parseHex = (value: string) => parseInt(value.slice(1), 16)

/** 照片的颜色按 15 位（每个通道 5 位）分桶，桶号 → OKLab 的查表在第一次用时建好（32768 项）。 */
let table: Float32Array | undefined
export function oklabTable(): Float32Array {
  if (table) return table
  table = new Float32Array(32768 * 3)
  for (let i = 0; i < 32768; i++) {
    const r = ((i >> 10) & 31) * 8.226,
      g = ((i >> 5) & 31) * 8.226,
      b = (i & 31) * 8.226
    oklabInto(Math.round(r), Math.round(g), Math.round(b), table, i * 3)
  }
  return table
}
export const bucket = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
