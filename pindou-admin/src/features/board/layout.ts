// 门店平面图：底图和座位热区都只有一份——仓库根的 layout/store-layout.json（门店布局的唯一真相，
// 后端 go:embed 同一份并按它校正桌位）与小程序的底图 pindou-miniapp/src/assets/seatmap/plan.jpg。
// 网页直接从仓库里引用，不复制进 pindou-admin：开发服务器靠 vite.config.ts 的 server.fs.allow 放行，
// 构建时图片打包成 assets/plan-<哈希>.jpg，随页面一起嵌进后端（同源，CSP 的 img-src 'self' 放行）。
//
// 坐标是底图的像素坐标，显示时按百分比换算（同小程序 reservations、tables 页的 boxOf），
// 所以图怎么缩放热区都对得上。
import layout from '../../../../layout/store-layout.json'

/** 底图尺寸（像素），座位热区按它换算成百分比。 */
export const planSize = { width: layout.plan.width, height: layout.plan.height }

/** 底图上画出的一个座位：code 是布局里的稳定编码（A1、B3…），桌位接口按它对位。 */
export interface PlanSeat {
  code: string
  zone: string
  x: number
  y: number
  w: number
  h: number
}

/** 底图上的座位，顺序即布局文件里的顺序。 */
export const planSeats: PlanSeat[] = layout.tables.map((table) => ({
  code: table.code,
  zone: table.zone,
  ...table.hotspot,
}))

/** 分区字母 → 名称（「A 区」）。 */
export const zoneNames: ReadonlyMap<string, string> = new Map(layout.zones.map((zone) => [zone.key, zone.name]))

const pct = (value: number, total: number) => `${((value / total) * 100).toFixed(3)}%`

/** 热区在底图上的位置，百分比。 */
export function boxOf(seat: Pick<PlanSeat, 'x' | 'y' | 'w' | 'h'>) {
  return {
    left: pct(seat.x, planSize.width),
    top: pct(seat.y, planSize.height),
    width: pct(seat.w, planSize.width),
    height: pct(seat.h, planSize.height),
  }
}
