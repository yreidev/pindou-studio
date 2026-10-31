import { queryOptions } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'

// 桌码：桌位列表（/service-tables）、区域名称（/floor-areas）、微信小程序码（/loyalty/table-code），
// 以及小程序码指向的版本和网页桌码印的地址（/system/code-settings）。

export type FloorArea = Schemas['FloorArea']

/**
 * 桌位。这一页只用到身份和启停；计时字段由桌位页面用。code 是布局里的稳定编码（A1、B3…），桌号只在区域内唯一；
 * wholeTable 表示整张桌一次只卖给一组客人（A 区双人位）。
 */
export type ServiceTable = Schemas['ServiceTable']

/** 小程序码（桌码、网页后台登录码）指向的小程序版本，和网页桌码印的地址（来自部署配置，只读）。 */
export type CodeSettings = Schemas['CodeSettings']
export type MiniProgramEnv = CodeSettings['envVersion']
export type CodeSettingsInput = Schemas['CodeSettingsInput']

export const tableCodesApi = {
  listTables: (signal?: AbortSignal) => read(client.GET('/service-tables', { signal })),
  listAreas: (signal?: AbortSignal) => read(client.GET('/floor-areas', { signal })),
  /**
   * 生成一张桌的微信小程序码（PNG/JPEG data URL）。后端会请求微信，单张可能要几秒；
   * 停用或不存在的桌回 404，微信未配置或生成失败回 503 并带上微信的原因。
   */
  tableCode: async (tableId: string, signal?: AbortSignal) =>
    (await read(client.GET('/loyalty/table-code', { params: { query: { tableId } }, signal }))).imageDataUrl,
}

export const codeSettingsApi = {
  get: (signal?: AbortSignal) => read(client.GET('/system/code-settings', { signal })),
  /** 只有老板能改；后端先用新版本试生成桌码和登录码，微信不收回 409 code_check_failed，不保存。 */
  save: (body: CodeSettingsInput) => read(client.PATCH('/system/code-settings', { body })),
}

/** 推送的资源名是 code-settings：别的老板改了，这里跟着重读。 */
export function codeSettingsQuery() {
  return queryOptions({ queryKey: ['code-settings'], queryFn: ({ signal }) => codeSettingsApi.get(signal) })
}
