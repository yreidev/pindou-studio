import { queryOptions } from '@tanstack/react-query'
import type { Coupon } from '../lib/coupon'
import { client, idempotencyKey, read, type Schemas } from './client'
import { reservationsApi } from './reservations'

// 「现场」看板用到的接口：桌位、进行中的会话、当班的入座申请、还要处理的预约，以及现场的几个写操作。
// 都沿用小程序员工端的现有接口与权限，后端不为看板另开接口。

/**
 * 桌位与它此刻的计时摘要：占用、最早到期那个会话的开始与结束时间、剩余秒数（不小于 0）、
 * timingStatus（running；剩 10 分钟以内 expiring；过了结束时间 overdue）。都由后端按当前时间算好。
 */
export type ServiceTable = Schemas['ServiceTable']
/** 进行中的会话（计时中、暂停、陪客）。admissionId 有值的是扫码入座或预约到店开的按座会话。 */
export type VenueSession = Schemas['ServiceTableSession']
/** 当班的入座申请：待确认的，以及按座会话的计时（带 sessionVersion、顾客称呼、套餐快照和草稿订单）。 */
export type AdmissionView = Schemas['LoyaltyAdmissionView']
/** 一条预约与它此刻的展示状态（过了宽限期显示 expired）。 */
export type ReservationEntry = Schemas['ReservationEntry']
export type Order = Schemas['Order']

/** 已发布的计时套餐（到店开台按它计时计价，不按预约时记下的套餐快照）。 */
export type PackageRule = Schemas['LoyaltyRule']
/** 当班视图里的一张启用的桌和它此刻被占的座号（不分座的整桌会话、整桌单位占满全部座号）。按座会话换座按它挑空座。 */
export type ShiftTable = Schemas['LoyaltyTable']

/** 看板一次读到的全部内容。 */
export interface BoardData {
  tables: ServiceTable[]
  sessions: VenueSession[]
  admissions: AdmissionView[]
  reservations: ReservationEntry[]
  /** 现行发布的计时套餐：到店开台的确认框按它写，后端也按它开台。 */
  packages: PackageRule[]
  /** 每天最晚结束（「营业与预约」，从 0 点起的分钟数）：「到打烊」开台用到这个时间。 */
  closeMinute: number
  /** 当班视图里启用的桌与被占的座号（同小程序「会员与计时」换座的候选）。 */
  shiftTables: ShiftTable[]
}

/**
 * 按座会话的计时与入座申请的确认、拒绝（/loyalty/actions）。计时动作带读到的 sessionVersion；
 * 换座（move）另带目标桌和座号，同小程序「会员与计时」的换座。确认入座可以改团购记录：不带是保留申请里的，
 * 平台和券码都为空串是清掉。结束（end）只在系统内收费关着时能用：结束计时、放座，不建单。
 */
export type BoardLoyaltyAction =
  | { action: 'confirm'; targetId: string; coupon?: Coupon }
  | { action: 'reject'; targetId: string }
  | { action: 'pause' | 'resume' | 'stop' | 'renew' | 'end'; targetId: string; expectedVersion: string }
  | { action: 'move'; targetId: string; expectedVersion: string; serviceTableId: string; seatNumber: number }

/**
 * 整桌开台的会话（不带 admissionId）在看板上能改的：暂停、继续、标记陪客（companion）、换桌（serviceTableId），
 * 或续时。续时只发追加的分钟数和看到的时长（extendMinutes + expectedDurationMinutes），不发「读到的时长 + N」：
 * 两人同时续或页面过期时后端回 409，不会互相覆盖、把时长改短。
 */
export type SessionPatch =
  | { status: 'active' | 'paused' | 'companion' }
  | { serviceTableId: string }
  | Required<Pick<Schemas['ServiceTableSessionUpdateInput'], 'extendMinutes' | 'expectedDurationMinutes'>>
  /** 停止计时（同按座会话）：单独提交，后端要幂等键；停了以后计价冻结、座位保留到结账。 */
  | { stop: true }
  /** 结束（系统内收费关着时）：单独提交，带幂等键；结束计时、立刻放座，不建单。 */
  | { end: true }
/** 改整桌会话的结果：会话，加上这一台的草稿订单有没有跟着按新计时改价（改了计时且已有草稿时才有）。 */
export type SessionUpdate = Schemas['ServiceTableSessionUpdateResult']
/** 整桌开台：桌位、顾客账户（不带即散客）、开始时间、计时方式，定时的另带分钟数。 */
export type SessionOpenInput = Schemas['ServiceTableSessionInput']

export const boardApi = {
  tables: (signal?: AbortSignal) => read(client.GET('/service-tables', { signal })),
  liveSessions: (signal?: AbortSignal) =>
    read(client.GET('/venue-sessions', { params: { query: { status: 'live' } }, signal })),
  shift: (signal?: AbortSignal) => read(client.GET('/loyalty/shift', { signal })),
  /** 按座会话与入座申请的操作，要幂等键；计时版本过期时后端回 409，由员工看过新状态后再点。 */
  loyalty: (input: BoardLoyaltyAction) =>
    read(client.POST('/loyalty/actions', { params: { header: idempotencyKey() }, body: input })),
  /**
   * 整桌开台（同小程序开台页，POST /venue-sessions）。契约里这个接口不收幂等键：结果未知时员工再点一次，
   * 上次其实开成了的话后端回 409 table_occupied（桌位正在使用），不会在同一张桌上开出第二台。
   */
  openSession: (input: SessionOpenInput) => read(client.POST('/venue-sessions', { body: input })),
  /**
   * 整桌开台的会话：暂停、继续、标记陪客、换桌、续时、停止计时、结束。按座会话走这里后端回 409 loyalty_conflict。带幂等键：
   * 结果未知时原样重发不会多续一次（续时、停止计时、结束后端要求带）。
   */
  updateSession: (sessionId: string, patch: SessionPatch): Promise<SessionUpdate> =>
    read(
      client.PATCH('/venue-sessions/{venueSessionId}', {
        params: { path: { venueSessionId: sessionId }, header: idempotencyKey() },
        body: patch,
      }),
    ),
  /**
   * 撤销误开的整桌会话（同小程序会话页的「撤销未结账开台」）：这一台的草稿订单在同一事务里作废。
   * 契约里这个接口不收幂等键：已撤销的再撤销后端原样回 204、不重复记审计，结果未知时再点一次不会多做什么。
   * 按座会话后端回 409 loyalty_conflict，已结账的回 409 session_settled。
   */
  cancelSession: (sessionId: string): Promise<void> =>
    read(client.DELETE('/venue-sessions/{venueSessionId}', { params: { path: { venueSessionId: sessionId } } })).then(
      () => undefined,
    ),
  /**
   * 从会话建草稿订单去结账（同小程序会话页的「去收款」）。这个会话已有草稿时后端返回同一张，
   * 所以按座会话（确认开台时已建好套餐草稿）和整桌会话都走这里。
   */
  createOrder: (venueSessionId: string) =>
    read(client.POST('/sales-orders', { params: { header: idempotencyKey() }, body: { venueSessionId } })),
  /** 预约：确认、到店开台。散客预约（没有 accountId）到店开台要带上选定的顾客账户。 */
  reservation: (input: { action: 'confirm' | 'seat'; targetId: string; accountId?: string }) =>
    read(client.POST('/reservations/actions', { params: { header: idempotencyKey() }, body: input })),
}

/**
 * 看板的数据一次读齐：四个接口并行，任何一个失败整体算失败（保留上一次读到的内容）。
 * 实时事件到达时随全部查询一起过期重读；时间流逝本身没有事件（快到点、超时是走着走着变的），
 * 所以页面另按连接状态定时重读，见 features/board/board.ts 的 refetchInterval。
 */
export function boardQuery() {
  return queryOptions({
    queryKey: ['service-tables', 'board'],
    queryFn: async ({ signal }): Promise<BoardData> => {
      const [tables, sessions, shift, reservations] = await Promise.all([
        boardApi.tables(signal),
        boardApi.liveSessions(signal),
        boardApi.shift(signal),
        reservationsApi.open(signal),
      ])
      return {
        tables,
        sessions,
        admissions: shift.admissions,
        reservations: reservations.reservations,
        packages: reservations.packages,
        closeMinute: reservations.settings.closeMinute,
        shiftTables: shift.tables,
      }
    },
  })
}
