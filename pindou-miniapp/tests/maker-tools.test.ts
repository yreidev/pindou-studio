import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  boardColors,
  boards,
  boardsNeeded,
  finishedSize,
  markColor,
  nextRow,
  progress,
  rowRuns,
} from '../src/services/maker/boards'
import { Editor, linePoints, rectOf, shapePoints, TooManyColors } from '../src/services/maker/edit'
import { cleanName, fromCsv, fromFile, toCsv, toFile } from '../src/services/maker/file'
import { blankDone, blankGrid, EMPTY, encodeCells, isDone, setDone, type Grid } from '../src/services/maker/grid'
import { pixels, type Pixels } from '../src/services/maker/image'
import { detect, readCells } from '../src/services/maker/importer'
import { recognize } from '../src/services/maker/recognize'
import { palette } from '../src/services/maker/palettes'
import {
  cellAt,
  drawExport,
  drawGrid,
  exportLayout,
  fitView,
  settleView,
  stretchScale,
  stretchView,
  zoomView,
  type Ctx,
} from '../src/services/maker/render'
import {
  fromServer,
  localDrafts,
  loadLocal,
  pickCopy,
  saveLocal,
  sync,
  toInput,
  type BeadPattern,
  type Draft,
  type StoragePort,
} from '../src/services/maker/store'

// 「做图纸」的改图、分板、导入像素画、图纸文件、本机存与同步、画图（docs/plan-bead-maker.md 第 3 节 5～9）。

const mard = palette('mard-221')!

function grid(rows: string[], colors: string[]): Grid {
  const g = blankGrid(rows[0].length, rows.length, 'mard-221')
  g.colors = [...colors]
  rows.forEach((row, y) => [...row].forEach((ch, x) => (g.cells[y * g.width + x] = ch === '.' ? EMPTY : Number(ch))))
  return g
}
const show = (g: Grid) =>
  Array.from({ length: g.height }, (_, y) =>
    Array.from({ length: g.width }, (_, x) => {
      const v = g.cells[y * g.width + x]
      return v === EMPTY ? '.' : String(v)
    }).join(''),
  )

test('画笔连着画不断线、对称四面一起画；一笔算一步，撤销重做不限步数', () => {
  const e = new Editor(blankGrid(6, 4, 'mard-221'))
  e.paint(0, 0, 'A6')
  e.paint(3, 0, 'A6', 'none', [0, 0])
  assert.equal(e.end(), 4)
  assert.deepEqual(show(e.grid), ['0000..', '......', '......', '......'])
  e.paint(1, 1, 'H7', 'quad')
  e.end()
  assert.deepEqual(show(e.grid), ['0000..', '.1..1.', '.1..1.', '......'])
  e.paint(1, 1, null)
  e.end()
  assert.equal(e.at(1, 1), EMPTY)
  assert.ok(e.undo() && e.undo())
  assert.deepEqual(show(e.grid), ['0000..', '......', '......', '......'])
  assert.ok(e.redo())
  assert.equal(e.at(4, 2), 1)
  // 撤销后再画，重做清空
  e.undo()
  e.paint(5, 3, 'A6')
  e.end()
  assert.equal(e.canRedo, false)
  assert.equal(e.pick(5, 3), 'A6')
  assert.equal(e.pick(0, 3), null)
})

test('填充只填同色连着的一片，锁住的格子挡住；换色、去零星跳过锁住的格子', () => {
  // A7 是和 A6 相近的橙色，去零星时能并（差得很大的不并，见 maker-core）
  const e = new Editor(grid(['000.', '0110', '0000'], ['A6', 'A7']))
  e.lock([1 * 4 + 0], true)
  e.fill(0, 0, 'B5')
  // 左边那格锁着、右上角是空的，第一行和下面连不上
  assert.deepEqual(show(e.grid), ['222.', '0110', '0000'])
  e.undo()
  e.undo() // 锁也能撤销
  assert.equal(e.locked[4], 0)
  e.fill(0, 0, 'B5')
  assert.deepEqual(show(e.grid), ['222.', '2112', '2222'])
  e.undo()
  e.lock([1 * 4 + 1], true)
  e.replace('A7', 'A6')
  assert.deepEqual(show(e.grid), ['000.', '0100', '0000'])
  const changed = e.cleanup(mard, 3)
  assert.equal(changed, 0, '锁住的那颗不并')
  e.lock([5], false)
  e.cleanup(mard, 3)
  assert.equal(e.at(1, 1), 0)
})

test('加描边、背景填色、满 64 种颜色时报错', () => {
  const e = new Editor(grid(['....', '.00.', '....'], ['A6']))
  e.outline('H7')
  assert.deepEqual(show(e.grid), ['.11.', '1001', '.11.'])
  e.background('H2')
  assert.deepEqual(show(e.grid), ['2112', '1001', '2112'])
  const full = new Editor(blankGrid(4, 4, 'mard-221'))
  full.grid.colors = mard.colors.slice(0, 64).map((c) => c.code)
  assert.throws(() => full.paint(0, 0, mard.colors[100].code), TooManyColors)
})

test('直线、方框、圆：空心的圆是一圈连着、只有一格粗', () => {
  assert.deepEqual(linePoints(0, 0, 3, 1), [
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 1],
  ])
  assert.equal(shapePoints('rect', [0, 0], [3, 2], false).length, 10)
  assert.equal(shapePoints('rect', [3, 2], [0, 0], true).length, 12)
  const ring = new Set(shapePoints('ellipse', [0, 0], [10, 10], false).map(([x, y]) => `${x},${y}`))
  const disk = new Set(shapePoints('ellipse', [0, 0], [10, 10], true).map(([x, y]) => `${x},${y}`))
  assert.ok(disk.has('5,5') && !ring.has('5,5'))
  assert.ok(ring.has('0,5') && ring.has('5,0') && ring.has('10,5'))
  // 圈上每格都至少挨着另外两格（八邻），没有断口
  for (const key of ring) {
    const [x, y] = key.split(',').map(Number)
    let n = 0
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && ring.has(`${x + dx},${y + dy}`)) n++
    assert.ok(n >= 2, key)
  }
})

test('框选以后：移动、复制一份、翻过来、转 90°；空格子当透明', () => {
  const e = new Editor(grid(['01..', '2...', '....'], ['A6', 'H7', 'B5']))
  const r = rectOf([1, 1], [0, 0], 4, 3)
  assert.deepEqual(r, { x: 0, y: 0, w: 2, h: 2 })
  assert.deepEqual(e.move(r, 2, 1), { x: 2, y: 1, w: 2, h: 2 })
  assert.deepEqual(show(e.grid), ['....', '..01', '..2.'])
  e.undo()
  e.duplicate(r, 2, 0)
  assert.deepEqual(show(e.grid), ['0101', '2.2.', '....'])
  e.undo()
  e.flip(r)
  assert.deepEqual(show(e.grid), ['10..', '.2..', '....'])
  e.undo()
  assert.deepEqual(e.rotate({ x: 0, y: 0, w: 2, h: 1 }), { x: 0, y: 0, w: 1, h: 2 })
  assert.deepEqual(show(e.grid), ['0...', '1...', '....'])
})

test('分板、每块每种颜色、按行的连续段、成品大小和进度', () => {
  const g = blankGrid(104, 78, 'mard-221')
  assert.equal(boards(g, 52).length, 4)
  assert.deepEqual(boards(g, 52)[3], { index: 3, col: 1, row: 1, x: 52, y: 52, w: 52, h: 26 })
  assert.equal(boardsNeeded(g, 29), 12)
  assert.deepEqual(finishedSize(g, 2.6), { width: 27, height: 20.3 })
  const small = grid(['0011.0', '..1111'], ['A6', 'H7'])
  assert.deepEqual(rowRuns(small, 0), [
    { color: 0, start: 0, count: 2 },
    { color: 1, start: 2, count: 2 },
    { color: EMPTY, start: 4, count: 1 },
    { color: 0, start: 5, count: 1 },
  ])
  assert.deepEqual(
    rowRuns(grid(['00..'], ['A6']), 0).map((r) => r.count),
    [2],
    '行尾的空格子不说',
  )
  const done = blankDone(small)
  const b = { index: 0, col: 0, row: 0, x: 0, y: 0, w: 6, h: 2 }
  assert.equal(markColor(small, done, b, 0, true), 3)
  assert.deepEqual(
    boardColors(small, done, b).map((c) => [c.code, c.count, c.done]),
    [
      ['H7', 6, 0],
      ['A6', 3, 3],
    ],
  )
  assert.equal(nextRow(small, done, 0), 0)
  for (let x = 0; x < 6; x++) setDone(done, x, small.cells[x] !== EMPTY)
  assert.equal(nextRow(small, done, 0), 1)
  assert.equal(progress(9, 4), 44)
  assert.equal(progress(9, 9), 100)
  assert.equal(progress(0, 0), 0)
})

function screenshot(cells: string[], colors: Record<string, number>, size: number, lines: boolean): Pixels {
  const pad = 13
  const w = cells[0].length * size + pad * 2,
    h = cells.length * size + pad * 2
  const img = pixels(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cx = Math.floor((x - pad) / size),
        cy = Math.floor((y - pad) / size)
      let c = 0xffffff
      if (cx >= 0 && cy >= 0 && cy < cells.length && cx < cells[0].length) {
        const ch = cells[cy][cx]
        if (ch !== '.') c = colors[ch]
        if (lines && ((x - pad) % size === 0 || (y - pad) % size === 0)) c = 0xcccccc
      }
      const i = (y * w + x) * 4
      img.data[i] = c >> 16
      img.data[i + 1] = (c >> 8) & 255
      img.data[i + 2] = c & 255
      img.data[i + 3] = 255
    }
  return img
}

test('导入像素画：认出格子周期和格数，每格对到色卡，四边的背景算空', () => {
  const cells = ['..KKKK..', '.KOOOOK.', 'KOEOOEOK', 'KOOOOOOK', 'KOOPPOOK', '.KOOOOK.', '..KKKK..', '........']
  const colors = { K: 0x4b2b1c, O: 0xfda951, E: 0x2c2c2c, P: 0xfcadb2 }
  for (const [size, lines] of [
    [12, false],
    [9, true],
    [17, true],
  ] as const) {
    const img = screenshot(cells, colors, size, lines)
    const d = detect(img)
    // 没格线时最后一行全空，内容范围只到第 7 行
    assert.equal(d.cols, 8, `${size}`)
    const g = readCells(img, lines ? d : { ...d, rows: 7 }, mard)
    const codes = g.colors
    const at = (x: number, y: number) => (g.cells[y * 8 + x] === EMPTY ? '.' : codes[g.cells[y * 8 + x]])
    assert.equal(at(0, 0), '.')
    assert.equal(at(2, 0), at(0, 2), '描边同色')
    assert.equal(mard.colors[mard.index.get(at(2, 1))!].hex, '#FDA951', '橙色对到色卡里同一个颜色')
    assert.notEqual(at(2, 2), at(2, 1), '眼睛')
    assert.notEqual(at(1, 1), at(2, 1))
  }
})

test('图纸文件和表格：导出再导回一模一样；不合规矩的说清楚哪里不对', () => {
  const g = grid(['012.', '2..1', '....', '0...'], ['A6', 'H7', 'B5', 'C3'])
  const done = blankDone(g)
  setDone(done, 1, true)
  const text = toFile({ name: ' 小猫 ', grid: g, done })
  const back = fromFile(text)
  assert.ok(back.ok)
  if (!back.ok) return
  assert.equal(back.pattern.name, '小猫')
  assert.deepEqual(back.pattern.grid.colors, ['A6', 'H7', 'B5'], '没用到的 C3 去掉')
  assert.equal(encodeCells(back.pattern.grid.cells), '012.2..1....0...')
  assert.ok(isDone(back.pattern.done, 1))
  const bad = (patch: Record<string, unknown>) => {
    const r = fromFile(JSON.stringify({ ...JSON.parse(text), ...patch }))
    return r.ok ? '' : r.error
  }
  assert.equal(bad({ format: 'x' }), '这不是图纸文件')
  assert.match(bad({ version: 2 }), /新版本/)
  assert.match(bad({ name: '一'.repeat(21) }), /1～20/)
  assert.match(bad({ palette: 'nope' }), /色卡/)
  assert.match(bad({ width: 301 }), /4～300/)
  assert.match(bad({ colors: ['A6', 'A6', 'B5'] }), /不能重复/)
  assert.match(bad({ cells: '012.2..9....0...' }), /格子/)
  assert.match(bad({ done: 'AAAA' }), /拼完/)
  assert.equal(fromFile('not json').ok, false)
  assert.equal(cleanName('a\nb'), undefined)

  const csv = toCsv(g)
  assert.equal(csv.split('\r\n')[0], '4,4,mard-221')
  assert.equal(csv.split('\r\n')[1], 'A6,H7,B5,')
  const parsed = fromCsv('﻿' + csv.replace('A6', 'a6'))
  assert.ok(parsed.ok)
  if (parsed.ok) assert.equal(encodeCells(parsed.grid.cells), '012.2..1....0...')
  assert.match((fromCsv('4,4,mard-221\nA6,ZZ9\n\n\n,\n') as { error: string }).error, /第 2 行第 2 格/)
  assert.match((fromCsv('4,5,mard-221\nA6\n') as { error: string }).error, /5 行/)
  assert.match((fromCsv('A6,H7\n') as { error: string }).error, /第一行/)
})

function memory(): StoragePort & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: (k) => data.get(k),
    set: (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))),
    remove: (k) => void data.delete(k),
  }
}
const draft = (id: string, patch: Partial<Draft> = {}): Draft => {
  const g = grid(['01', '10'], ['A6', 'H7'])
  return {
    id,
    name: '小猫',
    grid: g,
    done: blankDone(g),
    locked: new Uint8Array(4),
    revision: 0,
    inAccount: false,
    dirty: true,
    updatedAt: 1,
    ...patch,
  }
}

test('存在手机上：锁住的格子也存；没存进账户的最多 3 张，账户图纸的副本只挤掉同步完的', () => {
  const port = memory()
  const d = draft('a')
  d.locked[2] = 1
  setDone(d.done, 0, true)
  saveLocal(port, d)
  const back = loadLocal(port, 'a')!
  assert.equal(back.locked[2], 1)
  assert.ok(isDone(back.done, 0))
  for (const id of ['b', 'c', 'd']) saveLocal(port, draft(id))
  assert.deepEqual(
    localDrafts(port).map((x) => x.id),
    ['d', 'c', 'b'],
  )
  for (let i = 0; i < 14; i++) saveLocal(port, draft(`s${i}`, { inAccount: true, dirty: i === 0 }))
  const kept = localDrafts(port).map((x) => x.id)
  assert.ok(kept.includes('s0'), '没同步完的不挤')
  assert.equal(kept.filter((id) => id.startsWith('s')).length, 13)
})

const server = (d: Draft, revision: number): BeadPattern => ({
  id: d.id,
  name: d.name,
  palette: d.grid.palette,
  width: d.grid.width,
  height: d.grid.height,
  colors: d.grid.colors,
  cells: encodeCells(d.grid.cells),
  done: '',
  beads: 4,
  doneBeads: 0,
  revision,
  createdAt: '2026-10-21T00:00:00Z',
  updatedAt: '2026-10-21T00:00:00Z',
})

test('同步进账户：带读到的修订号；途中又改了算没同步完；冲突、存满、没网分开说', async () => {
  const port = memory()
  const d = draft('a', { inAccount: true })
  d.grid.colors.push('Z9') // 编辑时加进来又没用上的颜色
  assert.deepEqual(toInput(d).colors, ['A6', 'H7'])
  let sent: unknown
  const ok = await sync(port, d, {
    save: async (_id, input) => {
      sent = input
      d.updatedAt = 2 // 同步途中顾客又改了一步
      return server(d, 1)
    },
  })
  assert.deepEqual(ok, { status: 'saved', revision: 1 })
  assert.equal((sent as { expectedRevision: number }).expectedRevision, 0)
  assert.equal(d.dirty, true)
  const fail = (code: string, status: number) => async () => {
    throw Object.assign(new Error('x'), { code, status })
  }
  assert.equal((await sync(port, d, { save: fail('bead_pattern_conflict', 409) })).status, 'conflict')
  assert.equal((await sync(port, d, { save: fail('bead_pattern_limit', 409) })).status, 'full')
  assert.equal((await sync(port, d, { save: fail('network', 0) })).status, 'later')
  assert.equal((await sync(port, { ...d, name: '  ' }, { save: fail('x', 0) })).status, 'invalid')
  // 打开账户里的一张：手机上的副本从同一修订号改起就用手机上的
  assert.equal(pickCopy(server(d, 1), { ...d, revision: 1, dirty: true })!.draft.dirty, true)
  assert.equal(pickCopy(server(d, 2), { ...d, revision: 1, dirty: true })!.conflict, true)
  assert.equal(pickCopy(server(d, 2), { ...d, revision: 1, dirty: false })!.draft.revision, 2)
  assert.equal(fromServer({ ...server(d, 1), cells: 'xx' }), undefined)
})

function fakeCtx() {
  const calls: string[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) =>
      key in target ? target[key] : (...args: unknown[]) => calls.push(`${key}:${args.join(',')}`),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as Ctx
  return { ctx, calls }
}

test('画布拖出边界有阻尼、松手收回：图小时整张留在画布里，图大时不露出外面的空白，缩过上下限按对数阻尼', () => {
  const g = blankGrid(10, 10, 'perler-103')
  // 每格 20 像素、200×200 的图放在 400×300 的画布里：x 能在 -24～224 之间
  const inside = { scale: 20, x: 100, y: 50 }
  assert.deepEqual(stretchView(inside, g, 400, 300), inside, '界内原样')
  const far = stretchView({ scale: 20, x: 1000, y: 50 }, g, 400, 300)
  assert.ok(far.x > 224 && far.x < 224 + 100, `拖出右边 ${far.x}`)
  assert.deepEqual(settleView(far, g, 400, 300, 200, 150), { scale: 20, x: 224, y: 50 })
  // 每格 64 像素、640×640 的图比画布大：左边最多到 24，右边最少到 400-640-24
  assert.equal(settleView({ scale: 64, x: 300, y: 0 }, g, 400, 300, 200, 150).x, 24)
  assert.equal(settleView({ scale: 64, x: -900, y: 0 }, g, 400, 300, 200, 150).x, 400 - 640 - 24)

  assert.equal(stretchScale(10), 10)
  const big = stretchScale(640)
  assert.ok(big > 64 && big < 64 * Math.exp(0.3), `放过头 ${big}`)
  const small = stretchScale(0.2)
  assert.ok(small < 2 && small > 2 * Math.exp(-0.3), `缩过头 ${small}`)
  // 缩过头松手：倍数回到下限，手指中点下面的格子不动
  const back = settleView({ scale: 1, x: 100, y: 100 }, g, 400, 300, 105, 105, 2)
  assert.equal(back.scale, 2)
  assert.deepEqual(cellAt(back, 105, 105), cellAt({ scale: 1, x: 100, y: 100 }, 105, 105))
})

test('画图：同色连着的格子一条路径一次填完；视图缩放围着手指；导出图片排得下', () => {
  const g = grid(['0011', '0011', '2222'], ['A6', 'H7', 'B5'])
  const { ctx, calls } = fakeCtx()
  const v = fitView(g, 400, 300)
  drawGrid(ctx, g, mard, v, 400, 300, { background: '#f7f5f0', gridColor: '#e4ddcf' })
  assert.equal(calls.filter((c) => c === 'fill:').length, 3, '三种颜色三次填充')
  assert.equal(calls.filter((c) => c.startsWith('rect:')).length, 5)
  const z = zoomView(v, 2, 200, 150)
  assert.deepEqual(cellAt(z, 200, 150), cellAt(v, 200, 150))
  const { ctx: c2, calls: out } = fakeCtx()
  drawGrid(c2, g, mard, v, 400, 300, { background: '#000', highlight: 2 })
  assert.equal(out.filter((c) => c === 'fill:').length, 3, '调暗的另画一遍')
  const big = blankGrid(300, 300, 'perler-103')
  const L = exportLayout(big, 64)
  assert.ok(L.width <= 4000 && L.height <= 4000, `${L.width}×${L.height}`)
  const { ctx: c3, calls: text } = fakeCtx()
  drawExport(c3, grid(['01', '10'], ['A6', 'H7']), mard, {
    name: '小猫',
    date: '2026-10-21',
    storeName: 'Example拼豆',
    beadMm: 2.6,
    boardSize: 52,
  })
  assert.ok(text.some((c) => c.startsWith('fillText:Example拼豆')))
  assert.ok(text.some((c) => c.startsWith('fillText:A6')))
})

test('「我的图纸」一行：账户里的加上账户里还没有的，最近改的那张拼到多少', async () => {
  const { myPatterns } = await import('../src/services/maker/mine')
  const local = (id: string, inAccount: boolean, updatedAt: number) => ({
    id,
    name: id,
    inAccount,
    dirty: true,
    updatedAt,
    beads: 10,
    doneBeads: 4,
  })
  const server = (id: string, updatedAt: string) => ({
    id,
    name: id,
    palette: 'mard-221',
    width: 4,
    height: 4,
    colors: [],
    preview: '',
    previewWidth: 1,
    previewHeight: 1,
    beads: 8,
    doneBeads: 8,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
  })
  const list = { patterns: [server('s1', '2026-10-21T01:00:00Z'), server('both', '2026-10-21T00:00:00Z')], limit: 30 }
  const phone = [
    local('only-phone', false, Date.parse('2026-10-20T00:00:00Z')),
    local('both', true, 0),
    local('pending', true, Date.parse('2026-10-21T02:00:00Z')),
  ]
  // 账户里已有的不重复算；点了存进账户还没存上的照样算
  const signedIn = myPatterns(list, phone)
  assert.equal(signedIn.count, 4)
  assert.equal(signedIn.latest?.id, 'pending')
  assert.equal(signedIn.latestProgress, 40)
  // 没登录：只有手机上的
  const anonymous = myPatterns(undefined, phone)
  assert.equal(anonymous.count, 3)
  assert.equal(myPatterns(undefined, []).latest, undefined)
})

// ---------------------------------------------------------------- 认格子（recognize）

// 画一张「电子图纸」：细格线 + 每 5 格一条粗线 + 边上坐标数字 + 底部色号统计，
// 这几样正是旧版 detect() 会认错的东西。
function chart(cols: number, rows: number, pitch: number, opt: { axes?: boolean; legend?: boolean } = {}) {
  const pad = Math.round(pitch * 1.6)
  const legendH = opt.legend ? Math.round(pitch * 3) : 0
  const w = cols * pitch + pad * 2,
    h = rows * pitch + pad * 2 + legendH
  const img = pixels(w, h)
  const fill = (x: number, y: number, c: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 4
    img.data[i] = c >> 16
    img.data[i + 1] = (c >> 8) & 255
    img.data[i + 2] = c & 255
    img.data[i + 3] = 255
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fill(x, y, 0xffffff)
  const palette = [0xf28b82, 0xfbbc04, 0x34a853, 0x4285f4, 0xa142f4, 0x00acc1]
  // 格子
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const color = palette[(r * 7 + c * 3) % palette.length]
      for (let y = 0; y < pitch; y++)
        for (let x = 0; x < pitch; x++) fill(pad + c * pitch + x, pad + r * pitch + y, color)
    }
  // 格线：细线 1 像素，每 5 格一条 2 像素粗线
  for (let c = 0; c <= cols; c++) {
    const thick = c % 5 === 0 ? 2 : 1
    for (let y = 0; y < rows * pitch; y++) for (let t = 0; t < thick; t++) fill(pad + c * pitch + t, pad + y, 0x000000)
  }
  for (let r = 0; r <= rows; r++) {
    const thick = r % 5 === 0 ? 2 : 1
    for (let x = 0; x < cols * pitch; x++) for (let t = 0; t < thick; t++) fill(pad + x, pad + r * pitch + t, 0x000000)
  }
  // 坐标数字：沿上边和左边各画一排短竖线（模拟字的一竖，高度约为格的 40%）
  if (opt.axes) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * pitch + Math.floor(pitch / 2)
      for (let y = pad - Math.round(pitch * 0.7); y < pad - 2; y++) fill(x, y, 0x333333)
    }
    for (let r = 0; r < rows; r++) {
      const y = pad + r * pitch + Math.floor(pitch / 2)
      for (let x = pad - Math.round(pitch * 0.7); x < pad - 2; x++) fill(x, y, 0x333333)
    }
  }
  // 底部色号统计：几行小色块 + 短字
  if (opt.legend) {
    const ly = pad + rows * pitch + Math.round(pitch * 0.6)
    for (let i = 0; i < 4; i++) {
      const lx = pad + i * pitch * 3
      for (let y = 0; y < pitch; y++) for (let x = 0; x < pitch; x++) fill(lx + x, ly + y, palette[i])
      for (let x = 0; x < pitch * 2; x++)
        for (let y = 0; y < 2; y++) fill(lx + pitch + x, ly + y + Math.floor(pitch / 2), 0x444444)
    }
  }
  return img
}

test('认格子：电子图纸的格数一次认对，不受坐标数字和底部色号统计干扰', () => {
  for (const [cols, rows, pitch] of [
    [24, 20, 20],
    [30, 19, 16],
    [13, 27, 24],
  ] as const) {
    for (const opt of [{}, { axes: true }, { axes: true, legend: true }]) {
      const img = chart(cols, rows, pitch, opt)
      const r = recognize(img)
      assert.ok(r, `${cols}×${rows} pitch=${pitch} ${JSON.stringify(opt)} 应认得出`)
      if (!r) continue
      assert.equal(r.cols, cols, `列数 ${cols}×${rows} pitch=${pitch} ${JSON.stringify(opt)}`)
      assert.equal(r.rows, rows, `行数 ${cols}×${rows} pitch=${pitch} ${JSON.stringify(opt)}`)
      // 格宽要落在 5% 内，位置误差不超过半格
      assert.ok(Math.abs(r.pitchX - pitch) / pitch < 0.05, `格宽 ${r.pitchX} vs ${pitch}`)
      assert.ok(Math.abs(r.pitchY - pitch) / pitch < 0.05, `格高 ${r.pitchY} vs ${pitch}`)
      assert.ok(r.confidence > 0.5, `置信度 ${r.confidence}`)
      assert.equal(r.lined, true)
    }
  }
})

test('认格子：格数是数出来的，正负一格都会被抓到', () => {
  // 同一张图裁掉不同数量的格子，认出来的格数必须跟着变
  const pitch = 20
  for (const cols of [8, 12, 17, 24]) {
    const img = chart(cols, 9, pitch)
    const r = recognize(img)
    assert.ok(r)
    assert.equal(r?.cols, cols, `宽 ${cols} 格`)
    assert.equal(r?.rows, 9, `高 9 行`)
  }
})

test('认格子：纯色块、没有贯穿格线时也能定出周期', () => {
  // 无格线像素画：相邻格同色时没有边界，靠色块边界定周期
  const pitch = 16
  const cols = 20,
    rows = 16
  const pad = 8
  const w = cols * pitch + pad * 2,
    h = rows * pitch + pad * 2
  const img = pixels(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const cx = Math.floor((x - pad) / pitch),
        cy = Math.floor((y - pad) / pitch)
      const inside = cx >= 0 && cy >= 0 && cx < cols && cy < rows
      const c = !inside ? 0xffffff : (cx + cy) % 3 === 0 ? 0xe53935 : (cx + cy) % 3 === 1 ? 0x1e88e5 : 0xfdd835
      img.data[i] = c >> 16
      img.data[i + 1] = (c >> 8) & 255
      img.data[i + 2] = c & 255
      img.data[i + 3] = 255
    }
  const r = recognize(img)
  assert.ok(r)
  assert.ok(Math.abs((r?.pitchX ?? 0) - pitch) / pitch < 0.08, `格宽 ${r?.pitchX}`)
  assert.equal(r?.cols, cols)
  assert.equal(r?.rows, rows)
})

test('认格子：空白图和过小的图不会崩', () => {
  assert.equal(recognize(pixels(200, 200)), undefined)
  assert.equal(recognize(pixels(8, 8)), undefined)
  // detect() 兜底：认不出来给整图 + 16 像素一格
  const d = detect(pixels(200, 120))
  assert.deepEqual(d, { x: 0, y: 0, w: 200, h: 120, cols: 13, rows: 8 })
})
