import { Text, View } from '@tarojs/components'
import { useDidHide, useDidShow } from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../../components/button'
import { GridCanvas } from '../../../components/maker/canvas'
import { Sheet } from '../../../components/maker/sheets'
import type { BeadSettings } from '../../../services/maker/api'
import {
  boardColors,
  boards,
  markColor,
  markRow,
  nextRow,
  progress,
  rowDone,
  rowRuns,
} from '../../../services/maker/boards'
import { keepScreenOn } from '../../../services/maker/device'
import { beadCounts, EMPTY, isDone, setDone } from '../../../services/maker/grid'
import type { Palette } from '../../../services/maker/palettes'
import type { Draft } from '../../../services/maker/store'
import { boardChoices } from './list-tab'

// 边拼边看（画稿 MBead、MBeadRow）：深色界面、屏幕常亮，一屏放下（画布占掉剩下的高度）。
// 按颜色看：按底板一块一块看，选一种颜色只亮这一种，点格子标记拼完、再点取消，「这一块的这个颜色都拼完了」一键标完。
// 按行看：一行一行亮，写着这一行从左到右「A6 5 颗、G8 2 颗……」（这块能收起，把地方让给画布），「拼完了，下一行」。
// 底板几格和怎么用的说明在右上角「52 格板」的弹层里。

type Props = {
  draft: Draft
  palette: Palette
  store?: BeadSettings | null
  version: number
  onChange: () => void
  inAccount: boolean
  /** 页面上别的东西变了、画布高度跟着变（别处改过的横幅） */
  layout: string
}

const place = ['左上', '右上', '左下', '右下']

export function BeadTab({ draft, palette, store, version, onChange, inAccount, layout }: Props) {
  const g = draft.grid
  const [mode, setMode] = useState<'color' | 'row'>('color')
  const [boardSize, setBoardSize] = useState(store?.boardSize ?? 52)
  const list = useMemo(() => boards(g, boardSize), [g, boardSize])
  const [boardIndex, setBoardIndex] = useState(0)
  const board = list[Math.min(boardIndex, list.length - 1)]
  const [color, setColor] = useState<number>()
  const [row, setRow] = useState(() => Math.max(0, nextRow(g, draft.done, 0)))
  const [runsOpen, setRunsOpen] = useState(true)
  const [boardSheet, setBoardSheet] = useState(false)

  useEffect(() => {
    void keepScreenOn(true)
    return () => void keepScreenOn(false)
  }, [])
  useDidShow(() => void keepScreenOn(true))
  useDidHide(() => void keepScreenOn(false))

  // 拼完的格子是就地改的，version 变了才重算
  const colors = useMemo(() => boardColors(g, draft.done, board), [g, board, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const all = beadCounts(g, draft.done)
  const here = colors.reduce((n, c) => ({ count: n.count + c.count, done: n.done + c.done }), { count: 0, done: 0 })
  const where = list.length === 4 ? place[board.index] : `第 ${board.row + 1} 排第 ${board.col + 1} 块`
  const runs = rowRuns(g, row)
  const hex = (c: number) => palette.colors[palette.index.get(g.colors[c]) ?? 0].hex

  return (
    <View className="maker-bead">
      <View className="maker-bead-head">
        <View className="maker-segment maker-segment-dark">
          <Button
            className={`maker-segment-item ${mode === 'color' ? 'maker-segment-selected' : ''}`}
            onClick={() => setMode('color')}
          >
            按颜色看
          </Button>
          <Button
            className={`maker-segment-item ${mode === 'row' ? 'maker-segment-selected' : ''}`}
            onClick={() => setMode('row')}
          >
            按行看
          </Button>
        </View>
        <Button
          className="maker-bead-board"
          ariaLabel={`${boardSize} 格板，换底板`}
          onClick={() => setBoardSheet(true)}
        >
          {`${boardSize} 格板 ▾`}
        </Button>
      </View>
      {mode === 'color' && list.length > 1 && (
        <View className="maker-board-chips">
          {list.map((b) => (
            <Button
              key={b.index}
              className={`maker-chip maker-chip-dark ${b.index === board.index ? 'maker-chip-selected' : ''}`}
              onClick={() => setBoardIndex(b.index)}
            >
              {String(b.index + 1)}
            </Button>
          ))}
        </View>
      )}
      <Text className="maker-dark-line maker-bead-line">
        {mode === 'color'
          ? `${list.length > 1 ? `第 ${board.index + 1} 块 · ${where}，共 ${list.length} 块` : '整张'} · 这一块拼了 ${progress(here.count, here.done)}%`
          : `第 ${row + 1} 行 / 共 ${g.height} 行${rowDone(g, draft.done, row) ? ' · 这一行拼完了' : ''}`}
      </Text>
      <View className="maker-canvas-wrap maker-canvas-dark maker-canvas-fill">
        <GridCanvas
          id="maker-bead-canvas"
          className="maker-grid-canvas"
          grid={g}
          palette={palette}
          version={`${version}:${mode}:${board.index}:${color}:${row}:${boardSize}`}
          options={{
            background: '#22211d',
            emptyColor: '#2d2b26',
            gridColor: '#3a3833',
            highlight: mode === 'color' ? color : undefined,
            board: mode === 'color' && list.length > 1 ? board : undefined,
            row: mode === 'row' ? row : undefined,
            done: draft.done,
            codes: true,
          }}
          mode="pan"
          onTap={([x, y]) => {
            const i = y * g.width + x
            const c = g.cells[i]
            if (
              c === EMPTY ||
              (mode === 'color' && color !== undefined && c !== color) ||
              (mode === 'row' && y !== row)
            )
              return
            setDone(draft.done, i, !isDone(draft.done, i))
            onChange()
          }}
          layout={`${layout}:${mode}:${runsOpen}:${list.length > 1}`}
        />
      </View>
      {mode === 'color' ? (
        <>
          <View className="maker-palette-strip">
            <Button
              className={`maker-swatch maker-swatch-dark ${color === undefined ? 'maker-swatch-selected' : ''}`}
              onClick={() => setColor(undefined)}
            >
              <Text className="maker-swatch-code">全部</Text>
            </Button>
            {colors.map((c) => (
              <Button
                key={c.code}
                className={`maker-swatch maker-swatch-dark ${color === c.index ? 'maker-swatch-selected' : ''}`}
                ariaLabel={`${c.code}，还剩 ${c.count - c.done} 颗`}
                onClick={() => setColor(c.index)}
              >
                <View className="maker-swatch-color" style={{ background: hex(c.index) }} />
                <Text className="maker-swatch-code">{c.code}</Text>
                <Text className="maker-swatch-left">{c.count - c.done}</Text>
              </Button>
            ))}
          </View>
          {/* 选没选颜色这一行一样高，画布不跟着跳 */}
          <View className="maker-bead-action">
            {color !== undefined ? (
              <Button
                className="button button-primary"
                onClick={() => {
                  markColor(g, draft.done, board, color, true)
                  onChange()
                }}
              >
                {`这一块的 ${g.colors[color]} 都拼完了`}
              </Button>
            ) : (
              <Text className="maker-dark-note">选一种颜色只亮这一种；点格子标记拼完，再点取消</Text>
            )}
          </View>
        </>
      ) : (
        <>
          <View className={`maker-runs ${runsOpen ? '' : 'maker-runs-closed'}`}>
            <Button
              className="maker-runs-head"
              ariaLabel={`这一行从左到右，${runsOpen ? '收起' : '展开'}`}
              onClick={() => setRunsOpen((o) => !o)}
            >
              <Text>这一行从左到右</Text>
              <Text>{runsOpen ? '收起' : '展开'}</Text>
            </Button>
            {runsOpen && (
              <View className="maker-run-list">
                {runs.map((r) => (
                  <View key={r.start} className="maker-run">
                    {r.color === EMPTY ? (
                      <Text className="maker-run-text">空 {r.count} 格</Text>
                    ) : (
                      <>
                        <View className="maker-run-swatch" style={{ background: hex(r.color) }} />
                        <Text className="maker-run-text">
                          {g.colors[r.color]} {r.count} 颗
                        </Text>
                      </>
                    )}
                  </View>
                ))}
                {!runs.length && <Text className="maker-run-text">这一行没有豆子</Text>}
              </View>
            )}
          </View>
          <View className="maker-bottom maker-bottom-pair">
            <Button
              className="maker-action maker-action-dark"
              disabled={row === 0}
              onClick={() => setRow((r) => Math.max(0, r - 1))}
            >
              上一行
            </Button>
            <Button
              className="button button-primary"
              onClick={() => {
                markRow(g, draft.done, row, true)
                onChange()
                const next = nextRow(g, draft.done, row + 1)
                setRow(next < 0 ? Math.min(g.height - 1, row + 1) : next)
              }}
            >
              拼完了，下一行
            </Button>
          </View>
        </>
      )}
      <View className="maker-progress">
        <Text className="maker-dark-line">
          整张 {progress(all.beads, all.done)}% · {all.done} / {all.beads} 颗
        </Text>
        {!inAccount && <Text className="maker-dark-note">只存在这台手机上</Text>}
      </View>
      {boardSheet && (
        <Sheet title="底板几格" note="按底板一块一块看，换了从第一块开始" onClose={() => setBoardSheet(false)}>
          <View className="maker-chips">
            {boardChoices(store).map((b) => (
              <Button
                key={b}
                className={`maker-chip ${b === boardSize ? 'maker-chip-selected' : ''}`}
                onClick={() => {
                  setBoardSize(b)
                  setBoardIndex(0)
                  setBoardSheet(false)
                }}
              >
                {`${b} 格板`}
              </Button>
            ))}
          </View>
          <Text className="maker-note maker-sheet-tip">点格子标记拼完，再点取消；圆点是拼完的。拼的时候屏幕常亮。</Text>
          <Text className="maker-note">
            {inAccount
              ? '进度自动存在账户里，下次在家、在店里打开接着拼。'
              : '进度存在这台手机上；在「改图」里存到「我的图纸」以后，换手机、到店里也能接着拼。'}
          </Text>
        </Sheet>
      )}
    </View>
  )
}
