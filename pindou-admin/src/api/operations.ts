import { saveBlob } from '../lib/download'
import { client, read, readPage, type Page, type Schemas } from './client'
import type { components } from './schema'

// 运营与系统：报表导出、数据导出、审计（/reports/exports、/system/*）。
// 报表与审计店长、老板可用；全部数据导出只有老板。权限都由后端校验。

/** movements 是库存流水（按发生日期）；inventory 是导出时的库存数量（不按日期）。 */
export type ExportKind = components['parameters']['ExportKind']

/** 审计记录。accountId 是操作人，初始化老板这类系统动作记为 system；actor 是操作人的称呼（系统操作或账户不在了为 null）。 */
export type AuditEvent = Schemas['AuditEvent']

export interface AuditListParams {
  q?: string
  /** 中文动作名含关键字的动作代码（中文名只在网页端）。 */
  actions: string[]
  page: number
  pageSize: number
}

/** 门店日期（YYYY-MM-DD，含当天），不填就不限。 */
export interface DateRange {
  from?: string
  to?: string
}

/** 取 Excel 报表：日期只带填了的。 */
const exportFile = (kind: ExportKind, range: DateRange) =>
  read(
    client.GET('/reports/exports/{kind}', {
      params: { path: { kind }, query: { from: range.from || undefined, to: range.to || undefined } },
      parseAs: 'blob',
    }),
  )

export const operationsApi = {
  exportFile,
  /** 下载 Excel 报表到电脑。 */
  downloadExport: async (kind: ExportKind, range: DateRange, filename: string) =>
    saveBlob(await exportFile(kind, range), filename),
  /** 下载当前全部数据的 JSON（含完整手机号，后端记审计）。每次都是新的一份，重复点击靠按钮在请求期间禁用来挡。 */
  downloadData: async (filename: string) =>
    saveBlob(await read(client.POST('/system/data-exports', { parseAs: 'blob' })), filename),
  /** 审计按页取，新的在前；q 由服务端匹配原因、编号与操作人，actions 是按中文动作名对上的动作代码。 */
  listAudit: (params: AuditListParams, signal?: AbortSignal): Promise<Page<AuditEvent>> =>
    readPage(
      client.GET('/system/audit-events', {
        params: {
          query: {
            page: params.page,
            pageSize: params.pageSize,
            q: params.q || undefined,
            actions: params.actions.join(',') || undefined,
          },
        },
        signal,
      }),
      params.page,
    ),
}
