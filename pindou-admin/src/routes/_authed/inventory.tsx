import { Tabs } from '@douyinfe/semi-ui'
import { createFileRoute } from '@tanstack/react-router'
import { hasRole, useCurrentAccount } from '../../account'
import { Page } from '../../components/Page'
import { AdjustTab } from '../../features/inventory/AdjustTab'
import { CatalogTab } from '../../features/inventory/CatalogTab'
import { MovementsTab } from '../../features/inventory/MovementsTab'
import { PurchaseTab } from '../../features/inventory/PurchaseTab'
import { StockTab } from '../../features/inventory/StockTab'
import {
  inventorySearchSchema,
  resolveTab,
  tabLabels,
  visibleTabs,
  type InventoryTab,
} from '../../features/inventory/search'
import '../../features/inventory/inventory.css'

export const Route = createFileRoute('/_authed/inventory')({
  validateSearch: inventorySearchSchema,
  component: InventoryPage,
})

function InventoryPage() {
  const me = useCurrentAccount()
  // 只决定显示哪些操作；能不能做以后端为准（店员调盘点、改商品资料会被 403 拒绝）
  const canManage = hasRole(me, 'manager', 'owner')
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab = resolveTab(search.tab, canManage)

  return (
    <Page
      title="商品与库存"
      description={
        canManage
          ? '库存数字以系统为准：采购入库、盘点、结账出库和退款回补后各端实时刷新。盘点必须写原因，流水只追加不改写。'
          : '库存数字以系统为准，各端实时刷新。店员可以登记采购入库；盘点和修改商品资料请找店长或老板。'
      }
    >
      <Tabs
        type="line"
        // 放不下（手机上）时由 Semi 自动改成左右箭头滚动，不折成两行
        collapsible="auto"
        activeKey={tab}
        tabList={visibleTabs(canManage).map((key) => ({ itemKey: key, tab: tabLabels[key] }))}
        // 只带上标签页本身，各标签页的筛选、页码不串到别的标签页
        onChange={(key) => void navigate({ search: { tab: key as InventoryTab } })}
        style={{ marginBottom: 16 }}
      />
      {tab === 'stock' ? <StockTab canManage={canManage} /> : null}
      {tab === 'purchase' ? <PurchaseTab canManage={canManage} /> : null}
      {tab === 'adjust' ? <AdjustTab /> : null}
      {tab === 'movements' ? <MovementsTab /> : null}
      {tab === 'catalog' ? <CatalogTab canManage={canManage} /> : null}
    </Page>
  )
}
