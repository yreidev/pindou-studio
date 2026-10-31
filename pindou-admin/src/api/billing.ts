import { queryOptions, useQuery } from '@tanstack/react-query'
import { client, read, type Schemas } from './client'

// 门店开关「系统内收费」（/system/billing-settings，后端迁移 024）。门店的钱都在美团、大众点评收时关着：
// 不建单不结账，店员点「结束」放座；网页后台据此藏起订单、结账、估算金额和套餐价格。开着时照以前。
// 开关以接口为准，不在本地存；老板在「系统设置」页改。

export type BillingSettings = Schemas['BillingSettings']
export type BillingSettingsInput = Schemas['BillingSettingsInput']

export const billingApi = {
  get: (signal?: AbortSignal) => read(client.GET('/system/billing-settings', { signal })),
  /** 只有老板能改；带确认时看到的状态，被别人改过回 409 billing_settings_conflict。 */
  save: (body: BillingSettingsInput) => read(client.PATCH('/system/billing-settings', { body })),
}

/** 推送的资源名是 billing-settings：别的老板改了，这里跟着重读。 */
export function billingSettingsQuery() {
  return queryOptions({ queryKey: ['billing-settings'], queryFn: ({ signal }) => billingApi.get(signal) })
}

/**
 * 系统内收费开着没有。没读到（读取中、失败）时按关：现在门店不在系统里收钱，宁可少显示收费入口；
 * 收费入口藏了照样能从地址进，后端也不因开关拦结账。
 */
export function useBillingEnabled(): boolean {
  return useQuery(billingSettingsQuery()).data?.enabled === true
}
