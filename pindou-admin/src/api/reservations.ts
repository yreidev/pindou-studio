import { queryOptions } from '@tanstack/react-query'
import { client, idempotencyKey, read, readPage, type Schemas } from './client'

// 预约（reservations 资源）。网页后台有「预约」页（列表、确认、取消、爽约、到店开台、代客登记，和小程序员工
// 「预约」页同一套接口）、「预约设置」页，现场看板上也能确认预约、到店开台。

/**
 * 门店可预约范围，时间按中国时区判定；分钟数从当天 00:00 起算，closeMinute 最大 1440（24:00）。
 * enabled 是否开放顾客自助预约；员工代客登记不受影响。
 */
export type ReservationSettings = Schemas['ReservationSettings']

/**
 * 员工预约视图。settingsVersion 是预约设置的版本：保存设置时原样回传，只覆盖设置本身。
 * packages 是已发布的计时套餐，tables 是启用的桌位（停用的不下发），busy 是还会占座的时间段
 * （kind=reservation 还会到店的预约；kind=session 座位上正在进行、还没到结束时间的定时会话）。
 */
export type ReservationView = Schemas['ReservationView']
export type ReservationEntry = ReservationView['reservations'][number]
export type Reservation = Schemas['Reservation']
export type ReservationStatus = Reservation['status']
/** 预约视图里的一张启用的桌：编码、座位数、是不是整桌售卖。 */
export type ReservationTable = ReservationView['tables'][number]
export type BusySlot = ReservationView['busy'][number]

/** 员工在预约页上做的事：确认、取消、标记爽约（可带原因）、代客登记。到店开台走看板同一个入口（boardApi.reservation）。 */
export type ReservationDecision =
  | { action: 'confirm'; targetId: string }
  | {
      action: 'cancel' | 'no_show'
      targetId: string
      /** 取消、爽约的原因，可不填（不填就不发）。 */
      reason?: string
    }
/** 代客登记：顾客账户和称呼二选一（都没有后端拒绝），不保存手机号；备注、团购记录可不填。 */
export type ReservationRegister = Pick<
  Schemas['ReservationAction'],
  'accountId' | 'guestName' | 'serviceTableId' | 'seatNumber' | 'packageId' | 'startAt' | 'note' | 'coupon'
> & { action: 'register' }

/** 已结束的预约每页几条（服务端分页，同小程序）。 */
export const endedPageSize = 20

export const reservationsApi = {
  /**
   * 员工预约视图里还要处理的部分（scope=open：待确认、已确认，含过了宽限期的 expired），按开始时间。
   * 不会越积越多，整份取回；处理完的历史分页另取（scope=ended）。
   */
  open: (signal?: AbortSignal) =>
    read(client.GET('/reservations/staff', { params: { query: { scope: 'open' } }, signal })),
  /**
   * 处理完的（已到店、已取消、爽约），开始时间新的在前，服务端分页；总数与实际页码在响应头里。
   * 给了门店日期 date（YYYY-MM-DD）就只要到店时间在那一天的，哪一天由后端按中国标准时间判断。
   */
  ended: (page: number, date?: string, signal?: AbortSignal) =>
    readPage(
      client
        .GET('/reservations/staff', {
          params: { query: { scope: 'ended', page, pageSize: endedPageSize, ...(date ? { date } : {}) } },
          signal,
        })
        .then(({ data, response }) => ({ data: data?.reservations, response })),
      page,
    ),
  /**
   * 确认、取消、爽约、代客登记。要幂等键：结果未知时同一动作原样重发（见 api/client.ts 的 idempotentFetch）。
   * 返回操作后的员工预约视图（同 scope=open），targetId 是这次操作的预约。
   */
  act: (input: ReservationDecision | ReservationRegister) =>
    read(client.POST('/reservations/actions', { params: { header: idempotencyKey() }, body: input })),
  /** 保存预约设置（仅老板）。返回保存后的员工预约视图，内容与 scope=open 相同。 */
  saveSettings: (settings: ReservationSettings, expectedVersion: string) =>
    read(
      client.POST('/reservations/actions', {
        params: { header: idempotencyKey() },
        body: { action: 'save_settings', settings, expectedVersion },
      }),
    ),
}

export const openReservationsQuery = () =>
  queryOptions({ queryKey: ['reservations', 'staff', 'open'], queryFn: ({ signal }) => reservationsApi.open(signal) })

export const endedReservationsQuery = (page: number, date?: string) =>
  queryOptions({
    queryKey: ['reservations', 'staff', 'ended', date ?? 'all', page],
    queryFn: ({ signal }) => reservationsApi.ended(page, date, signal),
    // 同一天里翻页时先留着上一页，新的一页回来再换；换了日期不留（别把别的日子的预约当成这一天的）
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === (date ?? 'all') ? previous : undefined,
  })
