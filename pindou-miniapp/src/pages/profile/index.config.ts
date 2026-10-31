// 顶栏是深色的：状态栏一进来就是白字（app.config 默认黑字）
export default definePageConfig({
  navigationStyle: 'custom',
  navigationBarTextStyle: 'white',
  enablePullDownRefresh: true,
})
