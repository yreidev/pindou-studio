import { describe, expect, it } from 'vitest'
import { safeRedirect } from './redirect'

describe('登录后跳转', () => {
  it('只跳站内路径', () => {
    expect(safeRedirect('/sales-orders?status=paid')).toBe('/sales-orders?status=paid')
    expect(safeRedirect(undefined)).toBe('/')
    expect(safeRedirect('')).toBe('/')
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect('//evil.example/path')).toBe('/')
    expect(safeRedirect('/\\evil.example')).toBe('/')
    expect(safeRedirect('/login?redirect=/')).toBe('/')
  })
})
