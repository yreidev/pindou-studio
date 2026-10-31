// 会员码的二维码：在小程序里自己画，不调微信接口、不引第三方库（只这一处要用，库要大几十 KB）。
//
// 会员码只有 20 位数字（docs/api.yaml MemberCode），这里只实现它用得到的那一种二维码：
// 版本 1（21×21）、数字模式、纠错等级 Q（能扛 25% 污损，手机屏反光、裂屏也扫得出），最多 27 位数字。
// 掩码按标准的四条扣分规则挑最好的一个。画成 1 位灰度的 PNG（data URL）交给 Image 显示，
// 不用 Canvas：Image 在开发者工具、真机上表现一致，也好在单元测试里直接解码核对（tests/member-code.test.ts 用 jsQR 解）。

const size = 21
const dataCodewords = 13
const ecCodewords = 13
/** 纠错等级 Q 在格式信息里是 11。 */
const eccBits = 0b11

type Matrix = boolean[][]

/** 数字模式最多放几位（版本 1-Q）。 */
export const maxQrDigits = 27

// GF(256)，本原多项式 x^8+x^4+x^3+x^2+1（0x11D）。
// 建表放在函数里，不写成模块顶层的 { let … } 块：开发者工具转 ES5 时把块里的 let 改成 var 不改名，
// 压缩后它和打包器的异步助手同名（都叫 e），覆盖掉助手，会员码页的请求一个都发不出去（2026-10-11 查到）。
function galoisTables() {
  const exp = new Array<number>(512)
  const log = new Array<number>(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    exp[i] = x
    log[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255]
  return { exp, log }
}
const { exp, log } = galoisTables()
const multiply = (a: number, b: number) => (a && b ? exp[log[a] + log[b]] : 0)

/** 里德-所罗门纠错码：data 除以 13 次生成多项式的余数。 */
function reedSolomon(data: number[]): number[] {
  let generator = [1]
  for (let i = 0; i < ecCodewords; i++) {
    const next = new Array<number>(generator.length + 1).fill(0)
    generator.forEach((coefficient, j) => {
      next[j] ^= coefficient
      next[j + 1] ^= multiply(coefficient, exp[i])
    })
    generator = next
  }
  const remainder = new Array<number>(ecCodewords).fill(0)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.shift()
    remainder.push(0)
    for (let j = 0; j < ecCodewords; j++) remainder[j] ^= multiply(generator[j + 1], factor)
  }
  return remainder
}

/** 数字模式的数据码字（含结束符与填充）。 */
function encodeDigits(digits: string): number[] {
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0001, 4) // 数字模式
  put(digits.length, 10) // 版本 1–9 的字符数占 10 位
  for (let i = 0; i < digits.length; i += 3) {
    const group = digits.slice(i, i + 3)
    put(Number(group), group.length * 3 + 1) // 3 位 10 比特，2 位 7 比特，1 位 4 比特
  }
  const capacity = dataCodewords * 8
  put(0, Math.min(4, capacity - bits.length)) // 结束符
  while (bits.length % 8) bits.push(0)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  for (let pad = 0; bytes.length < dataCodewords; pad++) bytes.push(pad % 2 ? 0x11 : 0xec)
  return bytes
}

/** 画好定位图形、时序图形和暗模块；reserved 标出这些格和格式信息的位置，数据不能放。 */
function functionPatterns(): { modules: Matrix; reserved: Matrix } {
  const modules: Matrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved: Matrix = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (row: number, col: number, dark: boolean) => {
    modules[row][col] = dark
    reserved[row][col] = true
  }
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    // 7×7 定位图形连同外面一圈白边（分隔符）
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const row = top + r
        const col = left + c
        if (row < 0 || row >= size || col < 0 || col >= size) continue
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        set(row, col, ring !== 2 && ring !== 4)
      }
  }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  set(size - 8, 8, true) // 暗模块
  // 格式信息的位置先占住
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = true
    if (!reserved[i][8]) reserved[i][8] = true
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true
    reserved[size - 1 - i][8] = true
  }
  return { modules, reserved }
}

const masks: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** 15 位格式信息：纠错等级与掩码号，BCH(15,5) 校验后再与 0x5412 异或。 */
function formatBits(mask: number): number {
  const data = (eccBits << 3) | mask
  let remainder = data << 10
  for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10)
  return ((data << 10) | remainder) ^ 0x5412
}

function placeFormat(modules: Matrix, mask: number) {
  const bits = formatBits(mask)
  const bit = (i: number) => ((bits >>> i) & 1) === 1
  // modules[行][列]。左上角一份：第 0–7 位沿第 8 列往下（跳过时序行），第 8–14 位沿第 8 行往左
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i)
  modules[7][8] = bit(6)
  modules[8][8] = bit(7)
  modules[8][7] = bit(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i)
  // 右上角（第 8 行）放第 0–7 位，左下角（第 8 列）放第 8–14 位
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i)
}

/** 按之字形从右下角往上放数据位（跳过时序图形那一列），放的同时套上掩码。 */
function placeData(modules: Matrix, reserved: Matrix, codewords: number[], mask: number) {
  const pattern = masks[mask]
  let index = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue
        const byte = codewords[index >>> 3]
        const dark = byte !== undefined && ((byte >>> (7 - (index & 7))) & 1) === 1
        index++
        modules[row][col] = dark !== pattern(row, col)
      }
    }
    upward = !upward
  }
}

/**
 * 一行（或一列）里像定位图形的 1:1:3:1:1 有几处（一侧有 4 格以上的白）。history 是最近 7 段的长度，
 * 最新的在前；符号外的白边算白，所以第一段白和最后一段白都加上一个边长。
 */
function finderLike(history: number[]): number {
  const n = history[1]
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
  return (
    (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  )
}

/** 一行（或一列）的连续同色扣分和像定位图形的扣分。 */
function linePenalty(line: boolean[]): number {
  let score = 0
  let color = false
  let run = 0
  const history = [0, 0, 0, 0, 0, 0, 0]
  const push = (length: number) => {
    history.pop()
    history.unshift(history[0] === 0 ? length + size : length)
  }
  for (const dark of line) {
    if (dark === color) {
      run++
      if (run === 5) score += 3
      else if (run > 5) score++
    } else {
      push(run)
      if (!color) score += finderLike(history) * 40
      color = dark
      run = 1
    }
  }
  // 收尾：最后一段黑先记下，再补上符号外的白边
  if (color) {
    push(run)
    run = 0
  }
  push(run + size)
  return score + finderLike(history) * 40
}

/** 掩码的扣分（ISO/IEC 18004 的四条规则，算法同 Nayuki 的 QR Code generator），越低越好。 */
function penalty(modules: Matrix): number {
  let score = 0
  for (let i = 0; i < size; i++) {
    score += linePenalty(modules[i])
    score += linePenalty(modules.map((row) => row[i]))
  }
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c]
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3
    }
  const dark = modules.flat().filter(Boolean).length
  const total = size * size
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return score
}

/** 把一串数字编成二维码的模块矩阵（true 为黑）。只收 1–27 位数字。 */
export function qrMatrix(digits: string): Matrix {
  if (!/^[0-9]{1,27}$/.test(digits)) throw new Error('二维码只收 1–27 位数字')
  const data = encodeDigits(digits)
  const codewords = [...data, ...reedSolomon(data)]
  let best: { modules: Matrix; score: number } | null = null
  for (let mask = 0; mask < masks.length; mask++) {
    const { modules, reserved } = functionPatterns()
    placeData(modules, reserved, codewords, mask)
    placeFormat(modules, mask)
    const score = penalty(modules)
    if (!best || score < best.score) best = { modules, score }
  }
  return best!.modules
}

// —— PNG：1 位灰度、不压缩（zlib 的存储块），每个模块 scale×scale 像素，四周留 4 个模块宽的白边 ——

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

class Bytes {
  private parts: number[] = []
  u8(...values: number[]) {
    this.parts.push(...values)
    return this
  }
  u16le(value: number) {
    return this.u8(value & 0xff, (value >>> 8) & 0xff)
  }
  u32(value: number) {
    return this.u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
  }
  bytes(values: Uint8Array) {
    for (const value of values) this.parts.push(value)
    return this
  }
  done() {
    return Uint8Array.from(this.parts)
  }
}

function chunk(out: Bytes, type: string, data: Uint8Array) {
  const body = new Bytes()
    .u8(...[...type].map((ch) => ch.charCodeAt(0)))
    .bytes(data)
    .done()
  out.u32(data.length).bytes(body).u32(crc32(body))
}

/** 模块矩阵画成 PNG 的字节。 */
export function qrPng(modules: Matrix, scale = 8, quiet = 4): Uint8Array {
  const width = (modules.length + quiet * 2) * scale
  const rowBytes = Math.ceil(width / 8)
  const raw = new Uint8Array((rowBytes + 1) * width)
  for (let y = 0; y < width; y++) {
    const offset = y * (rowBytes + 1) // 每行第一个字节是过滤方式 0
    const row = Math.floor(y / scale) - quiet
    for (let x = 0; x < rowBytes * 8; x++) {
      const col = Math.floor(x / scale) - quiet
      const dark = x < width && modules[row]?.[col] === true
      // 1 位灰度里 1 是白
      if (!dark) raw[offset + 1 + (x >>> 3)] |= 0x80 >>> (x & 7)
    }
  }
  // zlib：不压缩的存储块，每块最多 65535 字节
  const zlib = new Bytes().u8(0x78, 0x01)
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const block = raw.subarray(at, at + 65535)
    const last = at + 65535 >= raw.length
    zlib
      .u8(last ? 1 : 0)
      .u16le(block.length)
      .u16le(~block.length & 0xffff)
      .bytes(block)
    if (last) break
  }
  zlib.u32(adler32(raw))
  const header = new Bytes().u32(width).u32(width).u8(1, 0, 0, 0, 0).done()
  const png = new Bytes().u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  chunk(png, 'IHDR', header)
  chunk(png, 'IDAT', zlib.done())
  chunk(png, 'IEND', new Uint8Array(0))
  return png.done()
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64（小程序逻辑层没有 btoa）。 */
export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]]
    const n = (a << 16) | (b << 8) | c
    out += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63]
    out += i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '='
    out += i + 2 < bytes.length ? alphabet[n & 63] : '='
  }
  return out
}

/** 一串数字的二维码图片（PNG data URL），给 Image 的 src。 */
export function qrDataUrl(digits: string): string {
  return `data:image/png;base64,${base64(qrPng(qrMatrix(digits)))}`
}
