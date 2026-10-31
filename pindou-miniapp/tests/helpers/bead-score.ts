import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { oklabInto } from '../../src/services/maker/color'
import { EMPTY, type Grid } from '../../src/services/maker/grid'
import { resize, type Pixels } from '../../src/services/maker/image'
import type { Palette } from '../../src/services/maker/palettes'

// 转图打分（docs/plan-bead-maker.md 第 6 节）：同一张照片转出来的图纸好不好拼、像不像，量成三个数。
// 转图基准（maker-benchmark.test.ts）和与别家的对比都用这里。

/** 读 8 位、不隔行的 RGB / RGBA PNG（测试照片都按这个存）。 */
export function readPng(path: string): Pixels {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8,
    width = 0,
    height = 0,
    channels = 0
  const idat: Buffer[] = []
  while (at < bytes.length) {
    const length = view.getUint32(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 2 && body[9] !== 6))
        throw new Error(`${path}：只认 8 位、不隔行的 RGB / RGBA PNG`)
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const prev = new Uint8Array(stride)
  const row = new Uint8Array(stride)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      row[i] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4,
        s = x * channels
      data[o] = row[s]
      data[o + 1] = row[s + 1]
      data[o + 2] = row[s + 2]
      data[o + 3] = channels === 4 ? row[s + 3] : 255
    }
    prev.set(row)
  }
  return { width, height, data }
}

export type Score = {
  /** 每个像素和它所在格子的豆子颜色差多少（OKLab 距离 × 100），越小越像；透明处放了豆子、不透明处空着都算 50 */
  colorError: number
  /** 零星单颗：四周没有同色豆子的豆子，每一千颗里有几颗，越少越好拼 */
  strays: number
  /** 细线保留：照片里有细的深色线（描边、眼睛、字的笔画）的格子，转出来还比四周深的占多少，越大越好；照片里没有细线时为空 */
  lineKept: number | null
  /** 用了几种颜色 */
  colors: number
}

const SCALE = 6
const median = (values: number[]) => {
  const v = values.slice().sort((x, y) => x - y)
  return v[v.length >> 1]
}

/** 给一张图纸打分。src 是转图用的照片（摆好、抠好的，调色之前），g 是转出来的图纸。 */
export function score(src: Pixels, g: Grid, palette: Palette): Score {
  const W = g.width,
    H = g.height
  // 参照图：照片按面积平均缩到每格 6×6 像素
  const ref = resize(src, W * SCALE, H * SCALE)
  const lab = new Float64Array(3)
  const beadLab = g.colors.map((code) => {
    const c = palette.colors[palette.index.get(code)!]
    const out = new Float64Array(3)
    oklabInto((c.rgb >> 16) & 255, (c.rgb >> 8) & 255, c.rgb & 255, out)
    return out
  })
  let error = 0,
    counted = 0
  const cellL = new Float64Array(W * H)
  const cellN = new Uint16Array(W * H)
  const pixelL = new Float32Array(ref.width * ref.height).fill(NaN)
  for (let y = 0; y < ref.height; y++)
    for (let x = 0; x < ref.width; x++) {
      const i = (y * ref.width + x) * 4
      const cell = Math.floor(y / SCALE) * W + Math.floor(x / SCALE)
      // 透明的地方放了豆子、不透明的地方空着，都算差得很远（50）
      if (ref.data[i + 3] < 128) {
        if (g.cells[cell] !== EMPTY) {
          error += 50
          counted++
        }
        continue
      }
      oklabInto(ref.data[i], ref.data[i + 1], ref.data[i + 2], lab)
      pixelL[y * ref.width + x] = lab[0]
      cellL[cell] += lab[0]
      cellN[cell]++
      const bead = g.cells[cell]
      counted++
      if (bead === EMPTY) {
        error += 50
        continue
      }
      const b = beadLab[bead]
      error += Math.hypot(lab[0] - b[0], lab[1] - b[1], lab[2] - b[2]) * 100
    }
  for (let c = 0; c < W * H; c++) cellL[c] = cellN[c] ? cellL[c] / cellN[c] : NaN

  // 零星单颗
  let beads = 0,
    strays = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = g.cells[y * W + x]
      if (v === EMPTY) continue
      beads++
      let neighbours = 0,
        same = false
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const xx = x + dx,
          yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const n = g.cells[yy * W + xx]
        if (n === EMPTY) continue
        neighbours++
        if (n === v) same = true
      }
      if (neighbours && !same) strays++
    }

  // 细线：格子里一成以上的像素比四周 8 格的中位亮度暗 0.18 以上，而且上下左右没有整格都这么暗的（那是一片暗色的边，不是线）
  const beadL = (c: number) => (g.cells[c] === EMPTY ? NaN : beadLab[g.cells[c]][0])
  const around = (x: number, y: number, at: (c: number) => number) => {
    const v: number[] = []
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const l = at(yy * W + xx)
        if (!Number.isNaN(l)) v.push(l)
      }
    return v.length ? median(v) : NaN
  }
  let lineCells = 0,
    kept = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = y * W + x
      const bg = around(x, y, (i) => cellL[i])
      if (Number.isNaN(bg)) continue
      let dark = 0,
        darkSum = 0,
        n = 0
      for (let py = y * SCALE; py < (y + 1) * SCALE; py++)
        for (let px = x * SCALE; px < (x + 1) * SCALE; px++) {
          const l = pixelL[py * ref.width + px]
          if (Number.isNaN(l)) continue
          n++
          if (l < bg - 0.18) {
            dark++
            darkSum += l
          }
        }
      if (!n || dark < n * 0.1) continue
      const level = darkSum / dark
      const solid = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const xx = x + dx,
          yy = y + dy
        return xx >= 0 && yy >= 0 && xx < W && yy < H && cellL[yy * W + xx] < level + 0.1
      })
      if (solid) continue
      lineCells++
      const out = beadL(c)
      const outBg = around(x, y, beadL)
      if (!Number.isNaN(out) && out <= outBg - 0.08) kept++
    }

  return {
    colorError: counted ? error / counted : 0,
    strays: beads ? (strays / beads) * 1000 : 0,
    lineKept: lineCells >= 5 ? kept / lineCells : null,
    colors: g.colors.length,
  }
}
