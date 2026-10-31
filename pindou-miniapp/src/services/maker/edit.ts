import { cleanup } from './cleanup'
import { colorIndex, EMPTY, type Grid } from './grid'
import type { Palette } from './palettes'

// 改图（docs/plan-bead-maker.md 第 3 节 5）：画笔、橡皮、填充、取色、对称、直线方框圆、框选以后搬动，
// 整张图的换色、加描边、背景填色、去零星；撤销重做存每一步改了哪些格子、改前改后，不限步数。
// 锁住的格子：填充、换色、加描边、背景填色、去零星都跳过它（整片的操作），画笔、橡皮、形状、框选是顾客直接点的，照改。
// 编辑时颜色只往 colors 后面加、不删（序号不变，撤销才对得上），存的时候再 compact。

export type Symmetry = 'none' | 'horizontal' | 'vertical' | 'quad'
export const symmetryNames: Record<Symmetry, string> = {
  none: '不对称',
  horizontal: '左右',
  vertical: '上下',
  quad: '四面',
}

export type Rect = { x: number; y: number; w: number; h: number }
export type Shape = 'line' | 'rect' | 'ellipse'

/** 一步改动：哪些格子、改前改后的值；锁也一样记。 */
type Step = {
  index: Int32Array
  before: Uint8Array
  after: Uint8Array
  lock?: { index: Int32Array; after: Uint8Array }
}

export class TooManyColors extends Error {
  constructor() {
    super('一张图纸最多 64 种颜色')
  }
}

export class Editor {
  readonly locked: Uint8Array
  private undoSteps: Step[] = []
  private redoSteps: Step[] = []
  /** 正在画的这一笔：格子 → 改之前的值 */
  private pending = new Map<number, number>()
  /** 每次改完加一，界面据此重画、自动存 */
  version = 0

  constructor(
    readonly grid: Grid,
    locked?: Uint8Array,
  ) {
    this.locked = locked ?? new Uint8Array(grid.cells.length)
  }

  get canUndo() {
    return this.undoSteps.length > 0
  }
  get canRedo() {
    return this.redoSteps.length > 0
  }

  at(x: number, y: number) {
    return this.grid.cells[y * this.grid.width + x]
  }
  inside(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.grid.width && y < this.grid.height
  }

  /** 色号在这张图里的序号，没有就加进去；null 是空（橡皮）。 */
  slot(code: string | null): number {
    if (code === null) return EMPTY
    const i = colorIndex(this.grid, code)
    if (i < 0) throw new TooManyColors()
    return i
  }

  /** 取色：这一格的色号，空格子是 null。 */
  pick(x: number, y: number): string | null {
    const v = this.at(x, y)
    return v === EMPTY ? null : this.grid.colors[v]
  }

  // —— 一笔一笔画：begin 之后 set 若干次，end 时记成一步 ——

  private set(i: number, value: number) {
    const old = this.grid.cells[i]
    if (old === value) return
    if (!this.pending.has(i)) this.pending.set(i, old)
    this.grid.cells[i] = value
  }

  /** 结束这一笔，返回改了几格（0 格不记步）。 */
  end(): number {
    const changed = [...this.pending.entries()].filter(([i, before]) => this.grid.cells[i] !== before)
    this.pending.clear()
    if (!changed.length) return 0
    const index = Int32Array.from(changed.map(([i]) => i))
    this.record({
      index,
      before: Uint8Array.from(changed.map(([, b]) => b)),
      after: Uint8Array.from(index, (i) => this.grid.cells[i]),
    })
    return changed.length
  }

  private record(step: Step) {
    this.undoSteps.push(step)
    this.redoSteps.length = 0
    this.version++
  }

  undo() {
    const step = this.undoSteps.pop()
    if (!step) return false
    step.index.forEach((i, k) => (this.grid.cells[i] = step.before[k]))
    if (step.lock) step.lock.index.forEach((i, k) => (this.locked[i] = step.lock!.after[k] ? 0 : 1))
    this.redoSteps.push(step)
    this.version++
    return true
  }

  redo() {
    const step = this.redoSteps.pop()
    if (!step) return false
    step.index.forEach((i, k) => (this.grid.cells[i] = step.after[k]))
    if (step.lock) step.lock.index.forEach((i, k) => (this.locked[i] = step.lock!.after[k]))
    this.undoSteps.push(step)
    this.version++
    return true
  }

  /** 对称时同时画的几格（含自己）。 */
  mirrors(x: number, y: number, symmetry: Symmetry): [number, number][] {
    const { width: w, height: h } = this.grid
    const out: [number, number][] = [[x, y]]
    if (symmetry === 'horizontal' || symmetry === 'quad') out.push([w - 1 - x, y])
    if (symmetry === 'vertical' || symmetry === 'quad') out.push([x, h - 1 - y])
    if (symmetry === 'quad') out.push([w - 1 - x, h - 1 - y])
    return out
  }

  /** 画笔、橡皮：在这一笔里画一格（连同对称的格子）。拖动时两次触点之间用直线连上，不会断。 */
  paint(x: number, y: number, code: string | null, symmetry: Symmetry = 'none', from?: [number, number]) {
    const value = this.slot(code)
    const points = from ? linePoints(from[0], from[1], x, y) : [[x, y] as [number, number]]
    for (const [px, py] of points)
      for (const [mx, my] of this.mirrors(px, py, symmetry))
        if (this.inside(mx, my)) this.set(my * this.grid.width + mx, value)
  }

  /** 填充：和这一格同色（或同是空）、四连通的一片换成新颜色；锁住的格子挡住、不改。单独成一步。 */
  fill(x: number, y: number, code: string | null, symmetry: Symmetry = 'none') {
    const value = this.slot(code)
    const { width: w, height: h, cells } = this.grid
    for (const [mx, my] of this.mirrors(x, y, symmetry)) {
      const start = my * w + mx
      const from = cells[start]
      if (from === value || this.locked[start]) continue
      const stack = [start]
      const seen = new Uint8Array(cells.length)
      seen[start] = 1
      while (stack.length) {
        const i = stack.pop()!
        this.set(i, value)
        const cx = i % w,
          cy = (i / w) | 0
        for (const j of [cx > 0 ? i - 1 : -1, cx < w - 1 ? i + 1 : -1, cy > 0 ? i - w : -1, cy < h - 1 ? i + w : -1]) {
          if (j < 0 || seen[j] || cells[j] !== from || this.locked[j]) continue
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    return this.end()
  }

  /** 形状：直线、方框、圆（按拖出来的框画椭圆，框是正方形就是圆），空心或实心，连同对称。单独成一步。 */
  shape(
    kind: Shape,
    a: [number, number],
    b: [number, number],
    filled: boolean,
    code: string | null,
    symmetry: Symmetry = 'none',
  ) {
    const value = this.slot(code)
    for (const [px, py] of shapePoints(kind, a, b, filled))
      for (const [mx, my] of this.mirrors(px, py, symmetry))
        if (this.inside(mx, my)) this.set(my * this.grid.width + mx, value)
    return this.end()
  }

  /** 锁住或解开这些格子（框选后一起锁，或点一格切换）。也能撤销。 */
  lock(index: readonly number[], on: boolean) {
    const changed = index.filter((i) => (this.locked[i] === 1) !== on)
    if (!changed.length) return 0
    for (const i of changed) this.locked[i] = on ? 1 : 0
    this.record({
      index: new Int32Array(0),
      before: new Uint8Array(0),
      after: new Uint8Array(0),
      lock: { index: Int32Array.from(changed), after: new Uint8Array(changed.length).fill(on ? 1 : 0) },
    })
    return changed.length
  }

  // —— 整张图 ——

  /** 换色：整张图里这种颜色全换成另一种（或换成空），跳过锁住的格子。 */
  replace(from: string, to: string | null) {
    const src = this.grid.colors.indexOf(from)
    if (src < 0) return 0
    const value = this.slot(to)
    this.grid.cells.forEach((v, i) => {
      if (v === src && !this.locked[i]) this.set(i, value)
    })
    return this.end()
  }

  /** 一次换好几种颜色（清单上「店里没有的换成最接近的」），算一步，跳过锁住的格子。 */
  recolor(map: ReadonlyMap<string, string>) {
    const slots = new Map<number, number>()
    for (const [from, to] of map) {
      const i = this.grid.colors.indexOf(from)
      if (i >= 0) slots.set(i, this.slot(to))
    }
    this.grid.cells.forEach((v, i) => {
      const to = slots.get(v)
      if (to !== undefined && !this.locked[i]) this.set(i, to)
    })
    return this.end()
  }

  /** 加描边：有豆子的格子四邻里的空格子填成描边色（只描外面一圈，不描到图外）。 */
  outline(code: string) {
    const value = this.slot(code)
    const { width: w, height: h, cells } = this.grid
    const targets: number[] = []
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] !== EMPTY || this.locked[i]) continue
      const x = i % w,
        y = (i / w) | 0
      if (
        (x > 0 && cells[i - 1] !== EMPTY) ||
        (x < w - 1 && cells[i + 1] !== EMPTY) ||
        (y > 0 && cells[i - w] !== EMPTY) ||
        (y < h - 1 && cells[i + w] !== EMPTY)
      )
        targets.push(i)
    }
    for (const i of targets) this.set(i, value)
    return this.end()
  }

  /** 背景填色：所有空格子填一种颜色。 */
  background(code: string) {
    const value = this.slot(code)
    this.grid.cells.forEach((v, i) => {
      if (v === EMPTY && !this.locked[i]) this.set(i, value)
    })
    return this.end()
  }

  /** 去零星：和生成时同一套规则，跳过锁住的格子。 */
  cleanup(palette: Palette, minSize: number) {
    const out = cleanup(this.grid, palette, { minSize, locked: this.locked }).grid.cells
    out.forEach((v, i) => this.set(i, v))
    return this.end()
  }

  // —— 框选以后 ——

  /** 把框里的格子拿出来（不改图）。 */
  copy(r: Rect): Clip {
    const { width: w, cells } = this.grid
    const out = new Uint8Array(r.w * r.h)
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) out[y * r.w + x] = cells[(r.y + y) * w + r.x + x]
    return { w: r.w, h: r.h, cells: out }
  }

  private paste(clip: Clip, x0: number, y0: number) {
    for (let y = 0; y < clip.h; y++)
      for (let x = 0; x < clip.w; x++) {
        const v = clip.cells[y * clip.w + x]
        // 空格子当透明，不盖掉下面的豆子
        if (v === EMPTY || !this.inside(x0 + x, y0 + y)) continue
        this.set((y0 + y) * this.grid.width + x0 + x, v)
      }
  }

  private clear(r: Rect) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.set(y * this.grid.width + x, EMPTY)
  }

  /** 移动：框里的格子挪到 (dx, dy) 之外，原处变空，挪出图外的部分丢掉。返回挪过去的框。 */
  move(r: Rect, dx: number, dy: number): Rect {
    const clip = this.copy(r)
    this.clear(r)
    this.paste(clip, r.x + dx, r.y + dy)
    this.end()
    return clampRect({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, this.grid.width, this.grid.height)
  }

  /** 复制一份放到 (dx, dy) 之外，原处不变。 */
  duplicate(r: Rect, dx: number, dy: number): Rect {
    this.paste(this.copy(r), r.x + dx, r.y + dy)
    this.end()
    return clampRect({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, this.grid.width, this.grid.height)
  }

  /** 翻过来：框里左右翻（vertical 为真时上下翻）。 */
  flip(r: Rect, vertical = false) {
    const clip = this.copy(r)
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const v = vertical ? clip.cells[(r.h - 1 - y) * r.w + x] : clip.cells[y * r.w + r.w - 1 - x]
        this.set((r.y + y) * this.grid.width + r.x + x, v)
      }
    this.end()
    return r
  }

  /** 顺时针转 90°：转好的块左上角不动，宽高互换，出了图的部分丢掉。返回新的框。 */
  rotate(r: Rect): Rect {
    const clip = this.copy(r)
    const turned: Clip = { w: r.h, h: r.w, cells: new Uint8Array(clip.cells.length) }
    for (let y = 0; y < turned.h; y++)
      for (let x = 0; x < turned.w; x++) turned.cells[y * turned.w + x] = clip.cells[(r.h - 1 - x) * r.w + y]
    this.clear(r)
    for (let y = 0; y < turned.h; y++)
      for (let x = 0; x < turned.w; x++)
        if (this.inside(r.x + x, r.y + y))
          this.set((r.y + y) * this.grid.width + r.x + x, turned.cells[y * turned.w + x])
    this.end()
    return clampRect({ x: r.x, y: r.y, w: turned.w, h: turned.h }, this.grid.width, this.grid.height)
  }
}

export type Clip = { w: number; h: number; cells: Uint8Array }

/** 两个角拖出来的框（含两头），限在图里。 */
export function rectOf(a: [number, number], b: [number, number], width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(a[0], b[0])),
    y0 = Math.max(0, Math.min(a[1], b[1]))
  const x1 = Math.min(width - 1, Math.max(a[0], b[0])),
    y1 = Math.min(height - 1, Math.max(a[1], b[1]))
  return { x: x0, y: y0, w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) }
}

function clampRect(r: Rect, width: number, height: number): Rect {
  return rectOf([r.x, r.y], [r.x + r.w - 1, r.y + r.h - 1], width, height)
}

/** Bresenham 直线（含两头）。 */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = []
  const dx = Math.abs(x1 - x0),
    dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1
  let err = dx + dy,
    x = x0,
    y = y0
  for (;;) {
    out.push([x, y])
    if (x === x1 && y === y1) return out
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
}

/**
 * 形状上的格子。方框：框的四条边；圆：格子中心落在框的内切椭圆里的算在里面，空心时只留四邻有一格在外面的那圈
 * （拼的时候是一圈连着的豆子，不会缺口，也不会两格粗）。
 */
export function shapePoints(
  kind: Shape,
  a: [number, number],
  b: [number, number],
  filled: boolean,
): [number, number][] {
  if (kind === 'line') return linePoints(a[0], a[1], b[0], b[1])
  const x0 = Math.min(a[0], b[0]),
    x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1]),
    y1 = Math.max(a[1], b[1])
  const out: [number, number][] = []
  if (kind === 'rect') {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (filled || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y])
    return out
  }
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2
  const rx = (x1 - x0 + 1) / 2,
    ry = (y1 - y0 + 1) / 2
  const inside = (x: number, y: number) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1 && ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!inside(x, y)) continue
      if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) out.push([x, y])
    }
  return out
}
