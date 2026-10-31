import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'vitest'
import { root } from './helpers/load'

const ROOT = path.resolve(root, '../layout/store-layout.json')
const EMBEDDED = path.resolve(root, '../pindou-backend/internal/layout/store-layout.json')
const layout = JSON.parse(fs.readFileSync(ROOT, 'utf8'))

// 前后端读的必须是同一份字节。
//
// ★ go:embed 出不了模块目录、也不认符号链接，所以后端只能放一份副本。两份漂了就是
//   两份真相，而「只有一份真相」正是这次改造的全部意义。后端 layout_test.go 也钉了同一条，
//   两边都钉是因为改布局的人可能只跑其中一边的测试。
test('the backend embeds a byte-identical copy of the layout', () => {
  assert.equal(
    fs.readFileSync(EMBEDDED, 'utf8'),
    fs.readFileSync(ROOT, 'utf8'),
    '改布局要两步：改 layout/store-layout.json，再 cp 到 pindou-backend/internal/layout/',
  )
})

test('the layout describes this store and nothing is out of range', () => {
  assert.equal(layout.tables.length, 21, '门店是 21 个可约单位（店主 2026-09-26 的最终版）')
  const codes = layout.tables.map((t) => t.code)
  assert.equal(new Set(codes).size, 21, '编码必须唯一')

  const zones = new Map(layout.zones.map((z) => [z.key, z]))
  for (const table of layout.tables) {
    const zone: any = zones.get(table.zone)
    assert.ok(zone, `${table.code}: 分区 ${table.zone} 不存在`)
    assert.equal(table.code, `${table.zone}${table.number}`, '编码必须是分区字母加桌号')
    assert.equal(table.seatCount, zone.seatsPerUnit, `${table.code}: 座数要和分区的每单位座数一致`)
    // 多于一座的桌必须是整桌单位，否则后端按座号判占用，顾客订走 1 号座之后
    // 2 号座仍会被扫码入座卖给别人，两拨客人被拼到同一张桌上。
    assert.equal(table.wholeTable, table.seatCount > 1, `${table.code}: 多于一座必须标 wholeTable`)

    // 热区必须落在底图内，否则顾客点不到，或者点到图外。
    const { x, y, w, h } = table.hotspot
    assert.ok(w > 0 && h > 0, `${table.code}: 热区尺寸无效`)
    assert.ok(x >= 0 && y >= 0, `${table.code}: 热区坐标为负`)
    assert.ok(x + w <= layout.plan.width, `${table.code}: 热区右边超出底图`)
    assert.ok(y + h <= layout.plan.height, `${table.code}: 热区下边超出底图`)
  }
})

// 热区不该互相重叠：重叠的话顾客点一下会命中后渲染的那个，订到隔壁座位。
test('no two hotspots overlap', () => {
  const boxes = layout.tables.map((t) => ({ code: t.code, ...t.hotspot }))
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      assert.ok(!hit, `${a.code} 与 ${b.code} 的热区重叠，顾客会点到隔壁座位`)
    }
  }
})
