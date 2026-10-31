import { brandName } from './brand'
import { nativeColors } from './theme'

const staffPackages = [
  {
    root: 'pages/staff',
    pages: [
      'membership/index',
      'workbench/index',
      // 开台、会话是桌位页的底部弹层（2026-10-20），不再有单独的页面
      'tables/index',
      'orders/index',
      'checkout/index',
      'reservations/index',
      // 代客登记（2026-10-20 从预约页拆出来）
      'booking/index',
      // 连电脑：扫码登录电脑、手机当扫码枪（扫码给电脑，2026-10-06）、全部退出，2026-10-20 合成一页
      'web-login/index',
      // 收货入库（2026-10-06）：货到时在手机上扫条码入库
      'receiving/index',
    ],
  },
  {
    root: 'pages/developer',
    pages: ['index'],
  },
]

// 做图纸（2026-10-21，docs/plan-bead-maker.md）：色卡数据和转图算法都在这个分包里，主包只有入口
const makerPackage = {
  root: 'pages/maker',
  pages: ['mine/index', 'photo/index', 'pattern/index', 'import/index'],
}

export default defineAppConfig({
  resizable: true,
  pages: [
    'pages/index/index',
    'pages/patterns/index',
    'pages/orders/index',
    'pages/profile/index',
    'pages/register/index',
  ],
  // ★ 分包（2026-09-19）。微信的规则：**主包只装启动就要用的东西**，分包在用户第一次
  //   进入该分包的页面时才下载。主包越小，冷启动的下载等待越短。
  //
  //   root 是**目录前缀**，pages 是相对 root 的路径 —— 拼起来必须和原来的页面路径
  //   一字不差，否则所有 navigateTo 字面量、navigation.ts 的白名单、测试全要跟着改。
  //   staff / developer 正好已经自成一级，一个文件都没搬；顾客那 7 个页面原来平铺在
  //   pages/ 下，是搬进 pages/customer/ 之后才能成包的，所以它们的完整路径**变了**
  //   （/pages/membership/index → /pages/customer/membership/index），全项目的
  //   navigateTo 字面量、navigation.ts 白名单与兜底表、测试里的路由一起改过。
  //
  // ★ 为什么 tabBar 的四页（index/patterns/orders/profile）和 register 必须留主包：
  //   tabBar 页面微信要求在主包；register 是未登录用户的落点，进分包等于让新用户
  //   在注册前先下一个包。
  //
  // ★ 不要加 mini.optimizeMainPackage：那是 webpack 编译器的能力，本项目用的是 vite
  //   编译器（config/index.ts 里 compiler.type = 'vite'），@tarojs/vite-runner 里
  //   根本没有实现，配了也不会生成 sub-vendors/sub-common。
  subPackages: [
    {
      root: 'pages/customer',
      pages: [
        'membership/index',
        'messages/index',
        'consumption-detail/index',
        'member-claim/index',
        'experience/index',
        'reservations/index',
        'my-reservations/index',
        'order-detail/index',
        'profile-edit/index',
        // 图纸详情（2026-10-20）：从底部「图纸」和首页「本周上新」点进来
        'pattern/index',
      ],
    },
    makerPackage,
    ...staffPackages,
  ],
  // 分包预下载。分包本身是「进去才下」，那第一次点「预约座位」的人就要在按钮上
  // 等一次下载。preloadRule 让它在指定页面**渲染完之后**于后台下载，用户点进去时
  // 通常已经到位了 —— 省的是等待，不是流量。
  //
  // 首页和「我的」只预载 pages/customer：首页的主入口（手作/预约/会员/图纸详情）和
  // 「我的」里的几个入口全在这个分包里，几乎人人都会进。底部「图纸」另外预载做图纸的 pages/maker。
  // ★ 故意不预载 pages/staff：它只有店员用得到，给每位顾客白下 144 KB 不划算；
  //   店员从「我的」点进工作台时再下，一次而已。pages/developer 同理。
  preloadRule: {
    'pages/index/index': { network: 'all', packages: ['pages/customer'] },
    // 底部「图纸」顶上就是「用照片做图纸」「我的图纸」，看图纸的人多半会点进去
    'pages/patterns/index': { network: 'all', packages: ['pages/customer', 'pages/maker'] },
    'pages/profile/index': { network: 'all', packages: ['pages/customer'] },
  },
  window: {
    navigationBarTitleText: brandName,
    pageOrientation: 'auto',
    navigationStyle: 'custom',
    // 状态栏的字（时间、电量）：微信默认白字，浅色顶栏上看不见。深色顶栏的页面由 Screen 换成白字
    navigationBarTextStyle: 'black',
    backgroundColor: '#f7f5f0',
    backgroundTextStyle: 'dark',
  },
  tabBar: {
    color: '#706b62',
    selectedColor: '#806539',
    backgroundColor: nativeColors.surface,
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/index/index',
        text: '首页',
        iconPath: 'assets/staff/home.png',
        selectedIconPath: 'assets/staff/home-active.png',
      },
      {
        pagePath: 'pages/patterns/index',
        // 店里一张上架的图纸都没有时叫「做图纸」，只放做图纸的入口；首页、图纸页读到有图纸后由 usePatternsTabText
        // 改成「图纸」（2026-10-28 业主定，docs/plan-home-and-patterns.md）。默认写「做图纸」，没图纸时打开不会先闪出「图纸」。
        text: '做图纸',
        iconPath: 'assets/staff/patterns.png',
        selectedIconPath: 'assets/staff/patterns-active.png',
      },
      {
        pagePath: 'pages/orders/index',
        // 默认按系统内收费关着写；开着时页面显示后由 useOrdersTabText 改成「订单」
        text: '我的预约',
        iconPath: 'assets/staff/orders.png',
        selectedIconPath: 'assets/staff/orders-active.png',
      },
      {
        pagePath: 'pages/profile/index',
        text: '我的',
        iconPath: 'assets/staff/profile.png',
        selectedIconPath: 'assets/staff/profile-active.png',
      },
    ],
  },
  sitemapLocation: 'sitemap.json',
})
