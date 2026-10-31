import { describe, expect, it } from 'vitest'
import { canConfirmChoice, customerChangeBlocker, customerChangedText, packageCustomerNote } from './customer'

const ready = {
  order: { status: 'draft' as const },
  packageOrder: false,
  sessionPending: false,
  dirty: false,
  conflict: false,
}

describe('结账页换顾客', () => {
  it('待结账、明细已保存、没有冲突时能换', () => {
    expect(customerChangeBlocker(ready)).toBe('')
  })

  it('不能换时说清为什么：已结账、套餐订单、会话没读到、版本冲突、明细没保存', () => {
    expect(customerChangeBlocker({ ...ready, order: { status: 'paid' } })).toBe('这张订单已经不是待结账状态')
    expect(customerChangeBlocker({ ...ready, packageOrder: true })).toBe(packageCustomerNote)
    expect(customerChangeBlocker({ ...ready, sessionPending: true })).toBe('正在读取计时会话…')
    expect(customerChangeBlocker({ ...ready, conflict: true })).toBe('订单已被修改，请先重新读取并核对')
    expect(customerChangeBlocker({ ...ready, dirty: true })).toBe('明细改过，请先保存明细再换顾客')
    // 套餐订单优先说明：重新读取、保存明细都换不了
    expect(customerChangeBlocker({ ...ready, packageOrder: true, conflict: true, dirty: true })).toBe(
      packageCustomerNote,
    )
  })

  it('没选人、选的就是现在这位，都不用提交', () => {
    expect(canConfirmChoice({ accountId: undefined }, null)).toBe(false)
    expect(canConfirmChoice({ accountId: 'u-li' }, { id: 'u-li' })).toBe(false)
    expect(canConfirmChoice({ accountId: 'u-li' }, { id: 'u-wang' })).toBe(true)
    expect(canConfirmChoice({ accountId: undefined }, { id: 'u-wang' })).toBe(true)
  })

  it('成功后的提示分绑定、更换、改散客', () => {
    expect(customerChangedText(undefined, 'u-li')).toBe('已绑定顾客账户，可以用会员结账')
    expect(customerChangedText('u-li', 'u-wang')).toBe('已更换顾客，会员优惠按新顾客重新计算')
    expect(customerChangedText('u-li', null)).toBe('已改为散客')
  })
})
