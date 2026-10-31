import { describe, expect, it } from 'vitest'
import { couponDraftOf, couponInput, couponProblem, couponText, sameCoupon } from './coupon'

describe('团购记录', () => {
  it('一行写法：平台加四位一段的券码，到店再买只写平台，没填为空', () => {
    expect(couponText({ platform: 'meituan', code: '123456789012' })).toBe('美团 · 券码 1234 5678 9012')
    expect(couponText({ platform: 'dianping', code: 'AB12C' })).toBe('大众点评 · 券码 AB12 C')
    expect(couponText({ platform: 'dianping' })).toBe('大众点评')
    expect(couponText({ platform: 'in_store' })).toBe('到店再买')
    expect(couponText(undefined)).toBe('')
  })

  it('校验同后端：选了平台才能填券码，券码去空白后只能是字母数字、最多 32 位，到店再买不填券码', () => {
    expect(couponProblem({ platform: '', code: '' })).toBeNull()
    expect(couponProblem({ platform: '', code: '123' })).toBe('填了券码要选是哪个平台的')
    expect(couponProblem({ platform: 'meituan', code: '1234 5678 9012' })).toBeNull()
    expect(couponProblem({ platform: 'meituan', code: '1234-5678' })).toBe('券码只能是字母和数字')
    expect(couponProblem({ platform: 'meituan', code: '1'.repeat(33) })).toBe('券码最多 32 位')
    expect(couponProblem({ platform: 'meituan', code: '1'.repeat(32) })).toBeNull()
    expect(couponProblem({ platform: 'in_store', code: '1' })).toBe('到店再买不用填券码')
  })

  it('请求里去掉空白，没选平台不带', () => {
    expect(couponInput({ platform: 'meituan', code: ' 1234 5678 ' })).toEqual({ platform: 'meituan', code: '12345678' })
    expect(couponInput({ platform: 'dianping', code: '' })).toEqual({ platform: 'dianping' })
    expect(couponInput({ platform: 'in_store', code: '' })).toEqual({ platform: 'in_store' })
    expect(couponInput({ platform: '', code: '' })).toBeUndefined()
  })

  it('改没改：按平台和券码比', () => {
    expect(sameCoupon(undefined, undefined)).toBe(true)
    expect(sameCoupon({ platform: 'meituan', code: '1' }, { platform: 'meituan', code: '1' })).toBe(true)
    expect(sameCoupon({ platform: 'meituan', code: '1' }, undefined)).toBe(false)
    expect(couponDraftOf(undefined)).toEqual({ platform: '', code: '' })
    expect(couponDraftOf({ platform: 'meituan', code: '9' })).toEqual({ platform: 'meituan', code: '9' })
  })
})
