import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { client, idempotencyKey, read, readPage, type Page, type Schemas } from './client'

// 商品与库存接口：/catalog-items、/stock-items、/stock-items/{id}、/stock-receipts、/stock-receipts/prefill、
// /stock-adjustments、/stock-movements。库存数字只以这里读到的为准，前端不推算。

/** 历史上只入过库、没建资料的商品名称为空。条码没登记时不带 barcode。 */
export type CatalogItem = Schemas['CatalogItem']
export type CatalogInput = Schemas['CatalogInput']
/** 修改商品资料：只改带了的字段；barcode 为空串表示清除条码。 */
export type CatalogPatch = Schemas['CatalogPatch']
/** 收货入库的预填值：最近一次入库的供应商、每件商品最近一次入库的进价（后端从采购单现算）。 */
export type PurchasePrefill = Schemas['PurchasePrefill']
export type StockItem = Schemas['StockItem']
export type PurchaseInput = Schemas['PurchaseInput']
export type PurchaseReceipt = Schemas['PurchaseReceipt']
/**
 * 盘点调整。expectedQuantity 是确认时界面上的当前库存：后端拿它和库里的比，对不上（期间有人结账、入库或盘点）
 * 回 409 stock_quantity_conflict，什么都不改。
 */
export type AdjustmentInput = Schemas['InventoryAdjustmentInput']
/** 一条库存流水：正数入库，负数出库；只追加不改写。 */
export type StockMovement = Schemas['StockMovement']
export type MovementKind = StockMovement['kind']

export const movementKinds = [
  'purchase',
  'adjustment',
  'sale',
  'refund',
  'loyalty',
] as const satisfies readonly MovementKind[]

export interface MovementFilters {
  stockItemId?: string
  kind?: MovementKind
  /** 门店日期 YYYY-MM-DD，含当天。 */
  from?: string
  to?: string
  page: number
  pageSize: number
}

export const inventoryApi = {
  listCatalog: (signal?: AbortSignal) => read(client.GET('/catalog-items', { signal })),
  listStock: (signal?: AbortSignal) => read(client.GET('/stock-items', { signal })),
  /** 流水按页取：筛选、排序（新的在前）、分页都在服务端，流水会一直增长。 */
  listMovements: (filters: MovementFilters, signal?: AbortSignal): Promise<Page<StockMovement>> =>
    readPage(
      client.GET('/stock-movements', {
        params: {
          query: {
            page: filters.page,
            pageSize: filters.pageSize,
            stockItemId: filters.stockItemId || undefined,
            kind: filters.kind,
            from: filters.from || undefined,
            to: filters.to || undefined,
          },
        },
        signal,
      }),
      filters.page,
    ),
  createCatalogItem: (input: CatalogInput) =>
    read(client.POST('/catalog-items', { params: { header: idempotencyKey() }, body: input })),
  updateCatalogItem: (id: string, input: CatalogPatch) =>
    read(
      client.PATCH('/catalog-items/{catalogItemId}', {
        params: { path: { catalogItemId: id }, header: idempotencyKey() },
        body: input,
      }),
    ),
  /** 入库表单的预填值（只是建议，员工可改；入库接口不看它）。 */
  purchasePrefill: (signal?: AbortSignal) => read(client.GET('/stock-receipts/prefill', { signal })),
  receiveStock: (input: PurchaseInput) =>
    read(client.POST('/stock-receipts', { params: { header: idempotencyKey() }, body: input })),
  /** 改预警线（店长、老板）。只收 alertAt，返回改后的库存项目。 */
  updateStockAlert: (stockItemId: string, alertAt: number) =>
    read(
      client.PATCH('/stock-items/{stockItemId}', {
        params: { path: { stockItemId }, header: idempotencyKey() },
        body: { alertAt },
      }),
    ),
  /** 盘点调整，返回调整后的库存数量（id 是库存项目编号）。 */
  adjustStock: (input: AdjustmentInput) =>
    read(client.POST('/stock-adjustments', { params: { header: idempotencyKey() }, body: input })),
}

export const catalogItemsQuery = () =>
  queryOptions({ queryKey: ['catalog-items'], queryFn: ({ signal }) => inventoryApi.listCatalog(signal) })

export const stockItemsQuery = () =>
  queryOptions({ queryKey: ['stock-items'], queryFn: ({ signal }) => inventoryApi.listStock(signal) })

/** 预填值随入库变化：入库成功后整体过期重读，拿到的就是刚用过的供应商和进价。 */
export const purchasePrefillQuery = () =>
  queryOptions({
    queryKey: ['stock-receipts', 'prefill'],
    queryFn: ({ signal }) => inventoryApi.purchasePrefill(signal),
  })

export const stockMovementsQuery = (filters: MovementFilters) =>
  queryOptions({
    queryKey: ['stock-movements', filters],
    queryFn: ({ signal }) => inventoryApi.listMovements(filters, signal),
    placeholderData: keepPreviousData,
  })
