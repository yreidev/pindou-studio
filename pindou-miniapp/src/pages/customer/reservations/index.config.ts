export default definePageConfig({
  navigationStyle: 'custom',
  enablePullDownRefresh: true,
  // 右上角「转发」（docs/plan-notify-and-share.md 第 1 节）；不开朋友圈：朋友圈里打开的小程序功能受限，约座要登录
  enableShareAppMessage: true,
})
