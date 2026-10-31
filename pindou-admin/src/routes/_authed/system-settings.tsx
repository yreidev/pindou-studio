import { Banner, Tabs } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { hasRole, useCurrentAccount } from '../../account'
import { billingSettingsQuery } from '../../api/billing'
import { codeSettingsQuery } from '../../api/table-codes'
import { Page, QueryState } from '../../components/Page'
import { ReservationSettingsPanel } from '../../features/reservation-settings/ReservationSettingsPanel'
import { BillingCard } from '../../features/system-settings/BillingCard'
import {
  systemSettingsSearchSchema,
  systemSettingsTabs,
  type SystemSettingsTab,
} from '../../features/system-settings/search'
import { CodeSettingsCard } from '../../features/table-codes/CodeSettingsCard'

// 系统设置（2026-10-10 业主定）：门店级的开关都放这一页，不分散在各处。三块：系统内收费、营业与预约（原「预约设置」页）、
// 小程序码指向的版本（原在「桌码」页）。只有老板能改（后端校验），侧栏也只给老板；别的员工从链接进来只能看。
// 换标签页走网址：营业与预约有没保存的改动时，离开前照样要确认。

export const Route = createFileRoute('/_authed/system-settings')({
  validateSearch: systemSettingsSearchSchema,
  component: SystemSettingsPage,
})

function SystemSettingsPage() {
  const me = useCurrentAccount()
  const isOwner = hasRole(me, 'owner')
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tab: SystemSettingsTab = search.tab ?? 'billing'

  return (
    <Page title="系统设置" description="门店级的开关和设置，改动影响所有员工和顾客。时间按门店所在的中国时区判定。">
      {isOwner ? null : (
        <Banner type="info" closeIcon={null} description="只有老板可以修改系统设置。" style={{ marginBottom: 12 }} />
      )}
      <Tabs
        type="line"
        collapsible="auto"
        activeKey={tab}
        tabList={systemSettingsTabs.map((item) => ({ itemKey: item.key, tab: item.label }))}
        onChange={(key) => void navigate({ search: { tab: key as SystemSettingsTab } })}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'billing' ? <BillingPanel canEdit={isOwner} /> : null}
        {tab === 'reservations' ? <ReservationSettingsPanel /> : null}
        {tab === 'code' ? <CodePanel canEdit={isOwner} /> : null}
      </div>
    </Page>
  )
}

function BillingPanel({ canEdit }: { canEdit: boolean }) {
  const query = useQuery(billingSettingsQuery())
  return <QueryState query={query}>{(settings) => <BillingCard settings={settings} canEdit={canEdit} />}</QueryState>
}

function CodePanel({ canEdit }: { canEdit: boolean }) {
  const query = useQuery(codeSettingsQuery())
  return (
    <QueryState query={query}>{(settings) => <CodeSettingsCard settings={settings} canEdit={canEdit} />}</QueryState>
  )
}
