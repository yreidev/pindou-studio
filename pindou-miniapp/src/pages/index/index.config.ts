export default definePageConfig({
  navigationStyle: 'custom',
  // 顶栏是深色的：状态栏一进来就是白字（app.config 默认黑字）
  navigationBarTextStyle: 'white',
  enablePullDownRefresh: true,
  // 右上角「转发」「分享到朋友圈」（docs/plan-notify-and-share.md 第 1 节）
  enableShareAppMessage: true,
  enableShareTimeline: true,
})
