import { vi } from 'vitest'

// 每个测试文件都先拿到 Taro 的默认替身（见 helpers/platform.ts）；用例要观察调用时自己换。
vi.mock('@tarojs/taro', async () => (await import('./helpers/platform')).taroDefaults())
vi.mock('@tarojs/components', async () => (await import('./helpers/platform')).componentDefaults())

// 真渲染（react-test-renderer）的用例用 act 推进；告诉 React 这是测试环境，别警告。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
