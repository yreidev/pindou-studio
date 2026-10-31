import { describe, expect, it } from 'vitest'
import { canComp, compAmount, compBlocker, compConfirmContent, compFormSchema } from './comp'

describe('免单', () => {
  it('只有店长、老板看得到入口（后端照样校验）', () => {
    expect(canComp({ roles: ['manager'] })).toBe(true)
    expect(canComp({ roles: ['owner'] })).toBe(true)
    expect(canComp({ roles: ['clerk'] })).toBe(false)
  })

  it('必须写原因，最多 200 字', () => {
    expect(compFormSchema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(compFormSchema.safeParse({ reason: '老顾客生日' }).success).toBe(true)
    expect(compFormSchema.safeParse({ reason: '字'.repeat(201) }).success).toBe(false)
  })

  it('按钮为什么点不动：不是待结账、订单变了、明细没保存、应收为 0', () => {
    const order = { status: 'draft' as const, receivableCents: 3490, outstandingCents: 3490 }
    expect(compBlocker({ order, dirty: false, conflict: false })).toBe('')
    expect(compBlocker({ order: { ...order, status: 'paid' }, dirty: false, conflict: false })).toBe(
      '这张订单已经不是待结账状态',
    )
    expect(compBlocker({ order, dirty: false, conflict: true })).toBe('订单已被修改，请先重新读取并核对')
    expect(compBlocker({ order, dirty: true, conflict: false })).toBe('明细改过，请先保存并核对金额')
    expect(
      compBlocker({ order: { ...order, receivableCents: 0, outstandingCents: 0 }, dirty: false, conflict: false }),
    ).toContain('应收是 0，不用免单')
  })

  it('部分付款的单可以对剩余免单，免掉的是接口给的还差的数', () => {
    const partial = { status: 'partially_paid' as const, receivableCents: 10000, outstandingCents: 6000 }
    expect(compBlocker({ order: partial, dirty: false, conflict: false })).toBe('')
    expect(compAmount(partial)).toBe(6000)
    // 重放旧响应没有 outstandingCents：草稿按应收
    expect(compAmount({ status: 'draft', receivableCents: 3490 })).toBe(3490)
  })

  it('确认框写清免掉多少、后果和原因；对剩余免单另写已收多少', () => {
    expect(
      compConfirmContent(
        { status: 'draft', receivableCents: 3490, outstandingCents: 3490, paidCents: 0 },
        ' 老顾客生日 ',
      ),
    ).toBe(
      '这一单应收 ¥34.90 将记为免单，直接结清、实收 0：商品照常出库，计时随之结束；之后不能退款，也不能改回收款。原因：老顾客生日',
    )
    expect(
      compConfirmContent(
        { status: 'partially_paid', receivableCents: 10000, outstandingCents: 6000, paidCents: 4000 },
        '朋友没带钱',
      ),
    ).toBe(
      '这一单应收 ¥100.00，已收 ¥40.00；剩余 ¥60.00 将记为免单，直接结清：计时随之结束，免掉的部分不能退款，也不能改回收款；已收的钱照常记账、之后可以按笔退。原因：朋友没带钱',
    )
  })
})
