/** 持续响时每隔多久响一轮（一轮是「叮咚」两声，约半秒）。 */
export const ringIntervalMs = 4_000

/** 定时器比预定早醒这么点也算到点（各浏览器的计时取整不同），免得同一轮响两次。 */
const earlyToleranceMs = 50

/** 计时用的钟：默认是浏览器的，测试换成假的。 */
export interface RingClock {
  /** 单调递增的毫秒数（不随电脑改时间跳动）。 */
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const browserClock: RingClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 呼叫的持续响铃：响起时马上响一轮，之后每 4 秒一轮，从响起算满设定的时长就停。什么时候响、什么时候因为呼叫被处理、
 * 人点了「知道了」、关了提示音而停，由提醒中心（alert-center.ts）决定，这里只管按时间响。
 *
 * ★ 浏览器会放慢后台标签页的定时器（Chrome、Firefox 至少放慢到每秒一次；正在出声的页面不会再进一步放慢到每分钟一次）。
 *   所以每次醒来都按真实流逝的时间判断：过了时长就停、不再响；醒晚了错过的几轮不补，只响这一轮再从下一个整轮接着排，
 *   不会一下子连响好几轮，也不会因为醒得晚而多响到时长以外。
 * ★ 任何时候只有一路：正在响时再 start（又来了新呼叫）是从现在起重新计时，不另起一路叠着响。
 */
export class Ringer {
  private active = false
  private startedAt = 0
  private durationMs = 0
  /** 下一轮在响起后的第几毫秒。 */
  private nextRoundAt = 0
  private timer: unknown = null
  private readonly playRound: () => void
  private readonly onTimeUp: () => void
  private readonly clock: RingClock

  /**
   * @param playRound 响一轮。
   * @param onTimeUp 响满时长自己停下时调用（stop、start 引起的停止不调用）。
   */
  constructor(playRound: () => void, onTimeUp: () => void, clock: RingClock = browserClock) {
    this.playRound = playRound
    this.onTimeUp = onTimeUp
    this.clock = clock
  }

  /** 还在持续响（下一轮还会来）。只响一下的那一轮响完就不算。 */
  get ringing(): boolean {
    return this.active
  }

  /** 从现在起响 durationMs（0 表示只响这一轮）。正在响就从现在重新计时。 */
  start(durationMs: number): void {
    this.cancelTimer()
    this.startedAt = this.clock.now()
    this.durationMs = durationMs
    this.nextRoundAt = ringIntervalMs
    this.playRound()
    this.active = durationMs > 0
    if (this.active) this.schedule()
  }

  /** 改了时长：从当初响起时算，已经响够了就停（不调 onTimeUp），否则按新时长接着响。 */
  retime(durationMs: number): void {
    if (!this.active) return
    this.durationMs = durationMs
    this.cancelTimer()
    if (this.elapsed() >= durationMs) {
      this.active = false
      return
    }
    this.schedule()
  }

  /** 停下（呼叫处理了、点了知道了、关了提示音、退出登录）。 */
  stop(): void {
    this.active = false
    this.cancelTimer()
  }

  private elapsed(): number {
    return this.clock.now() - this.startedAt
  }

  private tick(): void {
    this.timer = null
    if (!this.active) return
    const elapsed = this.elapsed()
    if (elapsed >= this.durationMs) {
      this.active = false
      this.onTimeUp()
      return
    }
    if (elapsed >= this.nextRoundAt - earlyToleranceMs) {
      this.playRound()
      // 醒晚了：错过的几轮不补，从下一个整轮接着排
      const nextWhole = (Math.floor(elapsed / ringIntervalMs) + 1) * ringIntervalMs
      this.nextRoundAt = Math.max(this.nextRoundAt + ringIntervalMs, nextWhole)
    }
    this.schedule()
  }

  /** 排下一次醒来：下一轮，或者到时长（先到的那个）。 */
  private schedule(): void {
    const wakeAt = Math.min(this.nextRoundAt, this.durationMs)
    this.timer = this.clock.setTimeout(() => this.tick(), Math.max(0, wakeAt - this.elapsed()))
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }
}
