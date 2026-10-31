import type { Order } from '../../api/orders'

// 结账页的「顾客账户」：给待结账订单绑定、更换顾客，或改成散客（PATCH /sales-orders/{id}/customer），
// 规则同小程序结账页：
// - 只有待结账订单能换；会员扫码入座的套餐订单顾客由入座申请决定，不能换（后端同样会拒）；
// - 带读到的订单版本，409 保留选好的人，重新读取后由员工再确认；
// - 换人会让订单版本变化，之前算的会员报价随之作废，页面按新版本、新顾客重新报价；
// - 明细改过还没保存时先保存：换顾客成功后页面换成新版本的订单，没保存的明细会被替换。

export const packageCustomerNote = '这是会员扫码入座的套餐订单，顾客由入座申请决定，不能更换。'

export interface CustomerChangeState {
  order: Pick<Order, 'status'>
  /** 会员扫码入座的套餐订单。 */
  packageOrder: boolean
  /** 计时会话还没读到：先不给换（免得套餐单先闪出可换的入口）。 */
  sessionPending: boolean
  /** 明细改过还没保存。 */
  dirty: boolean
  /** 订单已被修改（409 或实时刷新到了新版本），要先重新读取。 */
  conflict: boolean
}

/** 现在为什么不能换顾客；能换返回空串。 */
export function customerChangeBlocker(state: CustomerChangeState): string {
  if (state.order.status !== 'draft') return '这张订单已经不是待结账状态'
  if (state.packageOrder) return packageCustomerNote
  if (state.sessionPending) return '正在读取计时会话…'
  if (state.conflict) return '订单已被修改，请先重新读取并核对'
  if (state.dirty) return '明细改过，请先保存明细再换顾客'
  return ''
}

/** 选好的人能不能提交：没选，或选的就是现在这位，都不用提交。 */
export function canConfirmChoice(order: Pick<Order, 'accountId'>, choice: { id: string } | null): boolean {
  return Boolean(choice) && choice?.id !== order.accountId
}

/** 换顾客成功后的提示。before、after 是换前换后的账户编号，散客为空。 */
export function customerChangedText(before: string | undefined, after: string | null): string {
  if (!after) return '已改为散客'
  return before ? '已更换顾客，会员优惠按新顾客重新计算' : '已绑定顾客账户，可以用会员结账'
}
