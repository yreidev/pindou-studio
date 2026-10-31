import { brandName } from '../brand'
import { slotParam, storeClock, storeDate } from './reservations'

// 转发给朋友、分享到朋友圈（方案见 docs/plan-notify-and-share.md 第 1 节，2026-10-20 业主定）。
// 只开首页、图纸页、图纸详情、预约座位四页；朋友圈不开预约座位（朋友圈里打开的小程序功能受限，约座要登录）。
// 卡片只带「打开哪一页」：不带转发人的账户、桌码、预约编号。卡片图不给时微信用页面截图，朋友圈默认用小程序头像。
//
// ★ 页面配置里要同时写 enableShareAppMessage / enableShareTimeline，Taro 才会给小程序页面挂上
//   onShareAppMessage / onShareTimeline；只写 useShareAppMessage，右上角菜单里照样没有「转发」。

export type ShareCard = { title: string; path: string; imageUrl?: string }
export type TimelineCard = { title: string; query?: string; imageUrl?: string }

const home = '/pages/index/index'
const patterns = '/pages/patterns/index'
const pattern = '/pages/customer/pattern/index'
const reservations = '/pages/customer/reservations/index'

const homeTitle = `${brandName} · 约上朋友来拼豆`

export const homeShare = (): ShareCard => ({ title: homeTitle, path: home })
export const homeTimeline = (): TimelineCard => ({ title: homeTitle })

const patternsTitle = '示例工坊的图纸，挑一张一起拼'
// 店里还没有上架的图纸时这一页只有做图纸（见 pages/patterns/index.tsx），卡片按做图纸说
const makerTitle = '在示例工坊把照片做成拼豆图纸'
/** 图纸页：带着正在看的分类（「全部」不带）；朋友打开时分类停用了就回到「全部」。 */
const patternsQuery = (filter: string) => (filter && filter !== 'all' ? `category=${encodeURIComponent(filter)}` : '')

export function patternsShare(filter: string, storePatterns = true): ShareCard {
  const query = storePatterns ? patternsQuery(filter) : ''
  return { title: storePatterns ? patternsTitle : makerTitle, path: query ? `${patterns}?${query}` : patterns }
}
export const patternsTimeline = (filter: string, storePatterns = true): TimelineCard => ({
  title: storePatterns ? patternsTitle : makerTitle,
  query: storePatterns ? patternsQuery(filter) : '',
})

type SharedPattern = { id: string; name: string; thumbnailUrl: string }

/** 图纸详情：卡片图和朋友圈的方图都用这张图纸的缩略图（JPEG）。 */
export const patternShare = (item: SharedPattern): ShareCard => ({
  title: `一起拼这张：${item.name}`,
  path: `${pattern}?id=${encodeURIComponent(item.id)}`,
  imageUrl: item.thumbnailUrl,
})
export const patternTimeline = (item: SharedPattern): TimelineCard => ({
  title: `一起拼这张：${item.name}`,
  query: `id=${encodeURIComponent(item.id)}`,
  imageUrl: item.thumbnailUrl,
})

/**
 * 预约座位：选了几点就带上这个时段（?at=，同首页「今天还能约」进来的），朋友打开时站在那天、按那个时段亮座位；
 * 没选时段带上正在看的日期（?date=）。标题写绝对日期：朋友可能隔天才点开，「今天」「明天」会说错。
 */
export function reservationShare(start: Date | null, day: string): ShareCard {
  if (start) {
    const date = storeDate(0, start)
    return {
      title: `${date.month} 月 ${date.day} 日 ${storeClock(start)} 还有空位，一起来拼豆`,
      path: `${reservations}?at=${slotParam(start)}`,
    }
  }
  return { title: `${brandName} · 选个座位一起来`, path: day ? `${reservations}?date=${day}` : reservations }
}
