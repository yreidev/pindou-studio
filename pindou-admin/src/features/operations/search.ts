import { z } from 'zod'

// 运营与系统页的网址参数：标签页、导出日期、审计搜索与页码。刷新或把网址发给别人时保持原样。

export type OperationsTab = 'export' | 'audit' | 'data'

export const operationsSearchSchema = z.object({
  tab: z.enum(['export', 'audit', 'data']).optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
})

export type OperationsSearch = z.infer<typeof operationsSearchSchema>

/** 能看到的标签页：导出和审计给店长、老板；备份只给老板。 */
export function operationsTabs(isOwner: boolean): { key: OperationsTab; label: string }[] {
  return [
    { key: 'export', label: '报表导出' },
    { key: 'audit', label: '审计记录' },
    ...(isOwner ? [{ key: 'data' as const, label: '数据导出' }] : []),
  ]
}

/** 网址里的标签页当前不可见（例如店长打开了老板发来的数据导出链接）时回到导出。 */
export function currentTab(tab: OperationsTab | undefined, isOwner: boolean): OperationsTab {
  return operationsTabs(isOwner).some((item) => item.key === tab) ? (tab as OperationsTab) : 'export'
}
