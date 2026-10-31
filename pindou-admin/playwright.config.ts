import { defineConfig, devices } from '@playwright/test'

// 端到端测试跑在真正的 Go 后端上：页面由后端嵌入并带着生产的 CSP 提供，和线上同源同头。
// 后端用 cmd/pindou-dev：在测试库服务器（PINDOU_TEST_DATABASE_URL，make admin-e2e 会准备）上新建一个库，
// 假微信，退出时删库，绝不连到任何真实数据。
// pnpm e2e 会先构建并把产物复制进后端（scripts/embed.mjs），再由这里 go run 起服务。
const port = Number(process.env.PINDOU_ADMIN_E2E_PORT ?? 18080)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `go run ./cmd/pindou-dev -fresh -db pindou_e2e_${port}`,
    cwd: '../pindou-backend',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      PINDOU_HTTP_ADDRESS: `127.0.0.1:${port}`,
      PINDOU_DEV_DATABASE_URL: process.env.PINDOU_DEV_DATABASE_URL ?? process.env.PINDOU_TEST_DATABASE_URL ?? '',
      PINDOU_DEVELOPER_ACCOUNT_IDS: '',
      GOCACHE: process.env.GOCACHE ?? `${process.env.HOME}/.cache/pindou-go-build`,
    },
  },
})
