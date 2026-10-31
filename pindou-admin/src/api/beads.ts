import { queryOptions } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'

// 做图纸用的豆子（迁移 027，方案见 docs/plan-bead-maker.md）：店里用哪套色卡、店里有哪些颜色、盒号、底板、豆子大小。
// 顾客「做图纸」拿它当默认值和提示，不限制顾客选别的。所有员工都能改；整份替换，带读到的修订号，别人先改了回 409。
// 推送的资源名是 bead-settings。

export type BeadSettings = Schemas['BeadSettings']
export type BeadSettingsInput = Schemas['BeadSettingsInput']

export const beadSettingsApi = {
  get: (signal?: AbortSignal) => read(client.GET('/bead-settings', { signal })),
  save: (body: BeadSettingsInput) => read(client.PATCH('/bead-settings', { body })),
}

export function beadSettingsQuery() {
  return queryOptions({ queryKey: ['bead-settings'], queryFn: ({ signal }) => beadSettingsApi.get(signal) })
}
