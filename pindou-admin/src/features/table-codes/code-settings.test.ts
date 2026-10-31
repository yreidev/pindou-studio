import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { canSubmit, envOption, missingStep, saveErrorMessage, type ChangeDraft } from './code-settings'

const draft = (overrides: Partial<ChangeDraft>): ChangeDraft => ({
  current: 'trial',
  target: 'release',
  reason: '小程序正式版已审核发布',
  acknowledged: true,
  ...overrides,
})

describe('小程序码指向的版本', () => {
  it('三个版本各有中文名', () => {
    expect(envOption('release').label).toBe('正式版')
    expect(envOption('trial').label).toBe('体验版')
    expect(envOption('develop').label).toBe('开发版')
  })

  it('换了版本、写了原因、勾了确认才能提交，并说清还差哪一步', () => {
    expect(canSubmit(draft({}))).toBe(true)
    expect(missingStep(draft({}))).toBeNull()
    const cases: [Partial<ChangeDraft>, string][] = [
      [{ target: 'trial' }, '先选一个和现在不同的版本'],
      [{ reason: '   ' }, '写明为什么改'],
      [{ reason: '字'.repeat(201) }, '原因最多 200 字'],
      [{ acknowledged: false }, '勾选确认已了解后果'],
    ]
    for (const [overrides, step] of cases) {
      expect(canSubmit(draft(overrides))).toBe(false)
      expect(missingStep(draft(overrides))).toBe(step)
    }
    // 按字数算，不按 UTF-16 长度：200 个字（含表情）正好可以
    expect(canSubmit(draft({ reason: '😀'.repeat(200) }))).toBe(true)
  })

  it('保存失败照实说明，微信拒绝的原因原样带出', () => {
    expect(saveErrorMessage(new ApiError(403, 'forbidden', 'forbidden'))).toBe('只有老板可以修改小程序码指向的版本。')
    expect(
      saveErrorMessage(new ApiError(409, 'code_settings_conflict', '小程序码的版本刚被改成了开发版，请刷新后重新确认')),
    ).toBe('小程序码的版本刚被改成了开发版，请刷新后重新确认。已重新读取，请看清现在的版本后再决定。')
    const rejected = '没有保存：用正式版试生成小程序码，微信拒绝了（errcode 41030，invalid page）'
    expect(saveErrorMessage(new ApiError(409, 'code_check_failed', rejected))).toBe(rejected)
  })
})
