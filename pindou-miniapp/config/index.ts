import { defineConfig, type UserConfigExport } from '@tarojs/cli'
import path from 'node:path'
const modernSass = require('./modern-sass.cjs')
const makerChunk = require('./maker-chunk.cjs')
const blockScoping = require('./block-scoping.cjs')
const outputRoot = 'dist'

const config: UserConfigExport<'vite'> = {
  projectName: 'pindou-miniapp',
  date: '2026-09-04',
  designWidth: 750,
  deviceRatio: { 750: 1 },
  sourceRoot: 'src',
  outputRoot,
  framework: 'react',
  // 做图纸的分包单独拆块（见 maker-chunk.cjs）；
  // 产物里的 let / const 先自己转掉，免得微信上传时转 ES5 把变量盖掉（见 block-scoping.cjs）
  compiler: {
    type: 'vite',
    vitePlugins: [modernSass(), makerChunk(), blockScoping()],
  },
  plugins: [],
  defineConstants: {
    // 版本号从 package.json 来，和 `cli upload -v` 用的是同一个数字 ——
    // 2026-09-20 业主手机上跑着旧分包，页面上没有任何地方能看出这件事，
    // 只能靠「桌号显示成 A1 还是 1号桌」这种间接特征去猜。
    'process.env.TARO_APP_VERSION': JSON.stringify(require('../package.json').version),
    'process.env.TARO_APP_API_BASE': JSON.stringify(process.env.TARO_APP_API_BASE || 'http://127.0.0.1:8080/api/v2'),
    'process.env.TARO_APP_ADMIN_URL': JSON.stringify(process.env.TARO_APP_ADMIN_URL || ''),
    'process.env.TARO_APP_PRIVACY_VERSION': JSON.stringify(process.env.TARO_APP_PRIVACY_VERSION || 'wechat-privacy-v1'),
  },
  copy: {
    patterns: [
      {
        from: path.resolve(__dirname, '../src/sitemap.json'),
        to: `${outputRoot}/sitemap.json`,
      },
      // ★ 座位平面图留**主包**。它原本只有顾客预约页用过，所以跟着进了 pages/customer 分包；
      //   2026-09-19 布局固定化之后员工端桌位页也用同一张底图画热区（店员看到的位置就是
      //   顾客看到的位置），而**分包之间不能互相引用资源** —— 员工分包的页面去读顾客分包
      //   里的图，在顾客分包还没下载时就是一张白图，而且不报错。
      //   99 KB 进主包换两端共用，值得。
      {
        from: path.resolve(__dirname, '../src/assets/seatmap'),
        to: `${outputRoot}/assets/seatmap`,
      },
      // 抠图模型（试用，2026-10-22）随做图纸分包发；运行时用 readCompressedFile 解开（services/maker/cutout-device.ts）
      { from: path.resolve(__dirname, '../src/pages/maker/model'), to: `${outputRoot}/pages/maker/model` },
    ],
    options: {},
  },
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      cssModules: { enable: false },
    },
  },
}

export default defineConfig<'vite'>(config)
