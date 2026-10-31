import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { canSubmit, missingStep, modeOf, saveErrorMessage, switchNote, type ToggleDraft } from './billing'

const draft = (overrides: Partial<ToggleDraft>): ToggleDraft => ({
  reason: '门店的钱都在美团、大众点评收',
  acknowledged: true,
  ...overrides,
})

describe('系统内收费开关', () => {
  it('写了原因、勾了确认才能提交，并说清还差哪一步', () => {
    expect(canSubmit(draft({}))).toBe(true)
    expect(missingStep(draft({}))).toBeNull()
    const cases: [Partial<ToggleDraft>, string][] = [
      [{ reason: '   ' }, '写明为什么改'],
      [{ reason: '字'.repeat(201) }, '原因最多 200 字'],
      [{ acknowledged: false }, '勾选确认已看清后果'],
    ]
    for (const [overrides, step] of cases) {
      expect(canSubmit(draft(overrides))).toBe(false)
      expect(missingStep(draft(overrides))).toBe(step)
    }
    expect(canSubmit(draft({ reason: '😀'.repeat(200) }))).toBe(true)
  })

  it('两种状态各自说明门店怎么用，切换时说清正在计时的台', () => {
    expect(modeOf(false).label).toBe('关')
    expect(modeOf(true).label).toBe('开')
    expect(modeOf(false).effects.join('')).toContain('「结束」')
    expect(modeOf(true).effects.join('')).toContain('结账收款后才放座')
    expect(switchNote(false)).toContain('已收过一部分钱的订单')
    expect(switchNote(true)).toBe('打开后，正在计时的台也要结账才能放座。')
  })

  it('保存失败照实说明，被别人改过要重新确认', () => {
    expect(saveErrorMessage(new ApiError(403, 'forbidden', 'forbidden'))).toBe('只有老板可以开关系统内收费。')
    expect(
      saveErrorMessage(new ApiError(409, 'billing_settings_conflict', '系统内收费刚被别人改成了开，请刷新后重新确认')),
    ).toBe('系统内收费刚被别人改成了开，请刷新后重新确认。已重新读取，请看清现在的状态后再决定。')
  })
})
