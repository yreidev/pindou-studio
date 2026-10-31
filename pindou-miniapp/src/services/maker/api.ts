import Taro from '@tarojs/taro'
import type { components } from '../../api/schema'
import { apiBase } from '../api-base'
import { request } from '../staff'

// 「做图纸」的接口（docs/api.yaml 的 /bead-settings、/bead-patterns）。单独一个文件、不引色卡和算法：
// 底部「图纸」页（主包）和「本次手作」只要列表，不该把做图纸的分包内容带进去。

type Schemas = components['schemas']
export type BeadPatternSummary = Schemas['BeadPatternSummary']
export type BeadPatternList = Schemas['BeadPatternList']
export type BeadPattern = Schemas['BeadPattern']
export type BeadPatternInput = Schemas['BeadPatternInput']
export type BeadSettings = Schemas['BeadSettings']

const base = apiBase.replace(/\/$/, '')

export const beadApi = {
  /** 店里做图纸用的豆子：不用登录。 */
  settings: async (): Promise<BeadSettings> => {
    const response = await Taro.request<BeadSettings>({ url: `${base}/bead-settings`, timeout: 15000 })
    if (response.statusCode !== 200) throw new Error('店里的色卡暂时读不到')
    return response.data
  },
  list: () => request<BeadPatternList>('/bead-patterns'),
  get: (id: string) => request<BeadPattern>(`/bead-patterns/${encodeURIComponent(id)}`),
  save: (id: string, input: BeadPatternInput) =>
    request<BeadPattern>(`/bead-patterns/${encodeURIComponent(id)}`, 'PATCH', input),
  remove: (id: string) => request<void>(`/bead-patterns/${encodeURIComponent(id)}`, 'DELETE'),
}

/** 豆子多大（毫米）：mini 2.6、midi 5。 */
export const beadMillimetres = (size: BeadSettings['beadSize']) => (size === 'midi' ? 5 : 2.6)
