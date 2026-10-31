import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { test } from 'vitest'
import { applyMask, CUT_SIDE, maskFrom, maskShare, modelInput, unpackModel } from '../src/services/maker/cutout'
import { pixels } from '../src/services/maker/image'
import { root, src } from './helpers/load'

// 抠图（试用，2026-10-22）的纯函数：模型文件解包、模型输入、蒙版后处理、把蒙版套到照片上。
// 推理本身要微信的端侧推理，只能真机验；这里钉住前后两头，和 2026-10-21 转图科研的 Python 做法逐点对过（48 张照片蒙版完全一样）。

const packedModel = path.join(src, 'pages/maker/model/u2netp.br')

function container(skeleton: Uint8Array, tensors: { at: number; q: number[]; scales: number[] }[]) {
  const meta: { at: number; n: number; ch: number; q: number; s: number }[] = []
  let q = 0,
    s = 0
  for (const t of tensors) {
    meta.push({ at: t.at, n: t.q.length, ch: t.scales.length, q, s })
    q += t.q.length
    s += t.scales.length * 4
  }
  const head = Buffer.from(JSON.stringify({ skeleton: skeleton.length, tensors: meta }))
  const scales = Buffer.alloc(s)
  let k = 0
  for (const t of tensors) for (const v of t.scales) scales.writeFloatLE(v, k++ * 4)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(head.length)
  const all = Buffer.concat([
    Buffer.from('U2Q1'),
    length,
    head,
    Buffer.from(skeleton),
    Buffer.from(Int8Array.from(tensors.flatMap((t) => t.q)).buffer),
    scales,
  ])
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength)
}

test('unpacking puts weight × channel scale back at the recorded offsets', () => {
  const skeleton = new Uint8Array(40).fill(7)
  skeleton.fill(0, 3, 3 + 16) // 4 个 float，故意不按 4 字节对齐
  skeleton.fill(0, 21, 21 + 8)
  const out = new DataView(
    unpackModel(
      container(skeleton, [
        { at: 3, q: [1, -2, 3, 127], scales: [0.5, 0.25] },
        { at: 21, q: [-127, 5], scales: [2] },
      ]),
    ),
  )
  assert.equal(out.byteLength, 40)
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => out.getFloat32(3 + i * 4, true)),
    [0.5, -1, 0.75, 31.75],
  )
  assert.deepEqual([out.getFloat32(21, true), out.getFloat32(25, true)], [-254, 10])
  assert.equal(out.getUint8(0), 7)
  assert.equal(out.getUint8(39), 7)
  assert.throws(() => unpackModel(new ArrayBuffer(16)), /不是抠图模型/)
})

test('the shipped model unpacks to exactly the ONNX file it was built from', () => {
  const raw = brotliDecompressSync(fs.readFileSync(packedModel))
  const onnx = unpackModel(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
  assert.equal(
    createHash('sha256').update(new Uint8Array(onnx)).digest('hex'),
    'efc67c14d62c21e78cb14f483373bdcc8e7bc920ea70a422b09cca3ed1a03f69',
  )
})

test('model input is 320×320 NCHW, normalised against the brightest value', () => {
  const img = pixels(50, 30)
  for (let i = 0; i < img.data.length; i += 4) img.data.set([100, 100, 100, 255], i)
  img.data.set([200, 50, 0, 255], 0)
  const input = modelInput(img)
  assert.equal(input.length, 3 * CUT_SIDE * CUT_SIDE)
  const n = CUT_SIDE * CUT_SIDE
  // 右下角是纯灰：100 / 最亮的 200
  const last = n - 1
  assert.ok(Math.abs(input[last] - (0.5 - 0.485) / 0.229) < 1e-3)
  assert.ok(Math.abs(input[2 * n + last] - (0.5 - 0.406) / 0.225) < 1e-3)
  // 透明的地方垫白
  const clear = pixels(4, 4)
  const white = modelInput(clear)
  assert.ok(Math.abs(white[0] - (1 - 0.485) / 0.229) < 1e-3)
})

test('the mask keeps the main blob, drops specks and fills holes', () => {
  const side = 64
  const pred = new Float32Array(side * side).fill(0.05)
  const set = (x: number, y: number, v: number) => (pred[y * side + x] = v)
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const r = Math.hypot(x - 30, y - 32)
      if (r < 20) set(x, y, 0.9)
      if (r < 4) set(x, y, 0.05) // 主体中间的洞
    }
  set(60, 2, 0.95) // 一个点的杂块
  set(61, 2, 0.95)
  const mask = maskFrom(pred, side)
  assert.equal(mask[32 * side + 30], 1, '洞要填上')
  assert.equal(mask[2 * side + 60], 0, '小杂块要去掉')
  assert.equal(mask[32 * side + 30 + 25], 0, '背景')
  assert.equal(mask[32 * side + 30 + 15], 1, '主体')
  const disk = Math.PI * 20 * 20
  assert.ok(Math.abs(maskShare(mask) * side * side - disk) / disk < 0.05)
  // 模型没把握、整片一样：不报错
  assert.equal(maskFrom(new Float32Array(side * side).fill(0.3), side).length, side * side)
})

test('applying the mask makes the background transparent and leaves the subject alone', () => {
  const img = pixels(640, 480)
  for (let i = 0; i < img.data.length; i += 4) img.data.set([10, 20, 30, 255], i)
  const side = 32
  const mask = new Uint8Array(side * side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side / 2; x++) mask[y * side + x] = 1
  const out = applyMask(img, mask, side)
  const alpha = (x: number, y: number) => out.data[(y * 640 + x) * 4 + 3]
  assert.equal(alpha(10, 240), 255)
  assert.equal(alpha(630, 240), 0)
  assert.equal(alpha(300, 10), 255)
  assert.equal(alpha(340, 10), 0)
  assert.deepEqual([...out.data.subarray(0, 3)], [10, 20, 30])
  assert.equal(img.data[(240 * 640 + 630) * 4 + 3], 255, '原图不动')
})

test('the packed model is copied into the maker subpackage', (context) => {
  const dist = path.resolve(root, 'dist')
  if (!fs.existsSync(path.join(dist, 'app.json'))) {
    context.skip('dist 还没构建，跳过（npm run build:weapp 之后再跑）')
    return
  }
  const shipped = path.join(dist, 'pages/maker/model/u2netp.br')
  assert.ok(fs.existsSync(shipped), '抠图模型没拷进 dist/pages/maker/model/，真机上会读不出模型文件')
  assert.equal(fs.statSync(shipped).size, fs.statSync(packedModel).size)
})
