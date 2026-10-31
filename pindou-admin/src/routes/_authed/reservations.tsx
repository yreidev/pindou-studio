import { IconSetting } from '@douyinfe/semi-icons'
import { Button, TabPane, Tabs } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { hasRole, useCurrentAccount } from '../../account'
import { openReservationsQuery } from '../../api/reservations'
import { Page, QueryState } from '../../components/Page'
import { refetchInterval } from '../../features/board/board'
import { useNow } from '../../features/board/hooks'
import { RegisterForm } from '../../features/reservations/RegisterForm'
import { ReservationList } from '../../features/reservations/ReservationList'
import { reservationsSearchSchema } from '../../features/reservations/reservations'
import { useRealtime } from '../../realtime/RealtimeProvider'
import '../../features/reservations/reservations.css'

// 「预约」：预约列表（按门店日期、状态筛）、确认、到店开台、取消、标记爽约，以及接电话时代客登记。
// 和小程序员工「预约」页同一套接口与规则（docs/product.md「预约到店」）；所有员工可用，能做什么由后端判断。
export const Route = createFileRoute('/_authed/reservations')({
  validateSearch: reservationsSearchSchema,
  component: ReservationsPage,
})

function ReservationsPage() {
  const me = useCurrentAccount()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const { status } = useRealtime()
  // 实时事件到达时随全部查询过期重读；时间流逝没有事件（过了宽限期变成过期），另按连接状态定时重读
  const open = useQuery({ ...openReservationsQuery(), refetchInterval: refetchInterval(status) })
  // 「已过开始时间几分钟」、能不能标记爽约随时间变，页面每 15 秒换一次「此刻」
  const now = useNow(15_000)
  const tab = search.tab ?? 'list'

  return (
    <Page
      title="预约"
      description="顾客在小程序自助预约的要先确认；接电话时在「代客登记」里登记，登记后直接生效。预约不收钱，到店开台时按当时的套餐计时。时间按门店所在的中国时区。"
      extra={
        hasRole(me, 'owner') ? (
          <Button
            icon={<IconSetting />}
            onClick={() => void navigate({ to: '/system-settings', search: { tab: 'reservations' } })}
          >
            营业与预约设置
          </Button>
        ) : null
      }
    >
      <QueryState query={open}>
        {(view) => (
          // 两个标签页都留着（keepDOM）：登记填到一半切去列表看一眼，回来输入还在
          <Tabs
            type="line"
            activeKey={tab}
            onChange={(key) =>
              void navigate({ search: (prev) => ({ ...prev, tab: key === 'register' ? 'register' : undefined }) })
            }
          >
            <TabPane tab="预约列表" itemKey="list">
              <div style={{ paddingTop: 16 }}>
                <ReservationList view={view} now={now} />
              </div>
            </TabPane>
            <TabPane tab="代客登记" itemKey="register">
              <div style={{ paddingTop: 16 }}>
                <RegisterForm view={view} now={now} onDone={(day) => void navigate({ search: { date: day } })} />
              </div>
            </TabPane>
          </Tabs>
        )}
      </QueryState>
    </Page>
  )
}
