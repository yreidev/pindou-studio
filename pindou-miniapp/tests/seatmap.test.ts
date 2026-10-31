import assert from 'node:assert/strict'
import { test } from 'vitest'
import layout from '../../layout/store-layout.json'
import * as seatmap from '../src/services/seatmap'

// ★ seatmap.ts 直接 import 布局文件（唯一真相），测的就是真实数据。

// 门店真实桌位：布局是什么样，库里就是什么样（后端 ReconcileLayout 保证）。
function storeTables(overrides: Record<string, Record<string, unknown>> = {}): any[] {
  return layout.tables.map((table) => ({
    id: `db-${table.code}`,
    code: table.code,
    zone: table.zone,
    number: table.number,
    seatCount: table.seatCount,
    wholeTable: table.wholeTable,
    occupiedSeats: [],
    floorAreaId: `area-${table.zone.toLowerCase()}`,
    floorAreaName: `${table.zone} 区`,
    ...(overrides[table.code] || {}),
  }))
}

test('every plan seat maps to the store table with the same code', () => {
  const result = seatmap.mapSeats(storeTables())
  assert.equal(result.seats.filter((s) => s.disabled).length, 0)
  assert.equal(result.seats.length, seatmap.planSeats.length)
  assert.equal(result.seats.length, 21)
  for (const seat of result.seats) {
    assert.equal(seat.serviceTableId, `db-${seat.id}`, `${seat.id} 对错了桌`)
    // 顾客订的永远是 1 号座，它代表整个可约单位。
    assert.equal(seat.seatNumber, 1)
  }
  // 同一张桌的同一个座号不能被两个底图编号占用，否则两位顾客会订到同一处。
  const keys = result.seats.map((s) => `${s.serviceTableId}#${s.seatNumber}`)
  assert.equal(new Set(keys).size, keys.length, '存在重复绑定')
})

// ★ 按 code 对位，不再按「区域名 + 桌号」。桌号只在区域内唯一，全店有五个「1 号桌」，
//   靠桌号认会把顾客订到别的区；这正是旧版要维护 areaNames 的原因。
test('table numbers repeating across zones never collide', () => {
  const numbers = storeTables().map((t) => t.number)
  assert.ok(numbers.filter((n) => n === 1).length > 1, '夹具里应当有多个 1 号桌，否则这条测试没意义')
  const result = seatmap.mapSeats(storeTables())
  assert.equal(result.seats.filter((s) => s.disabled).length, 0)
  assert.equal(result.seats.find((s) => s.id === 'B1')!.serviceTableId, 'db-B1')
  assert.equal(result.seats.find((s) => s.id === 'C1')!.serviceTableId, 'db-C1')
  assert.equal(result.seats.find((s) => s.id === 'E1')!.serviceTableId, 'db-E1')
})

test('the order the API returns tables in does not change the mapping', () => {
  const straight = seatmap.mapSeats(storeTables()).seats.map((s) => `${s.id}:${s.serviceTableId}`)
  const shuffled = seatmap.mapSeats(storeTables().reverse()).seats.map((s) => `${s.id}:${s.serviceTableId}`)
  assert.deepEqual(shuffled, straight)
})

// 包间里 D 区是双人桌：门店里是一张 2 座的桌，整桌预约，不能单人约。其余都是单人位。
test('a two-person unit shows as two people but books one unit', () => {
  const d1 = seatmap.mapSeats(storeTables()).seats.find((s) => s.id === 'D1')!
  assert.equal(d1.people, 2, '展示上可坐 2 人')
  assert.equal(d1.seatNumber, 1, '订的是 1 号座，它代表整张桌')
  for (const code of ['A1', 'B1', 'C1', 'E1']) {
    assert.equal(seatmap.mapSeats(storeTables()).seats.find((s) => s.id === code)!.people, 1, `${code} 是单人位`)
  }
})

// 包间整间预约要找门店：说明来自布局文件，图例下面和预约须知里显示的就是这句。
test('the private room note names its zones', () => {
  assert.deepEqual(seatmap.roomNotes, ['包间（D、E 区）：想包下整个包间，请提前联系门店预约'])
})

// 门店停用一张桌（坏了、在维护），图上要画出来但不可选。后端只下发启用的桌，停用的就不在列表里。
//
// ★★ 以前这里「缺一张就整张图拒绝」，以为布局固定后进不去；结果店员停用任意一张桌，
//    顾客就整张图约不了（2026-10-05 查出）。
test('a table the shop disabled is drawn but not selectable', () => {
  const result = seatmap.mapSeats(storeTables().filter((t) => t.code !== 'B3'))
  assert.equal(result.seats.length, 21, '停用的桌仍要画在图上')
  const b3 = result.seats.find((s) => s.id === 'B3')!
  assert.equal(b3.disabled, true)
  assert.equal(b3.serviceTableId, '', '没有可订的桌位编号，点不出预约')
  assert.equal(result.seats.filter((s) => s.disabled).length, 1, '其余照常可约')
})

// 小程序比后端先上线、布局里多出后端还没有的桌：同样画成不可选，其余的仍按编码对位，不会订错桌。
test('a planned table the store does not have yet is unselectable, the rest still map by code', () => {
  const result = seatmap.mapSeats(storeTables().filter((t) => t.code !== 'C2'))
  assert.equal(result.seats.find((s) => s.id === 'C2')!.disabled, true)
  for (const seat of result.seats.filter((s) => !s.disabled)) {
    assert.equal(seat.serviceTableId, `db-${seat.id}`, `${seat.id} 必须落在同编码的桌上`)
  }
})

test('tables with no layout code are ignored rather than matched by position', () => {
  const tables = storeTables()
  tables.push({ id: 'legacy', code: undefined, number: 1, seatCount: 1, occupiedSeats: [] })
  const result = seatmap.mapSeats(tables)
  assert.equal(result.seats.filter((s) => s.disabled).length, 0)
  assert.equal(result.seats.length, 21, '没有编码的历史桌不该出现在图上')
})

// 图例与底图的一致性：这些数字直接印在顾客看的图例上。
test('the legend counts match what the plan actually draws', () => {
  assert.equal(seatmap.zoneSeatCount('A'), 6)
  assert.equal(seatmap.zoneSeatCount('B'), 7)
  assert.equal(seatmap.zoneSeatCount('C'), 3)
  assert.equal(seatmap.zoneSeatCount('D'), 2)
  assert.equal(seatmap.zoneSeatCount('E'), 3)
  assert.equal(seatmap.planSize.width, layout.plan.width)
  assert.equal(seatmap.planSize.height, layout.plan.height)
})
