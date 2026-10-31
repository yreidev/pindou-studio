/**
 * 系统内收费开关的替身（hooks/billing）。页面里的 useBillingEnabled 读公开接口，单元测试不连接口：
 * 原有用例按「开着」测价格和结账，收费关着的用例显式传 false。
 */
export const billingMock = (enabled = true) => ({
  useBillingEnabled: () => enabled,
  useOrdersTabText: () => undefined,
})
