import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { GridCanvas, MakerCanvas, type CellEvent } from '../../../components/maker/canvas'
import { ColorSheet, Sheet, Stepper } from '../../../components/maker/sheets'
import type { BeadSettings } from '../../../services/maker/api'
import {
  Editor,
  rectOf,
  shapePoints,
  symmetryNames,
  TooManyColors,
  type Rect,
  type Shape,
  type Symmetry,
} from '../../../services/maker/edit'
import { strayMinSize } from '../../../services/maker/cleanup'
import { beadCounts, colorCounts, EMPTY } from '../../../services/maker/grid'
import { resize } from '../../../services/maker/image'
import type { Palette } from '../../../services/maker/palettes'
import { session } from '../../../services/maker/session'
import type { Draft } from '../../../services/maker/store'

// 改图（画稿 MEdit、MEditMore）：一屏放下。画布下面一行撤销、重做、对照原图，再下面色块条和一排「画笔、橡皮、填充、取色、更多」；
// 框选、形状、对称、锁住格子和整张图的操作在「更多」里，选了框选、形状、锁住格子时「更多」那格写着现在用的是哪个。

type Tool = 'brush' | 'eraser' | 'fill' | 'picker' | 'select' | 'shape' | 'lock'
const tools: { key: Tool | 'more'; label: string }[] = [
  { key: 'brush', label: '画笔' },
  { key: 'eraser', label: '橡皮' },
  { key: 'fill', label: '填充' },
  { key: 'picker', label: '取色' },
  { key: 'more', label: '更多' },
]
const shapeNames: Record<Shape, string> = { line: '直线', rect: '方框', ellipse: '圆' }
/** 收在「更多」里的工具：选中时「更多」那格写它的名字 */
const moreToolName = (tool: Tool, shape: Shape) =>
  tool === 'select' ? '框选' : tool === 'shape' ? `形状·${shapeNames[shape]}` : tool === 'lock' ? '锁住格子' : undefined

type Props = {
  draft: Draft
  editor: Editor
  palette: Palette
  store?: BeadSettings | null
  version: number
  onChange: () => void
  syncLine: string
  inAccount: boolean
  onSave: () => void
  /** 页面上别的东西变了、画布高度跟着变（别处改过的横幅） */
  layout: string
}

export function EditTab({
  draft,
  editor,
  palette,
  store,
  version,
  onChange,
  syncLine,
  inAccount,
  onSave,
  layout,
}: Props) {
  const g = editor.grid
  const [tool, setTool] = useState<Tool>('brush')
  const [code, setCode] = useState<string>(() => colorCounts(g)[0]?.code ?? palette.colors[0].code)
  const [symmetry, setSymmetry] = useState<Symmetry>('none')
  const [shape, setShape] = useState<Shape>('line')
  const [filled, setFilled] = useState(false)
  const [selection, setSelection] = useState<Rect>()
  const [moveMode, setMoveMode] = useState<'move' | 'duplicate'>('move')
  const [compare, setCompare] = useState(false)
  const [sheet, setSheet] = useState<'none' | 'colors' | 'more' | 'replace'>('none')
  // 去零星：几颗及以下算零星（页面上的数，换成 cleanup 的 minSize 见 strayMinSize）
  const [strays, setStrays] = useState(2)
  const [preview, setPreview] = useState<number[]>([])
  // 正在拖的这一下：手指动得比页面重新渲染快，放在 ref 里
  const dragRef = useRef<{
    start: [number, number]
    last: [number, number]
    moving: boolean
    lockOn?: boolean
    locks?: Set<number>
  }>()
  const available = store && store.palette === palette.id && store.available ? new Set(store.available) : undefined
  // 格子是就地改的，version 变了才重算
  const counts = useMemo(() => colorCounts(g), [g, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const reference = session.reference?.id === draft.id ? session.reference.pixels : undefined

  const guard = <T,>(run: () => T): T | undefined => {
    try {
      const n = run()
      onChange()
      return n
    } catch (error) {
      if (error instanceof TooManyColors) void Taro.showToast({ title: error.message, icon: 'none' })
      else throw error
    }
  }
  const mirrored = (cells: [number, number][]) => {
    const out: number[] = []
    for (const [x, y] of cells)
      for (const [mx, my] of editor.mirrors(x, y, symmetry)) if (editor.inside(mx, my)) out.push(my * g.width + mx)
    return out
  }

  const onCell = (event: CellEvent, cell: [number, number]) => {
    const drag = dragRef.current
    const setDragValue = (value: typeof drag) => (dragRef.current = value)
    if (event === 'cancel') {
      editor.end()
      setDragValue(undefined)
      setPreview([])
      onChange()
      return
    }
    const [x, y] = cell
    if (tool === 'brush' || tool === 'eraser') {
      const value = tool === 'eraser' ? null : code
      if (event === 'start') {
        guard(() => editor.paint(x, y, value, symmetry))
        setDragValue({ start: cell, last: cell, moving: false })
      } else if (event === 'move' && drag) {
        guard(() => editor.paint(x, y, value, symmetry, drag.last))
        setDragValue({ ...drag, last: cell })
      } else if (event === 'end') {
        editor.end()
        setDragValue(undefined)
        onChange()
      }
      return
    }
    if (tool === 'fill' || tool === 'picker') {
      if (event !== 'end') return
      if (tool === 'fill') guard(() => editor.fill(x, y, code, symmetry))
      else {
        const picked = editor.pick(x, y)
        if (picked) {
          setCode(picked)
          setTool('brush')
        } else void Taro.showToast({ title: '这一格是空的', icon: 'none' })
      }
      return
    }
    if (tool === 'shape') {
      if (event === 'start') setDragValue({ start: cell, last: cell, moving: false })
      if (!drag && event !== 'start') return
      const start = event === 'start' ? cell : drag!.start
      if (event === 'end') {
        guard(() => editor.shape(shape, start, cell, filled, code, symmetry))
        setDragValue(undefined)
        setPreview([])
        return
      }
      setDragValue({ start, last: cell, moving: false })
      setPreview(mirrored(shapePoints(shape, start, cell, filled)))
      return
    }
    if (tool === 'lock') {
      const i = y * g.width + x
      if (event === 'start') {
        setDragValue({ start: cell, last: cell, moving: false, lockOn: !editor.locked[i], locks: new Set([i]) })
        return
      }
      if (!drag?.locks) return
      drag.locks.add(i)
      if (event === 'end') {
        editor.lock([...drag.locks], drag.lockOn!)
        setDragValue(undefined)
        setPreview([])
        onChange()
      } else setPreview([...drag.locks])
      return
    }
    // 框选：在选区里按下是挪（或复制），否则重新框
    if (event === 'start') {
      const inside =
        selection &&
        x >= selection.x &&
        x < selection.x + selection.w &&
        y >= selection.y &&
        y < selection.y + selection.h
      setDragValue({ start: cell, last: cell, moving: !!inside })
      if (!inside) setSelection(rectOf(cell, cell, g.width, g.height))
      return
    }
    if (!drag) return
    if (drag.moving && selection) {
      const dx = x - drag.start[0],
        dy = y - drag.start[1]
      if (event === 'end') {
        if (dx || dy)
          setSelection(moveMode === 'move' ? editor.move(selection, dx, dy) : editor.duplicate(selection, dx, dy))
        setDragValue(undefined)
        setPreview([])
        onChange()
        return
      }
      setDragValue({ ...drag, last: cell })
      const cells: number[] = []
      for (let yy = 0; yy < selection.h; yy++)
        for (let xx = 0; xx < selection.w; xx++) {
          const tx = selection.x + xx + dx,
            ty = selection.y + yy + dy
          if (editor.inside(tx, ty) && g.cells[(selection.y + yy) * g.width + selection.x + xx] !== EMPTY)
            cells.push(ty * g.width + tx)
        }
      setPreview(cells)
      return
    }
    setSelection(rectOf(drag.start, cell, g.width, g.height))
    if (event === 'end') setDragValue(undefined)
    else setDragValue({ ...drag, last: cell })
  }

  const pick = (key: Tool | 'more') => {
    if (key === 'more') return setSheet('more')
    setTool(key)
    if (key !== 'select') setSelection(undefined)
  }
  /** 「更多」里选了一个工具：换过去、关掉弹层，框选和锁住格子说一句怎么用 */
  const pickMore = (key: Tool, tip?: string) => {
    pick(key)
    setSheet('none')
    if (tip) void Taro.showToast({ title: tip, icon: 'none', duration: 2500 })
  }
  const moreName = moreToolName(tool, shape)

  const beads = beadCounts(g).beads
  return (
    <View className="maker-edit">
      <View className="maker-canvas-wrap maker-canvas-fill">
        <GridCanvas
          id="maker-edit-canvas"
          className="maker-grid-canvas"
          grid={g}
          palette={palette}
          version={`${version}:${editor.version}:${preview.join(',').length}:${preview.length}:${JSON.stringify(selection)}`}
          options={{
            background: '#f7f5f0',
            emptyColor: '#ffffff',
            gridColor: '#e4ddcf',
            locked: editor.locked,
            preview: preview.length
              ? {
                  cells: preview,
                  color: tool === 'lock' ? '#706b62' : palette.colors[palette.index.get(code) ?? 0].hex,
                }
              : undefined,
            selection,
          }}
          mode="draw"
          onCell={onCell}
          layout={layout}
        />
        {compare && reference && <ReferenceInset pixels={reference} />}
      </View>
      <View className="maker-edit-bar">
        <Button className="maker-action" disabled={!editor.canUndo} onClick={() => editor.undo() && onChange()}>
          撤销
        </Button>
        <Button className="maker-action" disabled={!editor.canRedo} onClick={() => editor.redo() && onChange()}>
          重做
        </Button>
        <Button
          className={`maker-action ${compare ? 'maker-tool-selected' : ''}`}
          ariaLabel={`对照原图${compare ? '，已打开' : ''}`}
          onClick={() => {
            if (!reference) void Taro.showToast({ title: '原图只在刚做好时有（照片不存）', icon: 'none' })
            else setCompare((c) => !c)
          }}
        >
          原图
        </Button>
        <Text className="maker-meta">
          {symmetry !== 'none' ? `对称·${symmetryNames[symmetry]} · ` : ''}
          {g.width}×{g.height} 格 · {counts.length} 色 · {beads} 颗
        </Text>
      </View>
      <View className="maker-palette-strip">
        {counts.map((c) => {
          const hex = palette.colors[palette.index.get(c.code) ?? 0].hex
          return (
            <Button
              key={c.code}
              className={`maker-swatch ${c.code === code && tool !== 'eraser' ? 'maker-swatch-selected' : ''}`}
              ariaLabel={`${c.code}，${c.count} 颗`}
              onClick={() => {
                setCode(c.code)
                if (tool === 'eraser' || tool === 'picker' || tool === 'lock') setTool('brush')
              }}
            >
              <View className="maker-swatch-color" style={{ background: hex }} />
              <Text className="maker-swatch-code">{c.code}</Text>
            </Button>
          )
        })}
        {!counts.some((c) => c.code === code) && (
          <Button className="maker-swatch maker-swatch-selected" onClick={() => setSheet('colors')}>
            <View
              className="maker-swatch-color"
              style={{ background: palette.colors[palette.index.get(code) ?? 0].hex }}
            />
            <Text className="maker-swatch-code">{code}</Text>
          </Button>
        )}
        <Button className="maker-swatch maker-swatch-add" ariaLabel="换别的颜色" onClick={() => setSheet('colors')}>
          +
        </Button>
      </View>
      <View className="maker-tools">
        {tools.map((t) => (
          <Button
            key={t.key}
            className={`maker-tool ${t.key === tool || (t.key === 'more' && moreName) ? 'maker-tool-selected' : ''}`}
            ariaLabel={t.key === 'more' && moreName ? `更多，现在用的是${moreName}` : undefined}
            onClick={() => pick(t.key)}
          >
            {t.key === 'more' && moreName ? moreName : t.label}
          </Button>
        ))}
      </View>
      {!inAccount && (
        <View className="maker-bottom">
          <Button className="button button-primary" onClick={onSave}>
            存到我的图纸
          </Button>
        </View>
      )}
      <Text className="maker-note maker-center maker-sync">{syncLine}</Text>
      {sheet === 'colors' && (
        <ColorSheet
          paletteId={palette.id}
          current={code}
          available={available}
          onClose={() => setSheet('none')}
          onPick={(c) => {
            setCode(c)
            if (tool === 'eraser' || tool === 'picker' || tool === 'lock') setTool('brush')
            setSheet('none')
          }}
        />
      )}
      {sheet === 'replace' && (
        <ColorSheet
          paletteId={palette.id}
          title={`把 ${code} 换成`}
          available={available}
          onClose={() => setSheet('none')}
          onPick={(to) => {
            const n = guard(() => editor.replace(code, to))
            setCode(to)
            setSheet('none')
            void Taro.showToast({ title: n ? `换了 ${n} 颗` : '没有要换的', icon: 'none' })
          }}
        />
      )}
      {sheet === 'more' && (
        <Sheet title="更多" onClose={() => setSheet('none')}>
          <Text className="maker-sheet-label">工具</Text>
          <View className="maker-chips">
            <Button
              className={`maker-chip ${tool === 'select' ? 'maker-chip-selected' : ''}`}
              onClick={() => pickMore('select', '单指框一块；框里按住拖动是挪')}
            >
              框选
            </Button>
            <Button
              className={`maker-chip ${tool === 'lock' ? 'maker-chip-selected' : ''}`}
              onClick={() => pickMore('lock', '点或拖过格子锁住，再点一次解开')}
            >
              锁住格子
            </Button>
          </View>
          <Text className="maker-sheet-label">对称（画一格，镜像的格子一起画）</Text>
          <View className="maker-chips">
            {(Object.keys(symmetryNames) as Symmetry[]).map((s) => (
              <Button
                key={s}
                className={`maker-chip ${symmetry === s ? 'maker-chip-selected' : ''}`}
                onClick={() => setSymmetry(s)}
              >
                {symmetryNames[s]}
              </Button>
            ))}
          </View>
          <Text className="maker-sheet-label">画形状</Text>
          <View className="maker-chips">
            {(Object.keys(shapeNames) as Shape[]).map((s) => (
              <Button
                key={s}
                className={`maker-chip ${tool === 'shape' && shape === s ? 'maker-chip-selected' : ''}`}
                onClick={() => {
                  setShape(s)
                  setTool('shape')
                }}
              >
                {shapeNames[s]}
              </Button>
            ))}
            <Button
              className={`maker-chip ${filled ? 'maker-chip-selected' : ''}`}
              onClick={() => setFilled((f) => !f)}
            >
              {filled ? '实心' : '空心'}
            </Button>
          </View>
          <Text className="maker-sheet-label">
            框选以后{selection ? `（${selection.w}×${selection.h} 格）` : '（先用「框选」框一块）'}
          </Text>
          <View className="maker-chips">
            <Button
              className={`maker-chip ${tool === 'select' && moveMode === 'move' ? 'maker-chip-selected' : ''}`}
              onClick={() => {
                setMoveMode('move')
                setTool('select')
                setSheet('none')
              }}
            >
              移动
            </Button>
            <Button
              className={`maker-chip ${tool === 'select' && moveMode === 'duplicate' ? 'maker-chip-selected' : ''}`}
              onClick={() => {
                setMoveMode('duplicate')
                setTool('select')
                setSheet('none')
              }}
            >
              复制一份
            </Button>
            <Button
              className="maker-chip"
              disabled={!selection}
              onClick={() => {
                if (selection) guard(() => editor.flip(selection))
              }}
            >
              翻过来
            </Button>
            <Button
              className="maker-chip"
              disabled={!selection}
              onClick={() => {
                if (selection) setSelection(guard(() => editor.rotate(selection)) as Rect)
              }}
            >
              转 90°
            </Button>
          </View>
          <Text className="maker-sheet-label">整张图（锁住的格子不改）</Text>
          <View className="maker-chips">
            <Button className="maker-chip" onClick={() => setSheet('replace')}>
              {`换色（${code}）`}
            </Button>
            <Button
              className="maker-chip"
              onClick={() => {
                const n = guard(() => editor.outline(code))
                void Taro.showToast({ title: n ? `用 ${code} 描了 ${n} 颗` : '没有能描的边', icon: 'none' })
              }}
            >
              {`加描边（${code}）`}
            </Button>
            <Button
              className="maker-chip"
              onClick={() => {
                const n = guard(() => editor.background(code))
                void Taro.showToast({ title: n ? `空格子填了 ${n} 颗` : '没有空格子', icon: 'none' })
              }}
            >
              {`背景填色（${code}）`}
            </Button>
          </View>
          <View className="maker-cut-row">
            <View className="maker-cut-copy">
              <Text className="maker-strong">去零星</Text>
              <Text className="maker-note">被一种颜色围着、不超过几颗的并进周围</Text>
            </View>
            <Stepper label="去零星" value={strays} min={1} max={9} onChange={setStrays} />
            <Button
              className="maker-action"
              onClick={() => {
                const n = guard(() => editor.cleanup(palette, strayMinSize(strays)))
                void Taro.showToast({ title: n ? `并掉 ${n} 颗` : '没有零星的', icon: 'none' })
              }}
            >
              去掉
            </Button>
          </View>
          <Text className="maker-note">
            锁住的格子带小锁：去零星、换色、整片填充都不改它。用「锁住格子」点或拖过格子，再点一次解开。
          </Text>
        </Sheet>
      )}
    </View>
  )
}

/** 对照原图：右上角一小块，显示做这张图纸用的照片（调整好的）。 */
function ReferenceInset({ pixels }: { pixels: { width: number; height: number; data: Uint8ClampedArray } }) {
  return (
    <View className="maker-reference">
      <MakerCanvas
        id="maker-reference-canvas"
        className="maker-reference-canvas"
        version={pixels}
        draw={(ctx, width, height, ratio) => {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, width, height)
          const k = Math.min(width / pixels.width, height / pixels.height)
          const w = Math.max(1, Math.round(pixels.width * k * ratio)),
            h = Math.max(1, Math.round(pixels.height * k * ratio))
          const small = resize(pixels, w, h)
          const data = ctx.createImageData(w, h)
          data.data.set(small.data)
          ctx.putImageData(
            data,
            Math.round(((width - w / ratio) / 2) * ratio),
            Math.round(((height - h / ratio) / 2) * ratio),
          )
        }}
      />
    </View>
  )
}
