import { ApiError } from '../../api/client'
import { readableError } from '../operations/messages'

// 「系统设置 › 系统内收费」（后端迁移 024，接口 /system/billing-settings）。只有老板能改；
// 改的时候要看清后果、写原因、勾选确认，后端带上确认时看到的状态，被别人改过就 409。

export const maxReasonLength = 200

/** 两种状态下门店怎么用：卡片上和修改对话框里都按它说明。 */
export const billingModes = {
  off: {
    label: '关',
    color: 'grey',
    summary: '钱在美团、大众点评收，系统只管预约和计时。',
    effects: [
      '确认扫码入座、到店开台都不建订单；用完由店员点「结束」，计时停止、座位立刻放出。',
      '现场看板、桌位不显示估算金额和「去结账」；侧栏不显示「订单与退款」；套餐不显示价格，可以不填价。',
      '会员储值和积分照常，由员工在「会员资产」手动加减。',
    ],
  },
  on: {
    label: '开',
    color: 'green',
    summary: '在系统里结账收款，结账后才放座。',
    effects: [
      '确认扫码入座、到店开台时按套餐建待结账订单；结账收款后才放座，「结束」不再出现。',
      '现场看板显示估算金额和「去结账」，侧栏出现「订单与退款」；套餐显示价格。',
      '没填价格的套餐顾客看不到、员工不能用它开台：打开前先在「经营规则」给要卖的套餐填好价格。',
    ],
  },
} as const

export const modeOf = (enabled: boolean) => (enabled ? billingModes.on : billingModes.off)

/** 切换那一刻正在计时的台怎么办（行为按操作那一刻的开关，会话不记快照）。 */
export function switchNote(target: boolean): string {
  return target
    ? '打开后，正在计时的台也要结账才能放座。'
    : '关掉后，正在计时的台直接点「结束」放座；之前建的、还没收款的订单在结束时一并作废，已收过一部分钱的订单要先在结账页收齐或免单。'
}

export interface ToggleDraft {
  reason: string
  /** 勾了「我已看清后果」。 */
  acknowledged: boolean
}

/** 能不能提交：写了原因（不超过 200 字）、勾了确认。 */
export function canSubmit(draft: ToggleDraft): boolean {
  return missingStep(draft) === null
}

/** 提交按钮旁边说明还差什么。 */
export function missingStep(draft: ToggleDraft): string | null {
  const reason = draft.reason.trim()
  if (!reason) return '写明为什么改'
  if ([...reason].length > maxReasonLength) return `原因最多 ${maxReasonLength} 字`
  if (!draft.acknowledged) return '勾选确认已看清后果'
  return null
}

/** 保存失败的说明：被别人改过要重新确认。 */
export function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return '只有老板可以开关系统内收费。'
    if (error.code === 'billing_settings_conflict') return `${error.message}。已重新读取，请看清现在的状态后再决定。`
  }
  return readableError(error, '保存失败，没有修改，请稍后重试')
}
