import type { FloorArea, ServiceTable } from '../../api/table-codes'

// 桌位按区域分组。布局固定（layout/store-layout.json，后端启动时校正），区域名和桌的编码都以接口为准。

export interface TableGroup {
  key: string
  title: string
  tables: ServiceTable[]
}

const collator = new Intl.Collator('zh-CN', { numeric: true })

/** 桌上贴的名字：布局编码（A1、B3）；老数据没有编码时用「区域 + 桌号」。 */
export function tableLabel(table: Pick<ServiceTable, 'code' | 'number'>, areaName = ''): string {
  return table.code || `${areaName}${areaName ? ' ' : ''}${table.number} 号桌`
}

export function seatText(table: Pick<ServiceTable, 'seatCount' | 'wholeTable'>): string {
  return `${table.seatCount} 座${table.wholeTable ? ' · 整桌' : ''}`
}

/** 按区域分组：区域按名称排（A 区、B 区…），区内按编码/桌号排；区域列表里没有的归到「未分区」。 */
export function groupTables(tables: readonly ServiceTable[], areas: readonly FloorArea[]): TableGroup[] {
  const names = new Map(areas.map((area) => [area.id, area.name]))
  const groups = new Map<string, TableGroup>()
  for (const table of tables) {
    const name = names.get(table.floorAreaId)
    const key = name ? table.floorAreaId : 'unknown'
    const group = groups.get(key) ?? { key, title: name ?? '未分区', tables: [] }
    group.tables.push(table)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort((a, b) => (a.key === 'unknown' ? 1 : b.key === 'unknown' ? -1 : collator.compare(a.title, b.title)))
    .map((group) => ({
      ...group,
      tables: [...group.tables].sort((a, b) => a.number - b.number || collator.compare(tableLabel(a), tableLabel(b))),
    }))
}

/** 批量生成和打印的范围：启用的桌里没被取消勾选的。停用的桌不出码。 */
export function selectedTables(tables: readonly ServiceTable[], excluded: ReadonlySet<string>): ServiceTable[] {
  return tables.filter((table) => table.enabled && !excluded.has(table.id))
}
