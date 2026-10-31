import { describe, expect, it, vi } from 'vitest'
import type { ServiceCall } from '../../api/service-calls'
import { alerting, alertKey, arrivals, callerName, callPlace, claimNote, needsAlert, waitedLabel } from './calls'
import { Chime, chimePeakGain, unlockOnFirstInteraction } from './chime'
import { FakeAudioContext } from '../../test/fake-audio'

const call = (id: string, patch: Partial<ServiceCall> = {}): ServiceCall => ({
  id,
  venueSessionId: `s-${id}`,
  serviceTableId: 't-1',
  tableCode: 'B3',
  seatNumber: 2,
  status: 'pending',
  displayStatus: 'pending',
  createdAt: '2026-10-05T06:00:00Z',
  handledAt: null,
  cooldownSeconds: 0,
  customer: { id: 'u-1', nickname: '小林', phoneMasked: '138****8000' },
  handledBy: null,
  claimStatus: 'none',
  claimedAt: null,
  claimedBy: null,
  ...patch,
})

describe('呼叫店员', () => {
  it('桌位按布局编码写，整桌开台的旧会话没有座号', () => {
    expect(callPlace(call('a'))).toBe('B3 桌 · 2 号座')
    expect(callPlace(call('a', { seatNumber: 0 }))).toBe('B3 桌')
    expect(callPlace(call('a', { tableCode: '' }))).toBe('桌位待核对 · 2 号座')
  })

  it('顾客称呼：昵称，没有就用打码手机号，账户不在了写顾客', () => {
    expect(callerName(call('a'))).toBe('小林')
    expect(callerName(call('a', { customer: { id: 'u-1', nickname: '', phoneMasked: '138****8000' } }))).toBe(
      '138****8000',
    )
    expect(callerName(call('a', { customer: null }))).toBe('顾客')
  })

  it('叫了多久：不到 1 分钟是刚刚，电脑时钟慢一点也不显示负数', () => {
    const at = Date.parse('2026-10-05T06:00:00Z')
    expect(waitedLabel('2026-10-05T06:00:00Z', at + 59_000)).toBe('刚刚')
    expect(waitedLabel('2026-10-05T06:00:00Z', at + 3 * 60_000 + 5_000)).toBe('3 分钟前')
    expect(waitedLabel('2026-10-05T06:00:00Z', at - 10_000)).toBe('刚刚')
    expect(waitedLabel('不是时间', at)).toBe('刚刚')
  })

  it('新到的呼叫：第一次读到的不算，之后读到的上次没有的才算', () => {
    expect(arrivals(null, [call('a')])).toEqual([])
    expect(arrivals(new Set(['a']), [call('a'), call('b')]).map((c) => c.id)).toEqual(['b'])
    // 别人处理掉一条不是新到
    expect(arrivals(new Set(['a', 'b']), [call('b')])).toEqual([])
  })

  it('认领：认领着的不提醒；认领满 10 分钟没处理的换个键，算新到；旧版后端不带认领照旧提醒', () => {
    const zhou = { id: 'u-zhou', nickname: '小周', phoneMasked: '139****0001' }
    const claimed = call('a', { claimStatus: 'claimed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou })
    const lapsed = call('a', { claimStatus: 'lapsed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou })
    expect(needsAlert(call('a'))).toBe(true)
    expect(needsAlert(claimed)).toBe(false)
    expect(needsAlert(lapsed)).toBe(true)
    expect(alertKey(call('a'))).toBe('a')
    expect(alertKey(lapsed)).toBe('a@2026-10-05T06:01:00Z')
    expect([...alerting([claimed, call('b')]).keys()]).toEqual(['b'])
    // 认领不是新到；失效后算新到（上次记下的是没认领时的键，或者认领着时它不在里面）
    expect(arrivals(new Set(['a']), [claimed])).toEqual([])
    expect(arrivals(new Set(['a']), [lapsed]).map((c) => c.id)).toEqual(['a'])
    expect(arrivals(new Set(), [lapsed]).map((c) => c.id)).toEqual(['a'])
    expect(arrivals(new Set(['a@2026-10-05T06:01:00Z']), [lapsed])).toEqual([])
    const old = { ...call('a') } as Partial<ServiceCall>
    delete old.claimStatus
    delete old.claimedAt
    expect(needsAlert(old as ServiceCall)).toBe(true)
    expect(alertKey(old as ServiceCall)).toBe('a')
  })

  it('认领说明：谁正在处理、多久了；认领满 10 分钟写还没处理；没人认领为空', () => {
    const at = Date.parse('2026-10-05T06:03:00Z')
    const zhou = { id: 'u-zhou', nickname: '小周', phoneMasked: '139****0001' }
    expect(claimNote(call('a'), at)).toBeNull()
    expect(
      claimNote(call('a', { claimStatus: 'claimed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou }), at),
    ).toEqual({ text: '小周 正在处理 · 2 分钟前', claimed: true })
    expect(
      claimNote(
        call('a', { claimStatus: 'lapsed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou }),
        Date.parse('2026-10-05T06:13:00Z'),
      ),
    ).toEqual({ text: '小周 12 分钟前说去处理，还没处理', claimed: false })
    // 认领人账户不在了
    expect(claimNote(call('a', { claimStatus: 'claimed', claimedAt: '2026-10-05T06:03:00Z' }), at)?.text).toBe(
      '其他店员 正在处理 · 刚刚',
    )
    // 自己认领的写「你」
    expect(
      claimNote(
        call('a', { claimStatus: 'claimed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou }),
        at,
        'u-zhou',
      ),
    ).toEqual({ text: '你正在处理 · 2 分钟前', claimed: true })
    expect(
      claimNote(
        call('a', { claimStatus: 'lapsed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou }),
        Date.parse('2026-10-05T06:13:00Z'),
        'u-zhou',
      )?.text,
    ).toBe('你 12 分钟前说去处理，还没处理')
    // 别人认领的照写昵称
    expect(
      claimNote(call('a', { claimStatus: 'claimed', claimedAt: '2026-10-05T06:01:00Z', claimedBy: zhou }), at, 'u-li')
        ?.text,
    ).toBe('小周 正在处理 · 2 分钟前')
  })
})

describe('提示音', () => {
  it('没唤醒时不响；唤醒后每次响两声；释放后不再响', async () => {
    const context = new FakeAudioContext()
    const chime = new Chime(() => context as unknown as AudioContext)
    chime.play(80)
    expect(context.starts).toBe(0)
    expect(await chime.enable()).toBe(true)
    expect(chime.enabled).toBe(true)
    chime.play(80)
    expect(context.starts).toBe(2)
    chime.disable()
    expect(chime.enabled).toBe(false)
    chime.play(80)
    expect(context.starts).toBe(2)
  })

  it('音量作用于每声的峰值增益：按平方换算，0 不出声，超出范围按 0、100 算', async () => {
    expect(chimePeakGain(100)).toBeCloseTo(0.8)
    expect(chimePeakGain(80)).toBeCloseTo(0.512)
    expect(chimePeakGain(50)).toBeCloseTo(0.2)
    expect(chimePeakGain(0)).toBe(0)
    expect(chimePeakGain(-5)).toBe(0)
    expect(chimePeakGain(Number.NaN)).toBe(0)
    expect(chimePeakGain(150)).toBeCloseTo(0.8)
    // 再小也比渐入渐出的起止值大，指数渐变才是「渐入」
    expect(chimePeakGain(1)).toBeGreaterThan(0.0001)

    const context = new FakeAudioContext()
    const chime = new Chime(() => context as unknown as AudioContext)
    await chime.enable()
    chime.play(50)
    expect(context.peaks.map((peak) => Number(peak.toFixed(3)))).toEqual([0.2, 0.2])
    chime.play(0)
    expect(context.starts).toBe(2)
  })

  it('两轮挨得太近：后一轮排在前一轮响完之后，不叠在一起', async () => {
    const context = new FakeAudioContext()
    const chime = new Chime(() => context as unknown as AudioContext)
    await chime.enable()
    context.currentTime = 10
    chime.play(80)
    context.currentTime = 10.1
    chime.play(80)
    expect(context.startTimes).toEqual([10, 10.25, 10.5, 10.75])
    // 隔得够远就马上响
    context.currentTime = 14
    chime.play(80)
    expect(context.startTimes.slice(4)).toEqual([14, 14.25])
  })

  it('换了新的声音设备（退出又登录）：时钟从 0 起，不被旧的排程拖后', async () => {
    let context = new FakeAudioContext()
    const chime = new Chime(() => context as unknown as AudioContext)
    await chime.enable()
    context.currentTime = 300
    chime.play(80)
    chime.disable()
    context = new FakeAudioContext()
    await chime.enable()
    chime.play(80)
    expect(context.startTimes).toEqual([0, 0.25])
  })

  it('浏览器不支持或不肯唤醒时如实说开不了', async () => {
    expect(await new Chime(() => null).enable()).toBe(false)
    const stubborn = new FakeAudioContext()
    stubborn.resume = async () => {
      throw new Error('not allowed')
    }
    expect(await new Chime(() => stubborn as unknown as AudioContext).enable()).toBe(false)
  })

  it('打开页面后第一次点击或按键时自动唤醒，之后不再监听', async () => {
    const context = new FakeAudioContext()
    let created = 0
    const chime = new Chime(() => {
      created++
      return context as unknown as AudioContext
    })
    const target = new EventTarget()
    const unlocked = vi.fn()
    unlockOnFirstInteraction(chime, unlocked, target as unknown as Document)
    // 还没人碰过页面：不创建声音（Chrome 会在控制台抱怨提前创建的 AudioContext）
    expect(created).toBe(0)
    expect(chime.enabled).toBe(false)

    target.dispatchEvent(new Event('pointerdown'))
    await vi.waitFor(() => expect(unlocked).toHaveBeenCalledTimes(1))
    expect(chime.enabled).toBe(true)
    chime.play(80)
    expect(context.starts).toBe(2)

    // 已经唤醒：再点不再处理
    target.dispatchEvent(new Event('keydown'))
    await Promise.resolve()
    expect(unlocked).toHaveBeenCalledTimes(1)
    expect(created).toBe(1)
  })

  it('按键也能唤醒；浏览器这一下没放行就等下一次；取消后不再监听', async () => {
    const context = new FakeAudioContext()
    let allowed = false
    context.resume = async () => {
      if (allowed) context.state = 'running'
    }
    const chime = new Chime(() => context as unknown as AudioContext)
    const target = new EventTarget()
    const unlocked = vi.fn()
    const cancel = unlockOnFirstInteraction(chime, unlocked, target as unknown as Document)
    target.dispatchEvent(new Event('keydown'))
    await Promise.resolve()
    await Promise.resolve()
    expect(unlocked).not.toHaveBeenCalled()

    allowed = true
    target.dispatchEvent(new Event('keydown'))
    await vi.waitFor(() => expect(unlocked).toHaveBeenCalledTimes(1))

    const other = new Chime(() => new FakeAudioContext() as unknown as AudioContext)
    const otherTarget = new EventTarget()
    const otherUnlocked = vi.fn()
    unlockOnFirstInteraction(other, otherUnlocked, otherTarget as unknown as Document)()
    otherTarget.dispatchEvent(new Event('pointerdown'))
    await Promise.resolve()
    await Promise.resolve()
    expect(otherUnlocked).not.toHaveBeenCalled()
    expect(other.enabled).toBe(false)
    cancel()
  })
})
