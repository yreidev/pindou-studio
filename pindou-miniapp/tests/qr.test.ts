import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import jsQR from 'jsqr'
import { test } from 'vitest'
import { base64, maxQrDigits, qrDataUrl, qrMatrix, qrPng } from '../src/services/qr'

// 会员码的二维码是小程序自己画的（src/services/qr.ts）。这里不核对「画得像不像」，而是把画出来的 PNG
// 当成一张普通图片，用另一套独立实现（jsQR）去扫：扫得出、内容一字不差，才算对。

/** 解开 qrPng 画的 PNG（1 位灰度），返回宽高和 RGBA 像素，交给 jsQR。顺带核对各块的 CRC。 */
function decodePng(png: Uint8Array) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let at = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (at < png.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    const data = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      assert.deepEqual([...data.subarray(8)], [1, 0, 0, 0, 0], '1 位灰度、不隔行')
    }
    if (type === 'IDAT') idat.push(data)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rowBytes = Math.ceil(width / 8)
  assert.equal(raw.length, (rowBytes + 1) * height)
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (rowBytes + 1)], 0, '每行的过滤方式是 0')
    for (let x = 0; x < width; x++) {
      const white = (raw[y * (rowBytes + 1) + 1 + (x >>> 3)] >>> (7 - (x & 7))) & 1
      rgba.fill(white ? 255 : 0, (y * width + x) * 4, (y * width + x) * 4 + 3)
      rgba[(y * width + x) * 4 + 3] = 255
    }
  }
  return { width, height, rgba }
}

const scan = (digits: string) => {
  const { width, height, rgba } = decodePng(qrPng(qrMatrix(digits)))
  return jsQR(rgba, width, height)?.data
}

test('画出来的会员码能被独立的二维码解码器扫出、内容一字不差', () => {
  for (const code of [
    '91234567890123456789',
    '90000000000000000000',
    '99999999999999999999',
    '90000000000000000001',
    '7',
    '12',
    '0'.repeat(maxQrDigits),
  ])
    assert.equal(scan(code), code, code)
  // 随机的会员码也都能扫出（各种掩码都会选到）
  for (let i = 0; i < 40; i++) {
    const code = '9' + Array.from({ length: 19 }, () => Math.floor(Math.random() * 10)).join('')
    assert.equal(scan(code), code, code)
  }
})

test('版本 1：21×21，四周留 4 个模块的白边，每个模块 8 像素', () => {
  const modules = qrMatrix('91234567890123456789')
  assert.equal(modules.length, 21)
  assert.ok(modules.every((row) => row.length === 21))
  // 三个定位图形的左上角都是黑的，中心 3×3 也是黑的
  for (const [r, c] of [
    [0, 0],
    [0, 14],
    [14, 0],
  ]) {
    assert.equal(modules[r][c], true)
    assert.equal(modules[r + 3][c + 3], true)
    assert.equal(modules[r + 1][c + 1], false)
  }
  assert.equal(decodePng(qrPng(modules)).width, (21 + 8) * 8)
})

test('只收 1–27 位数字：会员码之外的内容不画', () => {
  for (const bad of ['', '9123456789012345678a', '0'.repeat(maxQrDigits + 1), 'examplebrand-member:9123', '９１２'])
    assert.throws(() => qrMatrix(bad), /只收 1–27 位数字/, bad)
})

test('Base64 与 Node 的结果一致；data URL 是 PNG', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 64, 255]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff)
    assert.equal(base64(bytes), Buffer.from(bytes).toString('base64'))
  }
  const url = qrDataUrl('91234567890123456789')
  assert.match(url, /^data:image\/png;base64,/)
  // 这张图不大：每分钟换一次码，经 setData 传给页面
  assert.ok(url.length < 12_000, `data URL ${url.length} 字符`)
})
