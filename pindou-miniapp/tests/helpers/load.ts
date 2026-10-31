import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { componentDefaults, taroDefaults } from './platform'

/** 小程序源码目录（pindou-miniapp/src）。 */
export const src = fileURLToPath(new URL('../../src/', import.meta.url))
/** 小程序目录（pindou-miniapp）。 */
export const root = fileURLToPath(new URL('../../', import.meta.url))

const candidates = ['', '.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx']
const exists = (file: string) => candidates.some((ext) => fs.existsSync(file + ext) && fs.statSync(file + ext).isFile())

/**
 * 替身表里的相对说明符按被装载文件所在目录解析，和源码里 import 写的一致。
 *
 * ★ 层数写错时退回 src 下的同名路径：2026-09-19 分包时顾客页从 src/pages/xxx/ 搬进
 *   src/pages/customer/xxx/，import 从 '../../components/button' 变成 '../../../components/button'，
 *   测试挂的不该是**目录深度**。这些替身指向的都是 src 下的顶层目录（components/ hooks/ services/ …），
 *   剥掉前缀的 `../` 再找一次，语义不丢，深度无关。
 */
function resolveSpecifier(from: string, name: string) {
  if (!name.startsWith('.')) return name
  const direct = path.resolve(from, name)
  if (exists(direct)) return direct
  const fallback = path.resolve(src, name.replace(/^(?:\.\.?\/)+/, ''))
  return exists(fallback) ? fallback : direct
}

/**
 * 替身写成和 TypeScript 的 CommonJS 互操作一样：值不是对象时当默认导出；对象没写 default 时，
 * 默认导出就是对象本身（`import Taro from '@tarojs/taro'` 拿到的是整个替身）。
 */
function asModule(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { default: value }
  return 'default' in value ? (value as Record<string, unknown>) : { default: value, ...value }
}

const defaults: Record<string, () => Record<string, unknown>> = {
  '@tarojs/taro': taroDefaults,
  '@tarojs/components': componentDefaults,
}

// 上一次装载换掉的依赖（解析后的路径）
let replaced = new Set<string>()

/**
 * 装载 src 下的一个模块，依赖按「说明符 → 替身」换掉（vi.doMock）。每次都是新的模块实例：
 * 模块级状态（登录目标、离开保护、在途的请求）不会从上一个用例漏过来。
 * 没列出的依赖用真的；Taro 两个包没列出时用 tests/helpers/platform.ts 的默认替身。
 */
export async function load<T = any>(file: string, mocks: Record<string, unknown> = {}): Promise<T> {
  vi.resetModules()
  const target = path.resolve(src, file)
  const from = path.dirname(target)
  const next = new Map(Object.entries(mocks).map(([name, value]) => [resolveSpecifier(from, name), value]))
  // 上一次的替身这次不再用：恢复成默认或真的模块。
  // ★ 不能在上一次装载结束时就恢复：doMock / doUnmock 进的是同一个队列，到下一次 import 时
  //   才按路径异步解析、登记，同一个路径排着两项时谁后登记谁赢，替身会时有时无。
  //   所以每个路径每次只排一项。
  for (const id of replaced) {
    if (next.has(id)) continue
    if (id in defaults) vi.doMock(id, defaults[id])
    else vi.doUnmock(id)
  }
  for (const [id, value] of next) vi.doMock(id, () => asModule(value))
  replaced = new Set(next.keys())
  return (await import(/* @vite-ignore */ target)) as T
}
