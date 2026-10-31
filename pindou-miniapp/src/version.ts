/**
 * 小程序版本号，构建时从 package.json 注入（config/index.ts 的 defineConstants），
 * 和 `cli upload -v` 用的是同一个数字。
 *
 * ★ 显示在「我的」和员工工作台的页脚。2026-09-20 业主手机上跑着缓存的旧分包，
 *   页面上没有任何地方能看出来，只能靠「桌号显示成 A1 还是 1号桌」这种间接特征猜。
 *   排查「这是不是新版」应当是一眼的事。
 *
 * ★★ 单独一个模块，不放 brand.ts —— 那个文件是**字体子集的取字来源**
 *    （scripts/build-font-subset.mjs 从它全文收字），版本号不是品牌字体渲染的文案，
 *    进去只会白白撑大内嵌字体。
 */
export const appVersion = process.env.TARO_APP_VERSION || '开发版'
