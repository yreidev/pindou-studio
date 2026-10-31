// 品牌文案。
//
// ★★ 这个文件同时是**字体子集的字符来源**（scripts/build-font-subset.mjs 把它整份读进去）。
//   用品牌字体渲染的位置 —— .navbar-title / .brand-slogan / 预约页的 .plan-title-text 与
//   .plan-footer / 首页和图纸页的栏目标题（.home-block-title、.patterns-heading）—— 只认这里出现过的字。把品牌话直接写进页面 tsx，打包出来那几个字会回落成
//   系统楷体，一行里两种字形，而且构建不报错。所以品牌文案一律经这里出。
//   改完要跑 `node scripts/build-font-subset.mjs` 重建子集，tests/font-subset.test.ts 会验覆盖。

/** 小程序名与无障碍标签用。与微信后台的小程序名称是两回事，改这里不影响后台。 */
export const brandName = 'EXAMPLE 示例工坊'
/** 品牌头（顾客端与员工端的 Screen brand）副行。 */
export const brandTagline = '一粒一份喜欢'
/** 预约选座页页脚。 */
export const brandSlogan = '把喜欢，拼成宝贝。'
/** 员工端页脚。品牌精神只给店员看 —— 顾客端已有三处品牌话，再多就腻。 */
export const brandSpirit = '认真生活，也认真玩玩。'

// 预约选座页的标题与副标题，来自门店海报「EXAMPLE示例工坊 拼豆预约选座图」。
export const seatMapTitle = '拼豆预约选座图'
export const seatMapSubtitle = '请选择喜欢的座位'

/** 图纸的栏目名：首页「本周上新」那一块和「图纸」页的页头都用它。 */
export const patternColumn = '今天来示例工坊拼什么？'
/** 首页「今天还能约」那一块的标题。 */
export const todaySlotsTitle = '今天还能约'

/**
 * 夜间时段的活动名。
 *
 * ★ 这不是一个新功能，只是给**已经存在的晚间时段**贴个名字：预约抽屉里
 *   18:00 及以后开始的时段会带上这个标签。门店的营业时间由后端 reservationSettings
 *   的 openMinute/closeMinute 决定，这里不参与排时段，只负责怎么叫它。
 */
export const nightSchoolName = '示例工坊夜校'
/** 几点之后算夜校。门店本地时间（UTC+8）的整点。 */
export const nightSchoolFromHour = 18

/**
 * 会员体系的名字。
 *
 * ★ 只替换「会员中心」这个**入口与页名**。「普通会员」那个**等级名**不动 ——
 *   它在会员页和身份浮标里承担的是等级语义，改成「示例工坊社成员」会和页名打架。
 */
export const membershipName = '示例工坊社'

/** 创建账号页的大标题（品牌字体）。 */
export const firstVisitTitle = '第一次来示例工坊'

/** 会员储值消费登记与认领页面的标题。 */
export const memberConsumptionTitle = '消费登记'
export const memberAccountTitle = '代开会员'
export const memberClaimTitle = '认领会员'

/** 消息与认领成功页的品牌文案。 */
export const messagesTitle = '消息'
export const consumptionDetailTitle = '消费详情'
export const entryDetailTitle = '记录详情'
export const memberWelcome = '欢迎回来，'
