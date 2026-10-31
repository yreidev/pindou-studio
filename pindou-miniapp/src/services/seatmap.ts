// 平面选座：底图坐标与门店桌位的对应关系。
//
// 公开底图是虚构示例，放在主包，顾客端与员工端共用。
// 像素尺寸、热区与桌位编码均来自 layout/store-layout.json。
//
// ★★ 布局是固定的（2026-09-19）。唯一真相是仓库根的 layout/store-layout.json，
//    后端 go:embed 同一份并在启动时按它校正数据库（ReconcileLayout）。
//
//    在此之前这里还有一整套「对账机器」：areaNames / seatBinding / plannedAreas /
//    planSyncSteps / syncPending，以及 mapSeats 里五个「对不上就整张图拒绝」的分支。
//    它们存在的唯一理由是后端允许店员任意增删改桌位，两边可能对不上。代价很重 ——
//    2026-09-19 现场就卡死过：顾客端说配置有问题用不了平面图，员工端的「按平面图同步」
//    却认为无事可做、按钮根本不渲染，店家没有任何出口。
//
//    现在按 code 直接对位：后端保证库里就是布局里那 20 张，前端不必再怀疑。
import layout from '../../../layout/store-layout.json'
import type { Table } from './membership'

export type SeatZone = 'A' | 'B' | 'C' | 'D' | 'E'

export type PlanSeat = {
  /** 画在底图上的编号，同时是布局里的稳定编码（A1、B3…） */
  id: string
  zone: SeatZone
  /** 底图像素坐标 */
  x: number
  y: number
  w: number
  h: number
}

/** 底图尺寸，座位坐标以此为基准换算百分比 */
export const planSize = { width: layout.plan.width, height: layout.plan.height }

// color 是底图里各区座位框的颜色，图例用它对照图上的色块；不是界面配色 token。
// seatsPerUnit：一个可约单位坐几个人。D 区（包间）是双人桌，整桌预约，不能单座约。
export const zones = layout.zones as {
  key: SeatZone
  name: string
  desc: string
  color: string
  seatsPerUnit: number
}[]

/** 画在图上但不是座位的区域，图例里说明，免得被当成漏掉的可选位 */
export const facilityLegends = layout.facilities

/**
 * 由几个区组成的房间（包间）和给顾客的说明：图例下面和「预约须知」里各显示一次。
 * 自助预约仍是一个位置一个位置地约，包整间要找门店（店主 2026-09-25 的要求）。
 */
export const rooms = layout.rooms as { name: string; zones: SeatZone[]; note: string }[]

/** 「包间（D、E 区）：想包下整个包间，请提前联系门店预约」 */
export const roomNotes = rooms.map((room) => `${room.name}（${room.zones.join('、')} 区）：${room.note}`)

/** 底图上的座位。顺序即布局文件里的顺序。 */
export const planSeats: PlanSeat[] = layout.tables.map((table) => ({
  id: table.code,
  zone: table.zone as SeatZone,
  ...table.hotspot,
}))

/** 每个分区在底图上画了几个座位 */
export const zoneSeatCount = (zone: SeatZone) => planSeats.filter((seat) => seat.zone === zone).length

export const zoneOf = (zone: SeatZone) => zones.find((z) => z.key === zone)

/** 底图编号绑定到的真实座位 */
export type MappedSeat = PlanSeat & {
  serviceTableId: string
  tableNumber: number
  seatNumber: number
  /** 这个单位坐几个人：双人位是 2，整桌预约 */
  people: number
  /** 门店把这张桌停用了（桌子坏了之类）。图上画出来但不可选。 */
  disabled: boolean
}

export type SeatMapping = {
  seats: MappedSeat[]
}

/**
 * 把门店桌位贴到底图编号上。
 *
 * ★★ 图上有、列表里没有的桌一律画成停用、不给选：后端只下发启用的桌（loyaltyTables 跳过停用的），
 *    所以缺的就是门店停用了的。以前这里是「缺一张就整张图拒绝」，以为布局固定后进不去，
 *    结果店员在桌位页停用任意一张桌，顾客就整张图约不了（2026-10-05 查出）。
 *    小程序比后端先上线、布局里多出后端还没有的桌时也落到这里：同样不可选，不会把顾客订到错的桌上。
 */
export function mapSeats(tables: Table[]): SeatMapping {
  const byCode = new Map(tables.filter((table) => table.code).map((table) => [table.code as string, table]))
  const seats: MappedSeat[] = planSeats.map((plan) => {
    const table = byCode.get(plan.id)
    return {
      ...plan,
      serviceTableId: table?.id ?? '',
      tableNumber: table?.number ?? 0,
      // 顾客订的永远是这张桌的 1 号座，它代表整个可约单位。
      // 双人位有 2 个物理座，但后端标了 wholeTable，占一个座就锁全桌。
      seatNumber: 1,
      people: zoneOf(plan.zone)?.seatsPerUnit ?? 1,
      disabled: !table,
    }
  })
  return { seats }
}
