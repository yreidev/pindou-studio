import type { RingClock } from '../features/service-calls/ringer'

/**
 * 假的钟：时间只在测试调 advance 时走，到点的定时器按先后跑。
 * stall 模拟浏览器在后台把定时器推迟：时间照走，定时器一个都不跑，等下一次 advance 才补跑（醒得晚）。
 */
export function fakeClock() {
  let now = 0
  let nextId = 1
  let timers: { id: number; at: number; run: () => void }[] = []
  const clock: RingClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextId++
      timers.push({ id, at: now + ms, run })
      return id
    },
    clearTimeout: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle)
    },
  }
  return {
    clock,
    /** 还排着几个定时器。 */
    pending: () => timers.length,
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        now = Math.max(now, next.at)
        next.run()
      }
      now = end
    },
    stall(ms: number) {
      now += ms
    },
  }
}
