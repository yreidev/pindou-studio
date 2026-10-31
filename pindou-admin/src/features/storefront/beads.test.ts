import { describe, expect, it } from 'vitest'
import type { BeadSettings } from '../../api/beads'
import {
  draftFrom,
  draftProblem,
  draftSummary,
  paletteById,
  paletteGroups,
  palettes,
  sameAsSaved,
  seriesOf,
  switchPalette,
  toInput,
} from './beads'

const saved = (over: Partial<BeadSettings> = {}): BeadSettings => ({
  palette: 'mard-221',
  available: null,
  boxes: {},
  boardSize: 52,
  beadSize: 'mini',
  revision: 0,
  updatedAt: null,
  ...over,
})

describe('色卡', () => {
  it('17 套：国内 6 套、国外 11 套', () => {
    expect(palettes).toHaveLength(17)
    expect(paletteGroups.map((g) => [g.label, g.options.length])).toEqual([
      ['国内', 6],
      ['国外', 11],
    ])
    expect(paletteById('mard-221')?.colors).toHaveLength(221)
  })

  it('按系列分页：字母开头的按字母，纯数字的每 50 个一组', () => {
    const mard = seriesOf(paletteById('mard-221')!)
    expect(mard[0]).toMatchObject({ key: 'A', name: 'A 系列' })
    expect(mard[0].codes).toHaveLength(26)
    expect(mard.flatMap((s) => s.codes)).toHaveLength(221)
    const panpan = seriesOf(paletteById('panpan-289')!)
    expect(panpan[0].name).toBe('第 1～50 个')
    expect(panpan.flatMap((s) => s.codes)).toHaveLength(paletteById('panpan-289')!.colors.length)
  })
})

describe('编辑与保存', () => {
  it('没设置过是整套都有；全有时存 null，去掉几种按色卡顺序存', () => {
    const d = draftFrom(saved())
    expect(d.available.size).toBe(221)
    expect(toInput(d, 0).available).toBeNull()
    d.available.delete('A3')
    d.available.delete('A1')
    const input = toInput(d, 0)
    expect(input.available).toHaveLength(219)
    expect(input.available?.slice(0, 2)).toEqual(['A2', 'A4'])
  })

  it('盒号去掉首尾空白，空的和别的色卡的色号不存', () => {
    const d = draftFrom(saved())
    d.boxes = { A1: ' 3 ', A2: '  ', ZZ9: '5' }
    expect(toInput(d, 4)).toMatchObject({ expectedRevision: 4, boxes: { A1: '3' } })
    expect(draftSummary(d)).toBe('店里有 221 / 221 种，填了 1 个盒号')
  })

  it('换色卡时店里有没有、盒号从头来', () => {
    const d = draftFrom(saved({ available: ['A1', 'A2'], boxes: { A1: '1' } }))
    const next = switchPalette(d, 'hama-midi-92')
    expect(next.available.size).toBe(92)
    expect(next.boxes).toEqual({})
    expect(next.boardSize).toBe(52)
  })

  it('不能保存的情况：颜色少于 2 种、底板超出范围、盒号太长', () => {
    expect(draftProblem(draftFrom(saved()))).toBeNull()
    expect(draftProblem({ ...draftFrom(saved()), available: new Set(['A1']) })).toBe('店里有的颜色至少要 2 种')
    expect(draftProblem({ ...draftFrom(saved()), boardSize: 9 })).toBe('底板一边 10～150 格')
    expect(draftProblem({ ...draftFrom(saved()), boardSize: Number.NaN })).toBe('底板一边 10～150 格')
    expect(draftProblem({ ...draftFrom(saved()), boxes: { A1: '一二三四五六七八九' } })).toBe(
      'A1 的盒号太长，最多 8 个字',
    )
    expect(draftProblem({ ...draftFrom(saved()), boxes: { A1: '一二三四五六七八' } })).toBeNull()
  })

  it('和存着的一样时不算改过', () => {
    const s = saved({ available: ['A1', 'A2'], boxes: { A1: '1' } })
    const d = draftFrom(s)
    expect(sameAsSaved(d, s)).toBe(true)
    d.boxes = { ...d.boxes, A1: ' 1 ' }
    expect(sameAsSaved(d, s)).toBe(true)
    expect(sameAsSaved({ ...d, beadSize: 'midi' }, s)).toBe(false)
  })
})
