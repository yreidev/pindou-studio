import { describe, expect, it } from 'vitest'
import type { BoardData, ServiceTable, ShiftTable, VenueSession } from '../../api/board'
import { planSeats } from './layout'
import { moveOption, moveTargets } from './move'

const now = Date.parse('2026-10-06T06:00:00Z')
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

const table = (code: string, extra: Partial<ServiceTable> = {}): ServiceTable => ({
  id: `t-${code}`,
  code,
  zone: code[0],
  floorAreaId: `area-${code[0]}`,
  number: Number(code.slice(1)),
  seatCount: code.startsWith('D') ? 2 : 1,
  wholeTable: code.startsWith('D'),
  enabled: true,
  occupancy: 'idle',
  seatBased: false,
  ...extra,
})
const session = (code: string, extra: Partial<VenueSession> = {}): VenueSession => ({
  id: `s-${code}`,
  serviceTableId: `t-${code}`,
  startedAt: at(-30),
  timingMode: 'timed',
  durationMinutes: 120,
  status: 'active',
  ...extra,
})
/** 当班视图的桌：按 /loyalty/shift 的规则，只有启用的桌，occupied 是被占的座号。 */
const shiftTable = (base: ServiceTable, occupiedSeats: number[] = []): ShiftTable => ({
  id: base.id,
  code: base.code,
  zone: base.zone,
  number: base.number,
  seatCount: base.seatCount,
  wholeTable: base.wholeTable,
  occupiedSeats,
  floorAreaId: base.floorAreaId,
  floorAreaName: `${base.zone} 区`,
})

/** A2 整桌开台（快到点）、A3 暂停、B2 停用、D1 有人（整桌单位占满两座），其余空闲。 */
function board(): Pick<BoardData, 'tables' | 'sessions' | 'shiftTables'> {
  const tables = planSeats.map((seat) => table(seat.code))
  const set = (code: string, extra: Partial<ServiceTable>) =>
    Object.assign(
      tables.find((t) => t.code === code)!,
      extra,
    )
  set('A1', { occupancy: 'occupied', seatBased: true, timingStatus: 'running' })
  set('A2', { occupancy: 'occupied', timingStatus: 'expiring' })
  set('A3', { occupancy: 'occupied', timingStatus: 'running' })
  set('B2', { enabled: false })
  set('D1', { occupancy: 'occupied', timingStatus: 'running' })
  const sessions = [
    session('A1', { admissionId: 'a-A1', seatNumber: 1 }),
    session('A2'),
    session('A3', { status: 'paused' }),
    session('D1'),
  ]
  const occupied: Record<string, number[]> = { A1: [1], A2: [1], A3: [1], D1: [1, 2] }
  return {
    tables,
    sessions,
    shiftTables: tables.filter((t) => t.enabled).map((t) => shiftTable(t, occupied[t.code])),
  }
}

const pick = (targets: ReturnType<typeof moveTargets>, place: string) => targets.find((t) => t.place === place)

describe('换桌（整桌会话）', () => {
  it('同小程序会话页：只能换到启用、空闲、不是现在这张的桌；不能选的写明原因', () => {
    const data = board()
    const targets = moveTargets(data, session('A2'))
    expect(targets.map((t) => t.place.split(' ')[0])).toEqual(planSeats.map((seat) => seat.code))
    expect(pick(targets, 'A2')).toMatchObject({ blocked: '当前所在' })
    expect(pick(targets, 'A1')).toMatchObject({ blocked: '使用中' })
    expect(pick(targets, 'A3')).toMatchObject({ blocked: '暂停' })
    expect(pick(targets, 'B2')).toMatchObject({ blocked: '停用' })
    expect(pick(targets, 'D1 · 整桌')).toMatchObject({ blocked: '使用中' })
    // 能选的：整张桌换过去，没有座号
    expect(pick(targets, 'B4')).toEqual({ value: 't-B4', serviceTableId: 't-B4', place: 'B4', blocked: undefined })
    expect(pick(targets, 'D2 · 整桌')).toMatchObject({ serviceTableId: 't-D2', blocked: undefined })
    expect(targets.every((t) => t.seatNumber === undefined)).toBe(true)
    const free = targets.filter((t) => !t.blocked).map((t) => t.serviceTableId)
    expect(free).toEqual(
      data.tables.filter((t) => t.enabled && t.occupancy === 'idle' && t.id !== 't-A2').map((t) => t.id),
    )
  })

  it('布局里有、接口里没有的桌：写「桌位待核对」，不能选', () => {
    const data = board()
    data.tables = data.tables.filter((t) => t.code !== 'C3')
    expect(pick(moveTargets(data, session('A2')), 'C3')).toMatchObject({ blocked: '桌位待核对', serviceTableId: '' })
  })
})

describe('换座（按座会话）', () => {
  it('同小程序「会员与计时」：按当班视图的占用列每个空座号，双人桌分座列', () => {
    const data = board()
    const targets = moveTargets(data, session('A1', { admissionId: 'a-A1', seatNumber: 1 }))
    expect(pick(targets, 'A1')).toMatchObject({ blocked: '当前座位' })
    expect(pick(targets, 'A2')).toMatchObject({ blocked: '快到点' })
    expect(pick(targets, 'B2')).toMatchObject({ blocked: '停用' })
    // 整桌单位有人：两个座都算占用
    expect(pick(targets, 'D1 · 1 号座')).toMatchObject({ blocked: '使用中' })
    expect(pick(targets, 'D1 · 2 号座')).toMatchObject({ blocked: '使用中' })
    expect(pick(targets, 'D2 · 2 号座')).toEqual({
      value: 't-D2#2',
      serviceTableId: 't-D2',
      seatNumber: 2,
      place: 'D2 · 2 号座',
      blocked: undefined,
    })
    expect(pick(targets, 'B4')).toMatchObject({ seatNumber: 1, blocked: undefined })
    // 能选的正是小程序 availableSeats 那一串
    const free = targets.filter((t) => !t.blocked).map((t) => t.value)
    const expected = data.shiftTables.flatMap((t) =>
      Array.from({ length: t.seatCount }, (_, i) => i + 1)
        .filter((n) => !t.occupiedSeats.includes(n))
        .map((n) => `${t.id}#${n}`),
    )
    expect(free.sort()).toEqual(expected.sort())
  })

  it('当班视图里没有的桌（刚启用、还没读到占用）先不让选；接口说空闲、当班说占用时写「有人」', () => {
    const data = board()
    data.shiftTables = data.shiftTables.filter((t) => t.code !== 'C1')
    data.shiftTables.find((t) => t.code === 'C2')!.occupiedSeats = [1]
    const targets = moveTargets(data, session('A1', { admissionId: 'a-A1', seatNumber: 1 }))
    expect(pick(targets, 'C1')).toMatchObject({ blocked: '桌位待核对' })
    expect(pick(targets, 'C2')).toMatchObject({ blocked: '有人' })
  })
})

describe('下拉框选项', () => {
  it('不能选的灰着，后面写原因；能选的只写位置', () => {
    expect(moveOption({ value: 't-A2', serviceTableId: 't-A2', place: 'A2', blocked: '使用中' })).toEqual({
      value: 't-A2',
      label: 'A2 · 使用中',
      disabled: true,
    })
    expect(moveOption({ value: 't-D2#2', serviceTableId: 't-D2', seatNumber: 2, place: 'D2 · 2 号座' })).toEqual({
      value: 't-D2#2',
      label: 'D2 · 2 号座',
      disabled: false,
    })
  })

  it('选项名字不重复（Semi 的下拉框要求 label 唯一）', () => {
    const data = board()
    for (const target of [session('A2'), session('A1', { admissionId: 'a-A1', seatNumber: 1 })]) {
      const labels = moveTargets(data, target).map((t) => moveOption(t).label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})
