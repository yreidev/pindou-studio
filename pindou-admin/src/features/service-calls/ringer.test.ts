import { describe, expect, it, vi } from 'vitest'
import { fakeClock } from '../../test/fake-clock'
import { ringCapMs, ringDurationMs } from './alert-prefs'
import { Ringer, ringIntervalMs } from './ringer'

/** 记下每一轮在第几毫秒响。 */
function setup() {
  const time = fakeClock()
  const rounds: number[] = []
  const timeUp = vi.fn()
  const ringer = new Ringer(() => rounds.push(time.clock.now()), timeUp, time.clock)
  return { time, rounds, timeUp, ringer }
}

describe('持续响铃的排程', () => {
  it('各档时长：响一下只响一轮；30 秒、1 分钟每 4 秒一轮、满了就停；一直响到有人处理最长 5 分钟', () => {
    expect(ringIntervalMs).toBe(4_000)
    const expected: [Parameters<typeof ringDurationMs>[0], number][] = [
      ['once', 1],
      ['30s', 8], // 0、4、…、28 秒
      ['1m', 15], // 0、4、…、56 秒
      ['untilHandled', 75], // 0、4、…、296 秒
    ]
    for (const [ringFor, count] of expected) {
      const { time, rounds, timeUp, ringer } = setup()
      ringer.start(ringDurationMs(ringFor))
      expect(rounds).toEqual([0])
      time.advance(10 * 60_000)
      expect(rounds).toHaveLength(count)
      expect(rounds).toEqual(Array.from({ length: count }, (_, i) => i * ringIntervalMs))
      expect(ringer.ringing).toBe(false)
      // 响一下那一轮响完就不算在响，不会有「响满时长」
      expect(timeUp).toHaveBeenCalledTimes(ringFor === 'once' ? 0 : 1)
      expect(time.pending()).toBe(0)
    }
    expect(ringDurationMs('untilHandled')).toBe(ringCapMs)
    expect(ringCapMs).toBe(5 * 60_000)
  })

  it('响满时长那一刻就停：不等下一轮', () => {
    const { time, rounds, timeUp, ringer } = setup()
    ringer.start(30_000)
    time.advance(29_999)
    expect(ringer.ringing).toBe(true)
    time.advance(1)
    expect(ringer.ringing).toBe(false)
    expect(timeUp).toHaveBeenCalledTimes(1)
    expect(rounds.at(-1)).toBe(28_000)
  })

  it('响着时再 start（又来了新呼叫）：从现在重新计时，只有一路，不叠响', () => {
    const { time, rounds, ringer } = setup()
    ringer.start(30_000)
    time.advance(25_000) // 响过 0…24 秒共 7 轮
    expect(rounds).toHaveLength(7)
    ringer.start(30_000)
    expect(rounds.at(-1)).toBe(25_000)
    // 之后每 4 秒一轮，从 25 秒算起，原来那一路不再响（28 秒那一轮没有了）
    time.advance(8_000)
    expect(rounds.slice(7)).toEqual([25_000, 29_000, 33_000])
    // 新的一路响满 30 秒（到 55 秒）才停
    time.advance(21_999)
    expect(ringer.ringing).toBe(true)
    time.advance(1)
    expect(ringer.ringing).toBe(false)
    expect(rounds.slice(7)).toEqual([25_000, 29_000, 33_000, 37_000, 41_000, 45_000, 49_000, 53_000])
    expect(time.pending()).toBe(0)
  })

  it('stop：马上不再响，也不算响满时长', () => {
    const { time, rounds, timeUp, ringer } = setup()
    ringer.start(ringCapMs)
    time.advance(8_000)
    expect(rounds).toHaveLength(3)
    ringer.stop()
    expect(ringer.ringing).toBe(false)
    time.advance(60_000)
    expect(rounds).toHaveLength(3)
    expect(timeUp).not.toHaveBeenCalled()
    expect(time.pending()).toBe(0)
  })

  it('浏览器在后台把定时器推迟：醒晚了错过的几轮不补，只响一轮再按整轮接着排', () => {
    const { time, rounds, ringer } = setup()
    ringer.start(60_000)
    time.stall(13_500) // 本该 4、8、12 秒响的定时器拖到 13.5 秒才醒
    time.advance(0)
    expect(rounds).toEqual([0, 13_500])
    time.advance(2_500) // 下一轮在 16 秒
    expect(rounds).toEqual([0, 13_500, 16_000])
  })

  it('推迟到时长以后才醒：直接停，不再多响一轮', () => {
    const { time, rounds, timeUp, ringer } = setup()
    ringer.start(30_000)
    time.advance(4_000)
    time.stall(60_000)
    time.advance(0)
    expect(rounds).toEqual([0, 4_000])
    expect(ringer.ringing).toBe(false)
    expect(timeUp).toHaveBeenCalledTimes(1)
  })

  it('定时器比预定早醒一点点：算到点，不会同一轮响两次', () => {
    const time = fakeClock()
    const rounds: number[] = []
    let skew = 0
    const ringer = new Ringer(
      () => rounds.push(time.clock.now()),
      () => {},
      {
        ...time.clock,
        // 计时取整让定时器回调时读到的时间比预定少 2 毫秒
        setTimeout: (run, ms) => time.clock.setTimeout(run, Math.max(0, ms - skew)),
      },
    )
    skew = 2
    ringer.start(30_000)
    time.advance(8_000)
    expect(rounds).toEqual([0, 3_998, 7_998])
  })

  it('改了时长：从当初响起时算，已经响够了就停，否则按新时长接着响', () => {
    const { time, rounds, timeUp, ringer } = setup()
    ringer.start(ringCapMs)
    time.advance(40_000)
    ringer.retime(60_000)
    expect(ringer.ringing).toBe(true)
    time.advance(20_000)
    expect(ringer.ringing).toBe(false)
    expect(timeUp).toHaveBeenCalledTimes(1)
    expect(rounds).toHaveLength(15)

    ringer.start(ringCapMs)
    time.advance(40_000)
    ringer.retime(30_000)
    expect(ringer.ringing).toBe(false)
    expect(time.pending()).toBe(0)
    // 改成响一下：正在响的也马上停
    ringer.start(ringCapMs)
    time.advance(1_000)
    ringer.retime(0)
    expect(ringer.ringing).toBe(false)
  })
})
