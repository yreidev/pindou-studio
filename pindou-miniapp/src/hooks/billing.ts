import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect } from 'react'
import { billing, ordersTabText } from '../services/billing'
import { usePublicQuery } from './query'

/**
 * 系统内收费开着没有。还没读到、读取失败时按关（和后端没设过时的默认一样）：
 * 宁可先不显示价格，也不要先显示再收起来。
 */
export function useBillingEnabled(): boolean {
  const settings = usePublicQuery(['billing-settings'], billing.settings)
  return settings.data?.enabled === true
}

/**
 * 底部栏四页（首页、图纸、订单/我的预约、我的）都调：按开关改第三格的名字。
 * setTabBarItem 只能在底部栏的页面上调，所以每次显示时再设一遍；没读到开关时不动（保持 app.config.ts 的「我的预约」）。
 */
export function useOrdersTabText() {
  const settings = usePublicQuery(['billing-settings'], billing.settings)
  const enabled = settings.data ? settings.data.enabled : null
  useEffect(() => setOrdersTab(enabled), [enabled])
  useDidShow(() => setOrdersTab(enabled))
}

function setOrdersTab(enabled: boolean | null) {
  if (enabled === null) return
  Taro.setTabBarItem({ index: 2, text: ordersTabText(enabled) }).catch(() => {
    // 不在底部栏页面上（例如分享进来的页面）时会失败，下次回到底部栏页面再设
  })
}
