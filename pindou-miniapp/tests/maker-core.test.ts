import assert from 'node:assert/strict'
import { converter, modeLab65, modeOklab, modeRgb, useMode } from 'culori/fn'
import { test } from 'vitest'
import { deltaE, hex, lab, oklabInto, oklabToRgb } from '../src/services/maker/color'
import { cleanup, strayLabel, strayLimit, strayMinSize } from '../src/services/maker/cleanup'
import { make, rowsFor, sortByCount } from '../src/services/maker/generate'
import {
  beadCounts,
  blankDone,
  colorCounts,
  compact,
  decodeCells,
  decodeDone,
  EMPTY,
  encodeCells,
  encodeDone,
  fromBase64,
  newId,
  setDone,
  toBase64,
  type Grid,
} from '../src/services/maker/grid'
import { crop, flipH, pixels, place, placedSize, resize, rotate90, type Pixels } from '../src/services/maker/image'
import {
  aspectOf,
  changeAspect,
  clampCrop,
  dragCrop,
  frameRect,
  fullCrop,
  MAX_ZOOM,
  MIN_CROP_PIXELS,
  maxZoom,
  panCrop,
  photoTransform,
  pinchCrop,
  zoomCrop,
  zoomOf,
} from '../src/services/maker/crop'
import { palette, paletteGroups, paletteList, greys } from '../src/services/maker/palettes'
import { choose, sample } from '../src/services/maker/quantize'
import { keepDots } from '../src/services/maker/dots'
import { modeSample, nearestGrid } from '../src/services/maker/nearest'

// 「做图纸」的算法（docs/plan-bead-maker.md 第 3 节）：颜色换算、色卡、格子编码、照片处理和裁剪、取色挑色、去零星。

useMode(modeRgb)
useMode(modeLab65)
useMode(modeOklab)
const toLab = converter('lab65')
const toOk = converter('oklab')

test('颜色换算和 culori 一致；CIEDE2000 对得上 Sharma 的测试数据', () => {
  for (const rgb of [0x000000, 0xffffff, 0xfda951, 0x4b2b1c, 0x92ad60, 0x8fb8e8, 0x123456]) {
    const ours = lab(rgb)
    const theirs = toLab(hex(rgb))!
    assert.ok(
      Math.abs(ours.l - theirs.l) < 0.05 && Math.abs(ours.a - theirs.a) < 0.1 && Math.abs(ours.b - theirs.b) < 0.1,
      hex(rgb),
    )
    const ok = new Float64Array(3)
    oklabInto((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, ok)
    const ref = toOk(hex(rgb))!
    assert.ok(
      Math.abs(ok[0] - ref.l) < 1e-3 && Math.abs(ok[1] - ref.a) < 1e-3 && Math.abs(ok[2] - ref.b) < 1e-3,
      hex(rgb),
    )
    assert.ok(Math.abs(((oklabToRgb(ok[0], ok[1], ok[2]) >> 8) & 255) - ((rgb >> 8) & 255)) <= 1, '往返')
  }
  const d = deltaE({ l: 50, a: 2.6772, b: -79.7751 }, { l: 50, a: 0, b: -82.7485 })
  assert.ok(Math.abs(d - 2.0425) < 1e-3, String(d))
})

test('色卡：国内 6 套、国外 11 套，按牌子分组；每套都有灰色系', () => {
  assert.equal(paletteList.length, 17)
  assert.equal(palette('mard-221')!.colors.length, 221)
  assert.equal(palette('perler-103')!.index.get('80-15179'), 0)
  assert.equal(palette('nope'), undefined)
  const [cn, intl] = paletteGroups()
  assert.deepEqual(
    cn.brands.map((b) => b.brand),
    ['MARD', '漫漫', '盼盼', '咪小窝', 'COCO'],
  )
  assert.deepEqual(
    intl.brands.map((b) => b.brand),
    ['Perler', 'Hama', 'Artkal', 'Nabbi', 'Yant'],
  )
  assert.equal(intl.brands.find((b) => b.brand === 'Artkal')!.palettes.length, 5)
  for (const p of paletteList) assert.ok(greys(palette(p.id)!).length >= 2, p.id)
})

test('格子编码：序号用 0-9a-zA-Z_-，「.」是空；拼完的位图低位在前，空格子的位清掉', () => {
  const cells = new Uint8Array([0, 9, 10, 35, 36, 61, 62, 63, EMPTY])
  const text = encodeCells(cells)
  assert.equal(text, '09azAZ_-.')
  assert.deepEqual(decodeCells(text, 64), cells)
  assert.equal(decodeCells('0#', 64), undefined)
  assert.equal(decodeCells('01', 1), undefined, '序号超出颜色数')
  for (const n of [0, 1, 2, 3, 4, 5, 31, 100]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) & 255)
    assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes)
  }
  const g: Grid = {
    width: 3,
    height: 3,
    palette: 'mard-221',
    colors: ['A1', 'H7'],
    cells: new Uint8Array([0, 1, EMPTY, 1, 1, 1, 0, EMPTY, 0]),
  }
  const done = blankDone(g)
  setDone(done, 0, true)
  setDone(done, 2, true) // 空格子
  setDone(done, 8, true)
  assert.equal(done[0], 0b0000_0101)
  const encoded = encodeDone(g, done)
  assert.deepEqual([...Buffer.from(encoded, 'base64')], [0b0000_0001, 0b0000_0001])
  assert.deepEqual(decodeDone(g, encoded), new Uint8Array([1, 1]))
  assert.equal(encodeDone(g, blankDone(g)), '')
  assert.deepEqual(beadCounts(g, decodeDone(g, encoded)), { beads: 7, done: 2 })
  assert.deepEqual(
    colorCounts(g).map((c) => [c.code, c.count]),
    [
      ['H7', 4],
      ['A1', 3],
    ],
  )
  const loose = compact({
    ...g,
    colors: ['Z1', 'A1', 'H7'],
    cells: new Uint8Array([2, 1, EMPTY, 2, 2, 2, 1, EMPTY, 1]),
  })
  assert.deepEqual(loose.colors, ['H7', 'A1'])
  assert.deepEqual(sortByCount({ ...g, colors: ['A1', 'H7'] }).colors, ['H7', 'A1'])
  assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

function image(
  width: number,
  height: number,
  at: (x: number, y: number) => number,
  alpha = (_x: number, _y: number) => 255,
): Pixels {
  const img = pixels(width, height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4,
        c = at(x, y)
      img.data[i] = (c >> 16) & 255
      img.data[i + 1] = (c >> 8) & 255
      img.data[i + 2] = c & 255
      img.data[i + 3] = alpha(x, y)
    }
  return img
}
const at = (img: Pixels, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]
}

test('照片摆法：转、翻、裁；裁剪页画照片用的变换和真正裁出来的对得上', () => {
  const src = image(4, 3, (x, y) => y * 4 + x)
  const r = rotate90(src)
  assert.equal(r.width, 3)
  assert.equal(at(r, 0, 0), 8, '左上是原图的左下')
  assert.equal(at(r, 2, 0), 0)
  assert.equal(at(flipH(src), 0, 0), 3)
  assert.equal(at(crop(src, { x: 1, y: 1, w: 2, h: 2 }), 1, 1), 10)
  for (const rotate of [0, 1, 2, 3] as const)
    for (const flip of [false, true]) {
      // 裁剪的边落在整像素上（8×6、转了是 6×8 都是），免得和 place() 的取整差半格
      const p = { rotate, flip, crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }
      const placed = place(
        image(8, 6, (x, y) => y * 8 + x),
        p,
      )
      assert.deepEqual(placedSize(8, 6, p), { width: placed.width, height: placed.height })
      // 框正好一像素一像素地放：原图每个像素的中心落在裁好的图上同一个像素里
      const frame = { x: 10, y: 20, w: placed.width, h: placed.height }
      const [a, b, c, d, e, f] = photoTransform(8, 6, p, frame)
      for (let sy = 0; sy < 6; sy++)
        for (let sx = 0; sx < 8; sx++) {
          const x = Math.floor(a * (sx + 0.5) + c * (sy + 0.5) + e - frame.x),
            y = Math.floor(b * (sx + 0.5) + d * (sy + 0.5) + f - frame.y)
          if (x < 0 || y < 0 || x >= placed.width || y >= placed.height) continue
          assert.equal(at(placed, x, y), sy * 8 + sx, `${rotate} ${flip} ${sx},${sy}`)
        }
    }
})

test('裁剪框不动、挪照片：一指挪、两指缩放、滑杆缩放、换比例，框始终在图里、比例不变', () => {
  // 转好之后 400×300 的照片
  const W = 400,
    H = 300
  const square = fullCrop(W, H, 1)
  assert.deepEqual(square, { x: 0.125, y: 0, w: 0.75, h: 1 }, '1:1 的最大框在正中间，盖满高')
  assert.equal(zoomOf(square, W, H), 1)
  assert.equal(zoomOf({ x: 0, y: 0, w: 1, h: 1 }, W, H), 1, '原图比例的整张也是 1 倍')
  const frame = frameRect(300, 340, aspectOf(square, W, H))
  assert.deepEqual(frame, { x: 16, y: 36, w: 268, h: 268 }, '框尽量大、四周留 16、居中')

  // 手指往右挪 67 像素（框宽的四分之一）：照片跟着往右，框往左挪四分之一个框宽，挪到头就停
  const left = panCrop(square, frame, 67, 0)
  assert.ok(Math.abs(left.x - (0.125 - 0.75 / 4)) < 1e-9 || left.x === 0)
  assert.equal(panCrop(square, frame, 1000, 0).x, 0)
  assert.equal(panCrop(square, frame, -1000, 0).x, 0.25)
  assert.equal(panCrop(square, frame, 0, 50).y, 0, '高已经盖满，上下挪不动')
  // 拖动中：没到边和 panCrop 一样；拖过了边还能再走一点（最多框宽的四分之一），松手 clampCrop 收回边上
  assert.deepEqual(dragCrop(square, frame, 20, 0), panCrop(square, frame, 20, 0))
  const over = dragCrop(square, frame, 1000, 0)
  assert.ok(over.x < 0 && over.x > -0.75 / 4, `拖过边 ${over.x}`)
  assert.ok(dragCrop(square, frame, 200, 0).x > over.x, '越往外越拖不动')
  assert.equal(clampCrop(over).x, 0)
  assert.ok(dragCrop(square, frame, 0, 50).y < 0, '盖满了也能往外拖一点，松手弹回')

  // 两指在框正中捏开到两倍：放大 2 倍，中心不动
  const mid = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }
  const twice = pinchCrop(square, W, H, frame, 100, 200, mid, mid)
  assert.ok(Math.abs(zoomOf(twice, W, H) - 2) < 1e-9)
  assert.ok(Math.abs(twice.x + twice.w / 2 - 0.5) < 1e-9 && Math.abs(twice.y + twice.h / 2 - 0.5) < 1e-9)
  assert.ok(Math.abs(aspectOf(twice, W, H) - 1) < 1e-9, '比例不变')
  // 捏在框的左上角：左上角那一点下面的照片不动
  const corner = { x: frame.x, y: frame.y }
  const atCorner = pinchCrop(square, W, H, frame, 100, 200, corner, corner)
  assert.ok(Math.abs(atCorner.x - square.x) < 1e-9 && Math.abs(atCorner.y - square.y) < 1e-9)
  // 捏小到比 1 倍还小：停在 1 倍；放到很大：停在最多几倍
  assert.ok(Math.abs(zoomOf(pinchCrop(twice, W, H, frame, 200, 10, mid, mid), W, H) - 1) < 1e-9)
  assert.ok(Math.abs(zoomOf(pinchCrop(square, W, H, frame, 10, 10000, mid, mid), W, H) - MAX_ZOOM) < 1e-9)
  // 很小的图（像素画）放不了那么大：框里至少留 MIN_CROP_PIXELS 像素宽
  assert.equal(maxZoom(fullCrop(40, 30, 1), 40, 30), 30 / MIN_CROP_PIXELS)

  // 滑杆：绕框的中心缩放
  const three = zoomCrop(square, W, H, 3)
  assert.ok(Math.abs(zoomOf(three, W, H) - 3) < 1e-9)
  assert.ok(Math.abs(three.x + three.w / 2 - 0.5) < 1e-9)

  // 换比例：放大倍数、中心不变
  const tall = changeAspect(twice, W, H, 3 / 4)
  assert.ok(Math.abs(aspectOf(tall, W, H) - 3 / 4) < 1e-9)
  assert.ok(Math.abs(zoomOf(tall, W, H) - 2) < 1e-9)
  // 整张换成 4:3 还是整张（这张照片本来就是 4:3）
  assert.deepEqual(changeAspect({ x: 0, y: 0, w: 1, h: 1 }, W, H, 4 / 3), { x: 0, y: 0, w: 1, h: 1 })
})

test('缩小按面积平均，透明像素不把颜色拉黑', () => {
  const src = image(2, 2, (x) => (x ? 0xffffff : 0x000000))
  const one = resize(src, 1, 1)
  assert.ok(Math.abs(one.data[0] - 128) <= 1)
  const half = image(
    2,
    1,
    () => 0xff0000,
    (x) => (x ? 0 : 255),
  )
  const r = resize(half, 1, 1)
  assert.equal(r.data[0], 255)
  assert.equal(r.data[1], 0)
  assert.ok(Math.abs(r.data[3] - 128) <= 1)
})

const orange = 0xfda951,
  brown = 0x4b2b1c,
  white = 0xffffff

test('取主色、保细线：一圈细的深色描边在缩小后照样是连着的一圈，不会变成两格粗', () => {
  // 20×20 格，每格 4 像素；在第 4～15 格画一个橙色方块，四周一像素宽的描边压在格子中间
  const cols = 20
  const img = image(cols * 4, cols * 4, (x, y) => {
    const inBox = x >= 16 && x < 64 && y >= 16 && y < 64
    const edge = inBox && (x === 17 || x === 62 || y === 17 || y === 62)
    return !inBox ? white : edge ? brown : orange
  })
  const s = sample(img, cols, cols)
  const p = palette('mard-221')!
  const g = choose(s, { palette: p, maxColors: 3 })
  const code = (x: number, y: number) => g.colors[g.cells[y * cols + x]]
  const line = code(4, 4)
  assert.notEqual(line, code(8, 8), '描边和里面是两种颜色')
  for (let i = 4; i < 16; i++) {
    assert.equal(code(i, 4), line, `上边第 ${i} 格`)
    assert.equal(code(4, i), line, `左边第 ${i} 格`)
    assert.equal(code(i, 15), line)
    assert.equal(code(15, i), line)
  }
  assert.notEqual(code(5, 5), line, '描边只有一格粗')
  // 不保细线时（直接平均）描边会被并掉
  const plain = choose(sample(img, cols, cols, false), { palette: p, maxColors: 3 })
  assert.equal(plain.colors[plain.cells[4 * cols + 8]], plain.colors[plain.cells[8 * cols + 8]])
})

test('保细线不误伤：线占多数的格子不被两旁的底色吃掉，色块边上只沾一点的格子不跟着变色', () => {
  // 20×20 格，每格 4 像素。一条 3 像素宽的竖线压在第 10 格里（占 3/4，左边一像素是底色）；
  // 一块橙色从第 4 格的最后一像素开始、到第 15 格的第一像素结束（两头的格子只沾 1/4）
  const cols = 20
  const img = image(cols * 4, cols * 4, (x, y) => {
    if (y < 40) return x >= 41 && x <= 43 ? brown : white
    return x >= 19 && x <= 60 ? orange : white
  })
  const p = palette('mard-221')!
  const g = choose(sample(img, cols, cols), { palette: p, maxColors: 3 })
  const code = (x: number, y: number) => g.colors[g.cells[y * cols + x]]
  const bg = code(0, 0)
  for (let y = 0; y < 10; y++) assert.notEqual(code(10, y), bg, `竖线第 ${y} 行还在`)
  assert.equal(code(9, 5), bg)
  for (let y = 10; y < 20; y++) {
    assert.equal(code(4, y), bg, `第 ${y} 行：色块左边不胖一格`)
    assert.equal(code(15, y), bg, `第 ${y} 行：色块右边不胖一格`)
    assert.notEqual(code(5, y), bg)
    assert.notEqual(code(14, y), bg)
  }
})

test('保细线不误伤：粗描边压着色块边的格子取描边色，色块那边混了过渡像素也不当成亮线', () => {
  // 10×6 格，每格 4 像素：第 0 行白底，第 1 行是描边——上两像素黑、第三像素是红色压暗三成半（描边边上的过渡）、
  // 第四像素红；往下全是红。描边格里红的那簇被过渡像素拉暗了一截，和下面的红差 0.09，以前会被当成一条亮线、取了红
  const red = 0xef4d3e
  const dim = (c: number, k: number) =>
    (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k)
  const img = image(40, 24, (_x, y) => (y < 4 ? white : y < 6 ? 0x000000 : y === 6 ? dim(red, 0.65) : red))
  const s = sample(img, 10, 6)
  for (let x = 0; x < 10; x++) {
    const i = 10 + x
    assert.ok(s.color[i * 3] < 0.2, `第 ${x} 格取了描边的黑（亮度 ${s.color[i * 3].toFixed(2)}）`)
    assert.notEqual(s.lines?.[i], 2, `第 ${x} 格不是亮线`)
  }
})

test('保小黑点：挨着的两格小黑点配成同一种颜色，不各成一颗零星', () => {
  // 12×12 格的浅色底，每格 4 像素；(5,5) 和 (6,5) 各有一块 2×2 的深色点，一块偏褐、一块偏蓝
  const img = image(48, 48, (x, y) => {
    if (y >= 21 && y <= 22 && x >= 21 && x <= 22) return 0x5a3010
    if (y >= 21 && y <= 22 && x >= 25 && x <= 26) return 0x18204a
    return 0xf2d5b0
  })
  const s = sample(img, 12, 12)
  assert.equal(keepDots(img, s), 2)
  assert.equal(s.lines?.[5 * 12 + 5], 1)
  assert.equal(s.lines?.[5 * 12 + 6], 1)
  assert.deepEqual([...s.color.subarray(65 * 3, 66 * 3)], [...s.color.subarray(66 * 3, 67 * 3)])
  assert.ok(s.color[65 * 3] < 0.4)
})

test('卡通风格：大片照样平滑，细线（嘴、胡须）不被抹掉', async () => {
  // 200×200 的浅色底，一条 4 像素宽的深色横线；转成 20 格时线只有 0.4 格宽
  const img = image(200, 200, (x, y) => (y >= 100 && y < 104 && x >= 40 && x < 160 ? 0x2b2622 : 0xf7d9b0))
  const p = palette('mard-221')!
  for (const style of ['plain', 'cartoon'] as const) {
    const g = await make(img, { cols: 20, palette: p, maxColors: 4, minCluster: 0, style })
    const dark = [...g.cells].filter((c) => c !== EMPTY && p.colors[p.index.get(g.colors[c])!].lab.l < 40)
    assert.ok(dark.length >= 10, `${style}：线还在（${dark.length} 格）`)
  }
})

test('整张挑颜色：多于上限时留下误差最小的几种；一两格但显眼的颜色（高光）留下来', () => {
  // 40 格宽的橙色渐变，中间一格白色高光
  const cols = 40
  const img = image(cols * 4, 8 * 4, (x, y) => {
    if (Math.floor(x / 4) === 20 && Math.floor(y / 4) === 4) return white
    const t = x / (cols * 4)
    return (Math.round(253 - t * 60) << 16) | (Math.round(169 - t * 80) << 8) | Math.round(81 - t * 40)
  })
  const p = palette('mard-221')!
  const g = choose(sample(img, cols, 8), { palette: p, maxColors: 4 })
  assert.ok(g.colors.length <= 4, String(g.colors))
  assert.equal(p.colors[p.index.get(g.colors[g.cells[4 * cols + 20]])!].hex, '#FFFFFF', '高光还在')
  // 渐变上每种颜色连成一段，不会在两种颜色之间来回跳
  for (const m of [4, 6, 15]) {
    const row = choose(sample(img, cols, 8), { palette: p, maxColors: m })
    const codes = [...Array(cols).keys()].map((x) => row.colors[row.cells[2 * cols + x]])
    const runs = codes.filter((c, i) => i === 0 || c !== codes[i - 1])
    assert.equal(runs.length, new Set(runs).size, `${m} 种：${codes.join(' ')}`)
  }
  // 只用店里有的
  const allowed = [p.index.get('A6')!, p.index.get('H2')!]
  const shop = choose(sample(img, cols, 8), { palette: p, allowed, maxColors: 15 })
  assert.deepEqual(new Set(shop.colors), new Set(['A6', 'H2']))
})

test('清掉零星小块：并进四周最多的颜色；锁住的、和四周差很大的不动；空地上的孤点删掉', () => {
  const p = palette('mard-221')!
  // A6 橙色一片，里面一颗 A7（相近的橙）、一颗 H7（黑）、一颗锁住的 A7；外面空地上一颗 A6
  const w = 7,
    h = 5
  const cells = new Uint8Array(w * h).fill(0)
  for (let y = 0; y < h; y++) cells[y * w + 6] = EMPTY
  const g: Grid = { width: w, height: h, palette: 'mard-221', colors: ['A6', 'A7', 'H7'], cells }
  cells[1 * w + 1] = 1
  cells[1 * w + 3] = 2
  cells[3 * w + 1] = 1
  for (let y = 0; y < h; y++) cells[y * w + 5] = EMPTY
  cells[2 * w + 6] = 0
  const locked = new Uint8Array(w * h)
  locked[3 * w + 1] = 1
  const out = cleanup(g, p, { minSize: 3, locked }).grid.cells
  assert.equal(out[1 * w + 1], 0, '相近的橙并进去')
  assert.equal(out[1 * w + 3], 2, '黑色差得大，留着')
  assert.equal(out[3 * w + 1], 1, '锁住的不动')
  assert.equal(out[2 * w + 6], EMPTY, '空地上的孤点删掉')
  assert.equal(cleanup(g, p, { minSize: 0 }).changed, 0)
})

test('页面上的零星数是「几颗及以下」：1 只清单颗、0 不清，和 cleanup 的「少于几颗」差 1', () => {
  assert.deepEqual([0, 1, 2, 3].map(strayLimit), [0, 0, 1, 2])
  assert.deepEqual([0, 1, 2, 9].map(strayMinSize), [0, 2, 3, 10])
  assert.deepEqual([0, 2, 3].map(strayLabel), ['不清零星', '清掉单颗零星', '清掉 2 颗及以下的零星'])
  // A6 一片里一颗 A7 和挨着的两颗 A7：填 1 只并掉单颗，填 2 两颗的也并掉
  const p = palette('mard-221')!
  const w = 9,
    h = 5
  const cells = new Uint8Array(w * h)
  cells[2 * w + 2] = 1
  cells[2 * w + 5] = 1
  cells[2 * w + 6] = 1
  const g: Grid = { width: w, height: h, palette: 'mard-221', colors: ['A6', 'A7'], cells }
  const one = cleanup(g, p, { minSize: strayMinSize(1) }).grid.cells
  assert.deepEqual([one[2 * w + 2], one[2 * w + 5], one[2 * w + 6]], [0, 1, 1])
  const two = cleanup(g, p, { minSize: strayMinSize(2) }).grid.cells
  assert.deepEqual([two[2 * w + 2], two[2 * w + 5], two[2 * w + 6]], [0, 0, 0])
})

test('清零星不拆线、不丢小细节：交替连成一串的描边留着，一整片里两颗的小块留着并成一种；单颗、质感杂色、短串照样并掉', () => {
  const p = palette('mard-221')!
  // 左边 12 列是 A6 / A7 两列一换的竖条（四周不是一整片），右边 12 列是一整片 A6 橙色
  // G13 / M14 彼此差 9，和橙色差 21～24（在「差得很大」的 30 以内）；A18 / G12 彼此差 3，和橙色只差 7～10
  const w = 24,
    h = 8
  const cells = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < 12; x++) cells[y * w + x] = x % 4 < 2 ? 0 : 5
  const g: Grid = { width: w, height: h, palette: 'mard-221', colors: ['A6', 'G13', 'M14', 'A18', 'G12', 'A7'], cells }
  for (let i = 0; i < 6; i++) {
    cells[i * w + i] = i % 2 ? 2 : 1 // 竖条上斜着一条描边，G13 / M14 交替
    cells[i * w + 12 + i] = i % 2 ? 4 : 3 // 橙色上斜着一串质感杂色
  }
  cells[5 * w + 8] = 1 // 竖条上两颗的短串
  cells[6 * w + 9] = 2
  cells[1 * w + 20] = 1 // 橙色上一颗
  cells[5 * w + 20] = 1 // 橙色上两颗挨着的小块（像眼睛）
  cells[5 * w + 21] = 2
  const out = cleanup(g, p, { minSize: 3 }).grid.cells
  for (let i = 0; i < 6; i++) {
    assert.equal(out[i * w + i], i % 2 ? 2 : 1, `描边第 ${i} 颗留着`)
    assert.equal(out[i * w + 12 + i], 0, `杂色第 ${i} 颗并进橙色`)
  }
  assert.equal(out[5 * w + 8], 0, '短串并进竖条')
  assert.equal(out[6 * w + 9], 0, '短串并进竖条')
  assert.equal(out[1 * w + 20], 0, '单颗并掉')
  // 一样多时取和橙色差得多的 M14
  assert.equal(out[5 * w + 20], 2, '小块留着，并成一种颜色')
  assert.equal(out[5 * w + 21], 2, '小块留着')
})

test('整条流水线：一张放大、加了噪点的像素小猫，转回来几乎一格不差', async () => {
  const rows = [
    '....KKKK....',
    '...KOOOOK...',
    '..KOOOOOOK..',
    '.KOOEOOEOOK.',
    '.KOOOOOOOOK.',
    '.KOOOPPOOOK.',
    '..KOOOOOOK..',
    '...KKKKKK...',
  ]
  const color: Record<string, number> = { K: brown, O: orange, E: 0x2c2c2c, P: 0xfcadb2 }
  const scale = 10
  let noise = 7
  const rand = () => ((noise = (noise * 1103515245 + 12345) & 0x7fffffff) % 21) - 10
  const img = image(12 * scale, 8 * scale, (x, y) => {
    const ch = rows[Math.floor(y / scale)][Math.floor(x / scale)]
    if (ch === '.') return white
    const c = color[ch]
    const j = rand()
    const k = (v: number) => Math.max(0, Math.min(255, v + j))
    return (k((c >> 16) & 255) << 16) | (k((c >> 8) & 255) << 8) | k(c & 255)
  })
  const p = palette('mard-221')!
  // 背景透明（像抠好的贴纸 PNG）
  const view = { ...img, data: img.data.slice() }
  for (let y = 0; y < view.height; y++)
    for (let x = 0; x < view.width; x++)
      if (rows[Math.floor(y / scale)][Math.floor(x / scale)] === '.') view.data[(y * view.width + x) * 4 + 3] = 0
  assert.equal(rowsFor(12, view.width, view.height), 8)
  const g = await make(view, { cols: 12, palette: p, maxColors: 8, minCluster: 2, style: 'plain' })
  let wrong = 0
  const expected: Record<string, string> = {}
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) {
      const ch = rows[y][x]
      const got = g.cells[y * 12 + x] === EMPTY ? '.' : g.colors[g.cells[y * 12 + x]]
      if (ch === '.') {
        if (got !== '.') wrong++
        continue
      }
      expected[ch] ??= got
      if (expected[ch] !== got) wrong++
    }
  assert.equal(wrong, 0)
  assert.equal(new Set(Object.values(expected)).size, 4, '四种颜色各是各的')
})

test('写实：每格配最接近的颜色；颜色超过上限时去掉用得最少的；只用给定的颜色；透明的格子是空', async () => {
  const p = palette('mard-221')!
  // 一行 8 格：A1 五格、B5 两格、H7 一格，最后一格透明
  const codes = ['A1', 'A1', 'A1', 'A1', 'A1', 'B5', 'B5', 'H7']
  const cols = codes.length + 1
  const color = new Float32Array(cols * 3)
  const opaque = new Uint8Array(cols)
  codes.forEach((code, i) => {
    color.set(p.oklab.subarray(p.index.get(code)! * 3, p.index.get(code)! * 3 + 3), i * 3)
    opaque[i] = 1
  })
  const s = { cols, rows: 1, color, opaque }
  const step = async () => {}
  const all = await nearestGrid(s, p, { maxColors: 64 }, step)
  assert.deepEqual(
    [...all.cells].map((c) => (c === EMPTY ? '.' : all.colors[c])),
    [...codes, '.'],
  )
  // 上限 2 种：用得最少的 H7 并掉
  const two = await nearestGrid(s, p, { maxColors: 2 }, step)
  assert.deepEqual(new Set(two.colors), new Set(['A1', 'B5']))
  // 只能用 A1、H7：B5 的格子改配这两种里接近的
  const only = await nearestGrid(s, p, { allowed: [p.index.get('A1')!, p.index.get('H7')!], maxColors: 64 }, step)
  assert.ok(only.colors.every((c) => c === 'A1' || c === 'H7'))
  // 生成：写实风格颜色上限按 64 种算，照片里的颜色都留着
  const view = pixels(cols * 4, 4)
  codes.forEach((code, i) => {
    const rgb = p.colors[p.index.get(code)!].rgb
    for (let y = 0; y < 4; y++)
      for (let x = i * 4; x < i * 4 + 4; x++) {
        const at = (y * view.width + x) * 4
        view.data.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255], at)
      }
  })
  const g = await make(view, { cols, palette: p, maxColors: 64, minCluster: 0, style: 'real' })
  assert.deepEqual(new Set(g.colors), new Set(['A1', 'B5', 'H7']))
})

test('写实取主色：格子里出现最多的那个颜色胜出，渐变里各不相同的像素敌不过一小块匀的颜色；过半透明的格子是空', () => {
  // 两格，每格 4×4：左格 11 个各不相同的浅色（渐变）+ 5 个一样的深色（眼线），右格 9 个透明
  const img = pixels(8, 4)
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 8; x++) {
      const at = (y * 8 + x) * 4
      const k = y * 4 + (x % 4)
      if (x < 4) img.data.set(k < 5 ? [30, 20, 20, 255] : [200 + k, 180 + k, 170 + k, 255], at)
      else img.data.set([90, 120, 200, k < 9 ? 0 : 255], at)
    }
  const s = modeSample(img, 2, 1)
  assert.equal(oklabToRgb(s.color[0], s.color[1], s.color[2]), (30 << 16) | (20 << 8) | 20)
  assert.deepEqual([...s.opaque], [1, 0])
  // 最多的颜色不到 repeat 次（这里要 6 次，左格的深色只有 5 个）就照抄 fallback 的那格；右格的蓝色有 7 个，照旧按过半透明算空
  const fallback = { cols: 2, rows: 1, color: new Float32Array([0.5, 0, 0, 0.6, 0, 0]), opaque: new Uint8Array([1, 1]) }
  const weak = modeSample(img, 2, 1, fallback, 6)
  assert.deepEqual([...weak.color.subarray(0, 3)], [0.5, 0, 0])
  assert.deepEqual([...weak.opaque], [1, 0])
})
