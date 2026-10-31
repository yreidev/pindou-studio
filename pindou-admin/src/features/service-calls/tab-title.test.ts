import { afterEach, describe, expect, it, vi } from 'vitest'
import { alertTitle, TitleAlert } from './tab-title'

afterEach(() => {
  vi.useRealTimers()
})

describe('标签页标题提醒', () => {
  it('文案：「(N) 新呼叫 · 原标题」，闪烁的另一半只留数字', () => {
    expect(alertTitle(1, '示例工坊后台')).toBe('(1) 新呼叫 · 示例工坊后台')
    expect(alertTitle(3, '示例工坊后台', false)).toBe('(3) 示例工坊后台')
  })

  it('有新呼叫时改标题并闪烁，数字跟着变；清掉后恢复原标题、不再闪', () => {
    vi.useFakeTimers()
    const doc = { title: '示例工坊后台' }
    const title = new TitleAlert(doc, 1000)
    title.show(1)
    expect(doc.title).toBe('(1) 新呼叫 · 示例工坊后台')
    expect(title.active).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(doc.title).toBe('(1) 示例工坊后台')
    vi.advanceTimersByTime(1000)
    expect(doc.title).toBe('(1) 新呼叫 · 示例工坊后台')

    // 又来一条：数字变，原标题还是最初那个（不会叠成「(2) 新呼叫 · (1) 新呼叫 · …」）
    title.show(2)
    expect(doc.title).toBe('(2) 新呼叫 · 示例工坊后台')
    vi.advanceTimersByTime(1000)
    expect(doc.title).toBe('(2) 示例工坊后台')

    title.show(0)
    expect(doc.title).toBe('示例工坊后台')
    expect(title.active).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(doc.title).toBe('示例工坊后台')
  })

  it('没在提醒时清除不动标题', () => {
    const doc = { title: '现场' }
    new TitleAlert(doc).clear()
    expect(doc.title).toBe('现场')
  })
})
