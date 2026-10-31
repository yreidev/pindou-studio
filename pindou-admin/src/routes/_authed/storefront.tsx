import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { hasRole, useCurrentAccount } from '../../account'
import { beadSettingsQuery } from '../../api/beads'
import { announcementQuery, patternLibraryQuery } from '../../api/storefront'
import { Page, QueryState } from '../../components/Page'
import { AnnouncementCard } from '../../features/storefront/AnnouncementCard'
import { BeadSettingsCard } from '../../features/storefront/BeadSettingsCard'
import { CategoriesCard } from '../../features/storefront/CategoriesCard'
import { PatternsCard } from '../../features/storefront/PatternsCard'
import '../../features/storefront/storefront.css'

// 首页内容（2026-10-20 业主定，方案见 docs/plan-home-and-patterns.md）：小程序首页上的公告、图纸与分类，
// 以及顾客「做图纸」用的豆子（2026-10-21，docs/plan-bead-maker.md）。
// 所有员工都能改（后端校验并记审计）。门店地址、经纬度跟电话、微信一起在「系统设置 › 营业与预约」，只有老板能改。

export const Route = createFileRoute('/_authed/storefront')({
  component: StorefrontPage,
})

function StorefrontPage() {
  const isOwner = hasRole(useCurrentAccount(), 'owner')
  const announcement = useQuery(announcementQuery())
  const library = useQuery(patternLibraryQuery())
  const beads = useQuery(beadSettingsQuery())
  return (
    <Page
      title="首页内容"
      description={
        <>
          小程序首页上的公告和图纸，以及顾客「做图纸」用的豆子，改了顾客下次打开就看到。门店地址和导航用的经纬度
          {isOwner ? (
            <>
              在
              <Link to="/system-settings" search={{ tab: 'reservations' }}>
                系统设置 › 营业与预约
              </Link>
              里填。
            </>
          ) : (
            '由老板在系统设置里填。'
          )}
        </>
      }
    >
      <QueryState query={announcement}>{(view) => <AnnouncementCard announcement={view.announcement} />}</QueryState>
      <QueryState query={library}>
        {(data) => (
          <>
            <PatternsCard library={data} />
            <CategoriesCard library={data} />
          </>
        )}
      </QueryState>
      <QueryState query={beads}>{(settings) => <BeadSettingsCard settings={settings} />}</QueryState>
    </Page>
  )
}
