import { readFileSync } from 'node:fs'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { searchForWorkspaceRoot } from 'vite'
import { defineConfig } from 'vitest/config'

// 开发时把接口与实时事件流代理到本机后端（make backend-dev，默认 127.0.0.1:8080）。
// 生产构建产物编进网页后台服务（pindou-backend/cmd/pindou-admin-web），Traefik 把同域名的 /api/ 转给后端，不需要代理。
const backend = process.env.PINDOU_ADMIN_BACKEND ?? 'http://127.0.0.1:8080'
// 网页后台自己的版本（package.json，发版打 admin-v 标签）和构建它的 commit（make admin-binary 传进来，本机是 dev），
// 显示在首页；后端的版本另读 /healthz（docs/plan-split-release.md）。
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react()],
  define: {
    __ADMIN_VERSION__: JSON.stringify(version),
    __ADMIN_COMMIT__: JSON.stringify(process.env.PINDOU_ADMIN_COMMIT || 'dev'),
  },
  server: {
    // 「现场」看板的平面图直接用仓库里的唯一一份：门店布局 layout/store-layout.json 与小程序的底图
    // pindou-miniapp/src/assets/seatmap/plan.jpg（src/features/board/layout.ts 引用），不复制进这里；
    // 「首页内容 › 做图纸用的豆子」的色卡同理用仓库根的 palettes/palettes.json（src/features/storefront/beads.ts）。
    // 开发服务器默认只放行本目录，这几处要另外放行；构建时照常打包进产物。
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        '../layout/store-layout.json',
        '../pindou-miniapp/src/assets/seatmap/plan.jpg',
        '../palettes/palettes.json',
      ],
    },
    proxy: {
      '/api': { target: backend, ws: true, changeOrigin: false },
      '/healthz': backend,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rolldownOptions: {
      // Semi 的总入口牵出 AI 对话、代码高亮等用不到的依赖，摇树后不进产物，但打包时会报
      // 直接 eval、模块级指令的警告；只滤掉依赖里的这两类，自己的代码照常报。
      onwarn(warning, warn) {
        const fromDependency = (warning.id ?? warning.loc?.file ?? '').includes('node_modules')
        if (fromDependency && (warning.code === 'EVAL' || warning.code === 'MODULE_LEVEL_DIRECTIVE')) return
        warn(warning)
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // 单条测试默认 5 秒，带 Semi 组件的用例在 CI 机器忙时会超；放宽到 20 秒，只是上限
    testTimeout: 20_000,
  },
})
