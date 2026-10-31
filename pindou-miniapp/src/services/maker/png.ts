// 图纸缩略图编成 PNG（「我的图纸」列表用）：每张一块画布太重，编成很小的调色板 PNG 给 <Image> 显示。
// 不压缩（deflate 的「存储」块），一张 32×32 格、每格 4 像素的缩略图十几 KB。

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number) {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

class Writer {
  private parts: Uint8Array[] = []
  push(bytes: Uint8Array | number[]) {
    this.parts.push(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))
  }
  chunk(type: string, data: Uint8Array) {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
    this.push(out)
  }
  bytes() {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

/** 不压缩的 zlib 流。 */
function zlibStored(raw: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let at = 2
  for (let b = 0; b < blocks; b++) {
    const from = b * 65535
    const len = Math.min(65535, raw.length - from)
    out[at++] = b === blocks - 1 ? 1 : 0
    out[at++] = len & 255
    out[at++] = len >> 8
    out[at++] = ~len & 255
    out[at++] = (~len >> 8) & 255
    out.set(raw.subarray(from, from + len), at)
    at += len
  }
  let a = 1,
    s = 0
  for (const v of raw) {
    a = (a + v) % 65521
    s = (s + a) % 65521
  }
  new DataView(out.buffer).setUint32(at, ((s << 16) | a) >>> 0)
  return out
}

/**
 * 编一张调色板 PNG：index 是每格的颜色序号（width×height），palette 是 0xRRGGBB，每格放大成 scale×scale 像素。
 * 最多 256 种颜色。
 */
export function indexedPng(index: Uint8Array, width: number, height: number, palette: number[], scale = 4): Uint8Array {
  const w = width * scale,
    h = height * scale
  const raw = new Uint8Array((w + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w + 1)
    raw[row] = 0 // 不做行过滤
    const src = Math.floor(y / scale) * width
    for (let x = 0; x < w; x++) raw[row + 1 + x] = index[src + Math.floor(x / scale)]
  }
  const png = new Writer()
  png.push([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const head = new Uint8Array(13)
  const view = new DataView(head.buffer)
  view.setUint32(0, w)
  view.setUint32(4, h)
  head[8] = 8 // 每像素 8 位
  head[9] = 3 // 调色板
  png.chunk('IHDR', head)
  const plte = new Uint8Array(palette.length * 3)
  palette.forEach((c, i) => {
    plte[i * 3] = (c >> 16) & 255
    plte[i * 3 + 1] = (c >> 8) & 255
    plte[i * 3 + 2] = c & 255
  })
  png.chunk('PLTE', plte)
  png.chunk('IDAT', zlibStored(raw))
  png.chunk('IEND', new Uint8Array(0))
  return png.bytes()
}
