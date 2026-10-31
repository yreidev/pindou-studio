import type { BoardData, VenueSession } from '../../api/board'
import { primarySession, seatState, seatStateNames, tablePlace } from './board'
import { planSeats } from './layout'

// 会话详情里的换桌（整桌会话）与换座（按座会话）能换到哪儿。候选和能不能选都取自看板已经读到的接口数据，
// 不另推一套座位状态，规则照小程序：
// - 整桌会话：会话页「换桌」只列启用、空闲（occupancy 为 idle）、不是现在这张的桌，整张桌搬过去；
// - 按座会话：「会员与计时」的「换座」列当班视图（/loyalty/shift 的 tables）里每张启用的桌没被占的座号。
// 能不能真换过去以后端为准（目标刚被人占了、时段压到别人的预约都会被拒，原话显示在抽屉里）。
// 这里另把不能选的也列出来（灰着），写明原因，员工不用猜某张桌为什么不在单子里。

/** 换桌、换座的一个候选。 */
export interface MoveTarget {
  /** 下拉框的值：整桌会话是桌位编号，按座会话是「桌位编号#座号」。 */
  value: string
  serviceTableId: string
  /** 按座会话换过去的座号；整桌会话换的是整张桌，没有。 */
  seatNumber?: number
  /** 「B4」「D1 · 整桌」（换桌），「D2 · 2 号座」（换座）。 */
  place: string
  /** 不能选的原因（「使用中」「停用」「当前所在」……）；能选时没有。 */
  blocked?: string
}

/** 下拉框里的一项：不能选的灰着，后面写原因。 */
export function moveOption(target: MoveTarget) {
  return {
    value: target.value,
    label: target.blocked ? `${target.place} · ${target.blocked}` : target.place,
    disabled: Boolean(target.blocked),
  }
}

/** 换桌、换座的全部候选，按平面图（门店布局）的顺序；session 是要换走的那个会话。 */
export function moveTargets(
  data: Pick<BoardData, 'tables' | 'sessions' | 'shiftTables'>,
  session: Pick<VenueSession, 'serviceTableId' | 'admissionId' | 'seatNumber'>,
): MoveTarget[] {
  const tables = new Map(data.tables.map((table) => [table.code, table]))
  const shift = new Map(data.shiftTables.map((table) => [table.id, table]))
  /** 有人在用的桌写看板上的状态（使用中、暂停、已超时……）。 */
  const busyText = (table: (typeof data.tables)[number]) => {
    const state = seatState(table, primarySession(table, data.sessions))
    return state === 'free' || state === 'off' ? '有人' : seatStateNames[state]
  }
  return planSeats.flatMap((plan): MoveTarget[] => {
    const table = tables.get(plan.code)
    // 布局里有、接口里没有（不应发生）：如实写，不让选
    if (!table) return [{ value: `missing-${plan.code}`, serviceTableId: '', place: plan.code, blocked: '桌位待核对' }]

    if (!session.admissionId) {
      const blocked =
        table.id === session.serviceTableId
          ? '当前所在'
          : !table.enabled
            ? '停用'
            : table.occupancy !== 'idle'
              ? busyText(table)
              : undefined
      return [{ value: table.id, serviceTableId: table.id, place: tablePlace(table), blocked }]
    }

    const occupied = shift.get(table.id)?.occupiedSeats
    return Array.from({ length: table.seatCount }, (_, index) => {
      const seat = index + 1
      const blocked =
        table.id === session.serviceTableId && seat === session.seatNumber
          ? '当前座位'
          : !table.enabled
            ? '停用'
            : !occupied
              ? // 当班视图只列启用的桌；两次读取之间刚启用、还没读到占用的，先不让选
                '桌位待核对'
              : occupied.includes(seat)
                ? busyText(table)
                : undefined
      return {
        value: `${table.id}#${seat}`,
        serviceTableId: table.id,
        seatNumber: seat,
        place: table.seatCount > 1 ? `${table.code} · ${seat} 号座` : table.code,
        blocked,
      }
    })
  })
}
