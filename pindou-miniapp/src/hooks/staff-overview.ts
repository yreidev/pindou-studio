import { useStaffQuery } from './query'
import { staffApi } from '../services/staff'
import { loyalty } from '../services/membership'
import { reservations } from '../services/reservations'
import { needsAlert, serviceCalls, type ServiceCall } from '../services/service-calls'
import { timingAlerts } from '../services/timing-alerts'

/**
 * 现场一页要看的：桌位、进行中的会话、当班的扫码入座申请、还要处理的预约、今天被顾客取消还没人点「知道了」的预约，
 * 收费开着时加待结账的单。
 * 底部导航的待办数也读这一份（同一个查询键，页面之间共用，不多发请求）。
 * 都只为当班：预约只要还没处理的（scope=open），申请只要当班的（shift），不拉历史与全店账户。
 */
export function useStaffOverview(billing: boolean, refetchInterval: number | false = 30000) {
  return useStaffQuery(
    ['staff-overview', billing],
    async () => {
      const [tables, sessions, shift, open, orders] = await Promise.all([
        staffApi.listTables(),
        staffApi.listLiveSessions(),
        loyalty.shift(),
        reservations.staffOpen(),
        billing ? staffApi.listDraftOrders() : Promise.resolve([]),
      ])
      return {
        tables,
        sessions,
        shift,
        reservations: open.reservations,
        cancellations: open.customerCancellations ?? [],
        orders,
      }
    },
    { refetchInterval },
  )
}

export type StaffOverview = NonNullable<ReturnType<typeof useStaffOverview>['data']>

/** 还没处理的顾客呼叫：和现场页顶上那块同一个查询。 */
export function useOpenServiceCalls(refetchInterval: number | false = 30000) {
  return useStaffQuery(['service-calls', 'open'], serviceCalls.open, { refetchInterval })
}

/**
 * 底部导航上的待办数。现场：没人认领的呼叫、等确认的扫码入座、快到点和已超时的桌、顾客今天取消了还没人点「知道了」的；
 * 预约：等确认的，加上过了时间还没来的（displayStatus 为 expired）。
 * ★ 看 displayStatus 不看 status：过期的申请 status 永远停在 pending，拿它计数会挂着一个永远下不去的数字。
 */
export function staffBadges(
  overview: StaffOverview | null,
  calls: ServiceCall[] | null,
  now: number,
): Record<string, number> {
  const live =
    (calls || []).filter(needsAlert).length +
    (overview?.shift.admissions.filter((entry) => entry.displayStatus === 'pending').length || 0) +
    (overview ? timingAlerts(overview.tables, overview.sessions, now).length : 0) +
    (overview?.cancellations.length || 0)
  const booked =
    overview?.reservations.filter((entry) => entry.displayStatus === 'pending' || entry.displayStatus === 'expired')
      .length || 0
  return { workbench: live, reservations: booked }
}
