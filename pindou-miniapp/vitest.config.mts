import { defineConfig } from 'vitest/config'

// 小程序的单元测试：服务、hook 与页面的处理逻辑，跑在 Node 里，不起浏览器、不连开发者工具。
// 界面以微信开发者工具 / 真机验收为准（见 docs/development.md「代码验证」），这里替代不了。
//
// ★ Vitest 固定在 4.x：5.x 把 vite 改成了必须由项目自己装的 peer 依赖（^6.4 起），而 Taro 4 的
//   构建链要求顶层是 vite 4；4.x 自带一份 vite，和 Taro 的那份互不干扰。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // 构建时由 Taro 注入的环境变量，测试里给出微信端的值
    env: { TARO_ENV: 'weapp' },
  },
})
