import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import { apiBase } from './api-base'

// 门店开关「系统内收费」（2026-10-10 起，老板在网页后台「系统设置」里开关）。关着时钱在美团、大众点评收：
// 顾客端套餐只写时长、底部「订单」换成「我的预约」；员工端不显示估算金额和「去结账」，用完点「结束」放座。
// 开关只以后端为准，页面按它显示，不往本机存。

export type BillingSettings = components['schemas']['BillingSettings']

export const billing = {
  /** 公开接口，没登录也能读。 */
  settings: async (): Promise<BillingSettings> => {
    const response = await Taro.request<BillingSettings>({
      url: `${apiBase.replace(/\/$/, '')}/system/billing-settings`,
      timeout: 15000,
    })
    if (response.statusCode !== 200) throw new Error('门店设置暂时无法加载')
    return response.data
  },
}

/** 底部第三格的名字：收费开着是「订单」，关着是「我的预约」（app.config.ts 里写的是关着时的名字）。 */
export const ordersTabText = (enabled: boolean) => (enabled ? '订单' : '我的预约')

/**
 * 「结束」放座前的确认（系统内收费关着时，店员点「结束」代替结账）：结束后会话不能恢复，座位立刻放出。
 * 微信确认按钮最多 4 个字。
 */
export const endConfirm = (what: string) => ({
  title: '结束并放座',
  content: `结束${what}并放出座位？结束后不能恢复，顾客还要用得重新开台。`,
  confirmText: '结束',
  cancelText: '取消',
})
