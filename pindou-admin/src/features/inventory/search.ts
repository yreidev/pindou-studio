import { z } from 'zod'
import { movementKinds } from '../../api/inventory'

// 「商品与库存」页的网址参数：当前标签页和各标签页的筛选、分页都放在网址里，刷新、分享链接不丢。
// 参数不合法时丢掉那一项（.catch），不让一个手改坏的链接把整页弄成错误页。

export const inventoryTabs = ['stock', 'purchase', 'adjust', 'movements', 'catalog'] as const
export type InventoryTab = (typeof inventoryTabs)[number]

export const tabLabels: Record<InventoryTab, string> = {
  stock: '库存',
  purchase: '采购入库',
  adjust: '盘点',
  movements: '流水',
  catalog: '商品资料',
}

const storeDate = /^\d{4}-\d{2}-\d{2}$/

export const inventorySearchSchema = z.object({
  tab: z.enum(inventoryTabs).optional().catch(undefined),
  /** 库存、商品资料的搜索关键字 */
  q: z.string().optional().catch(undefined),
  /** 只看库存预警 */
  low: z.boolean().optional().catch(undefined),
  /** 表格页码，从 1 数 */
  page: z.number().int().min(1).optional().catch(undefined),
  /** 库存项目编号：盘点预选、流水按商品筛选 */
  item: z.string().optional().catch(undefined),
  /** 商品编号：采购入库预选 */
  product: z.string().optional().catch(undefined),
  /** 流水类型 */
  kind: z.enum(movementKinds).optional().catch(undefined),
  /** 流水的门店日期范围 YYYY-MM-DD */
  from: z.string().regex(storeDate).optional().catch(undefined),
  to: z.string().regex(storeDate).optional().catch(undefined),
})

export type InventorySearch = z.infer<typeof inventorySearchSchema>

/**
 * 当前角色能看到的标签页。盘点只有店长、老板能做（后端同样校验），店员不显示；
 * 商品资料店员可以看（只读），新增和修改按钮只给店长、老板。
 */
export function visibleTabs(canManage: boolean): InventoryTab[] {
  return inventoryTabs.filter((tab) => canManage || tab !== 'adjust')
}

/** 网址里的标签页当前角色看不到（店员手输了 ?tab=adjust）就回到库存。 */
export function resolveTab(tab: InventoryTab | undefined, canManage: boolean): InventoryTab {
  return tab && visibleTabs(canManage).includes(tab) ? tab : 'stock'
}
