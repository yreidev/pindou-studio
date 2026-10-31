import { describe, expect, it } from 'vitest'
import { chargeFreshness, chargeTitle, timingNote, type OrderTiming } from './timing'

const overtime: OrderTiming = {
  kind: 'package',
  summary: '超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块',
  usedSeconds: 85 * 60,
  overtimeSeconds: 25 * 60,
  graceMinutes: 10,
  blockMinutes: 30,
  blockCents: 1500,
  blocks: 1,
  totalCents: 4490,
  applied: true,
}

describe('计时费说明（全照后端算好的）', () => {
  it('不是计时会话的草稿：不显示', () => {
    expect(timingNote({})).toBeNull()
  })

  it('系统按计时算的：写计时费、后端的说明，提醒计时还在走', () => {
    expect(timingNote({ timing: overtime })).toEqual({
      type: 'info',
      title: '计时费 ¥44.90（系统按计时算）',
      lines: [
        '超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块。',
        '计时还在走：金额按读取的这一刻算；超时进了下一块、自由计时多了一块时，收款会提示重新读取。',
      ],
    })
  })

  it('停止计时的：按停止那一刻算、不再变', () => {
    const note = timingNote({ timing: { ...overtime, frozenAt: '2026-10-06T03:25:00Z' } })
    expect(note?.lines[1]).toBe('已停止计时（2026-10-06 11:25），按停止那一刻算，不再变。')
  })

  it('陪客收固定陪客费，不随时间变', () => {
    const note = timingNote({
      timing: {
        kind: 'companion',
        summary: '陪客不计时，陪客费 ¥20.00',
        usedSeconds: 0,
        overtimeSeconds: 0,
        totalCents: 2000,
        applied: true,
      },
    })
    expect(note).toEqual({
      type: 'info',
      title: '计时费 ¥20.00（系统按计时算）',
      lines: ['陪客不计时，陪客费 ¥20.00。'],
    })
  })

  it('员工改过计时行：提醒核对，给出系统算的数', () => {
    const note = timingNote({ timing: { ...overtime, applied: false } })
    expect(note?.type).toBe('warning')
    expect(note?.title).toBe('计时明细被改过')
    expect(note?.lines[1]).toBe(
      '系统按计时算：超时 25 分钟（宽限 10 分钟），按续时 30 分钟 ¥15.00 加收 1 块，计时费 ¥44.90。请核对明细里的计时费。',
    )
  })

  it('对不上已发布的价：待填价，不写 ¥0', () => {
    const unpriced: OrderTiming = {
      kind: 'unpriced',
      summary: '已用 31 分钟（不含暂停）；没有发布自由计时价，结账时填价',
      usedSeconds: 31 * 60,
      overtimeSeconds: 0,
      applied: true,
    }
    expect(chargeTitle(unpriced)).toBe('计时费待填价')
    expect(chargeFreshness(unpriced)).toBeNull()
    expect(timingNote({ timing: unpriced })?.type).toBe('warning')
  })
})
