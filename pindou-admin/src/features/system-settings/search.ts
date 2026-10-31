import { z } from 'zod'

// 系统设置页的网址参数：哪一个标签页。刷新或从别的页面链过来（例如桌码页「去系统设置改」）时保持原样。

export type SystemSettingsTab = 'billing' | 'reservations' | 'code'

export const systemSettingsSearchSchema = z.object({
  tab: z.enum(['billing', 'reservations', 'code']).optional().catch(undefined),
})

export type SystemSettingsSearch = z.infer<typeof systemSettingsSearchSchema>

export const systemSettingsTabs: { key: SystemSettingsTab; label: string }[] = [
  { key: 'billing', label: '系统内收费' },
  { key: 'reservations', label: '营业与预约' },
  { key: 'code', label: '小程序码版本' },
]
