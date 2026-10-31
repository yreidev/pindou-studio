import { describe, expect, it, vi } from 'vitest'
import { clearSession, isStaff, loadSession, onSessionChange, saveSession, type Session } from './session'

const session: Session = {
  accessToken: 'token-1',
  expiresAt: '2026-10-05T10:00:00Z',
  user: { id: 'u1', nickname: '阿贝', roles: ['manager'] },
}

describe('网页会话', () => {
  it('存进去能原样读出来，过期后读不到并清掉', () => {
    saveSession(session)
    expect(loadSession(new Date('2026-10-05T09:59:59Z'))).toEqual(session)
    expect(loadSession(new Date('2026-10-05T10:00:00Z'))).toBeNull()
    expect(window.localStorage.getItem('pindou-admin.session')).toBeNull()
  })

  it('内容损坏或缺字段当作没登录', () => {
    window.localStorage.setItem('pindou-admin.session', '{不是 JSON')
    expect(loadSession()).toBeNull()
    window.localStorage.setItem('pindou-admin.session', JSON.stringify({ accessToken: '', expiresAt: 'x', user: {} }))
    expect(loadSession()).toBeNull()
  })

  it('退出后读不到', () => {
    saveSession(session)
    clearSession()
    expect(loadSession(new Date('2026-10-05T09:00:00Z'))).toBeNull()
  })

  it('只有店员、店长、老板算员工；开发者资格不算', () => {
    expect(isStaff({ id: 'a', nickname: 'a', roles: ['clerk'] })).toBe(true)
    expect(isStaff({ id: 'a', nickname: 'a', roles: ['owner', 'developer'] })).toBe(true)
    expect(isStaff({ id: 'a', nickname: 'a', roles: ['developer'] })).toBe(false)
    expect(isStaff({ id: 'a', nickname: 'a', roles: [] })).toBe(false)
    expect(isStaff(undefined)).toBe(false)
  })

  it('别的标签页改动会话时通知本页，改别的键不通知', () => {
    const listener = vi.fn()
    const stop = onSessionChange(listener)
    window.dispatchEvent(new StorageEvent('storage', { key: 'pindou-admin.session' }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'other' }))
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    stop()
    window.dispatchEvent(new StorageEvent('storage', { key: 'pindou-admin.session' }))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
