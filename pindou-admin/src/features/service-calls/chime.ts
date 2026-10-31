/**
 * 新呼叫的提示音。
 *
 * ★ 浏览器的自动播放策略：页面没被人点过（或按过键）之前不许出声，这一条绕不开。所以 AudioContext 要在人点页面、
 *   按键的那一下里创建并唤醒（enable 必须在这类事件的回调里调用），之后新呼叫到达时 play 才响得出来，
 *   页面在后台、窗口最小化时也照样响。页面刷新后要重新点一下：unlockOnFirstInteraction 在打开页面后的
 *   第一次点击或按键里自动唤醒，不用专门去点开关。
 * ★ 不用音频文件：页面的 CSP 不放外部媒体，用 WebAudio 现场合成两声短促的「叮咚」就够了。
 * ★ 一轮就是这两声；持续响由 ringer.ts 每隔几秒调一次 play。两轮挨得太近（刚响完一轮又来了新呼叫）时，
 *   后一轮排在前一轮响完之后，不叠在一起。
 */
export class Chime {
  private context: AudioContext | null = null
  /** 上一轮在声音时钟上响到哪一刻：下一轮不早于这一刻开始。 */
  private busyUntil = 0
  private readonly create: () => AudioContext | null
  /** 这个浏览器有没有 WebAudio；没有的话怎么点都出不了声，不必提示人去点。 */
  readonly supported: boolean

  constructor(create?: () => AudioContext | null) {
    this.create = create ?? defaultContext
    this.supported = create !== undefined || audioContextClass() !== null
  }

  /** 在用户点击、按键里调用：创建并唤醒声音，返回现在能不能出声。浏览器不支持时返回 false。 */
  async enable(): Promise<boolean> {
    if (!this.context) {
      this.context = this.create()
      // 新的声音时钟从 0 走起
      this.busyUntil = 0
    }
    if (!this.context) return false
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume()
      } catch {
        return false
      }
    }
    return this.context.state === 'running'
  }

  /** 释放声音设备（离开后台、退出登录时）。 */
  disable(): void {
    const context = this.context
    this.context = null
    void context?.close().catch(() => undefined)
  }

  /** 现在能不能出声：唤醒过、浏览器没再把它停掉。 */
  get enabled(): boolean {
    return this.context?.state === 'running'
  }

  /**
   * 响一轮：两声（高、低各约 0.2 秒）。volume 是设置里的音量 0–100，为 0 时不出声；还没唤醒时什么都不做。
   * 用声音时钟排时间（context.currentTime），页面在后台时也按时响。
   */
  play(volume: number): void {
    const context = this.context
    if (!context || context.state !== 'running') return
    const peak = chimePeakGain(volume)
    if (peak <= 0) return
    const start = Math.max(context.currentTime, this.busyUntil)
    this.busyUntil = start + roundSeconds
    for (const [offset, frequency] of [
      [0, 880],
      [0.25, 660],
    ] as const) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      // 渐入渐出，避免爆音（指数渐变不能从 0 起、也不能到 0，用一个听不见的小数）
      gain.gain.setValueAtTime(silentGain, start + offset)
      gain.gain.exponentialRampToValueAtTime(peak, start + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(silentGain, start + offset + 0.2)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start + offset)
      oscillator.stop(start + offset + 0.22)
    }
  }
}

/** 一轮从开始到响完多少秒（第二声 0.25 秒开始、响 0.22 秒），再留一点空。 */
const roundSeconds = 0.5

/** 渐入渐出的起止音量：听不见，但指数渐变要求大于 0。 */
const silentGain = 0.0001

/** 音量 100 时每声的峰值增益：两声不重叠，正弦波峰值不到 1，不会削波。 */
const maxGain = 0.8

/**
 * 设置里的音量（0–100）换成每声的峰值增益。人耳对响度大致按对数感受，按平方换算，滑块各段听起来变化更均匀：
 * 80 约 0.51（比以前固定的 0.3 响），50 约 0.2，20 约 0.03。超出范围的按 0、100 算。
 */
export function chimePeakGain(volume: number): number {
  if (!Number.isFinite(volume) || volume <= 0) return 0
  const ratio = Math.min(volume, 100) / 100
  return Math.max(maxGain * ratio * ratio, silentGain * 2)
}

/**
 * 浏览器认作「用户操作」、肯放声音的事件：按键、鼠标按下；触屏要等手指抬起（pointerup）才算。
 * 在捕获阶段监听，页面里哪个元素阻止了冒泡也不影响。
 */
const interactionEvents = ['pointerdown', 'pointerup', 'keydown'] as const

/**
 * 打开页面后的第一次点击或按键里唤醒提示音，唤醒成功就不再监听，并调用 onUnlocked。
 * 浏览器没放行（例如按的是 Esc）就等下一次。返回取消监听的函数。
 */
export function unlockOnFirstInteraction(
  chime: Chime,
  onUnlocked: () => void,
  target: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  let done = false
  const stop = () => {
    for (const type of interactionEvents) target.removeEventListener(type, handle, true)
  }
  function handle() {
    if (done) return
    void chime.enable().then((ok) => {
      if (!ok || done) return
      done = true
      stop()
      onUnlocked()
    })
  }
  for (const type of interactionEvents) target.addEventListener(type, handle, true)
  return () => {
    done = true
    stop()
  }
}

function audioContextClass(): typeof AudioContext | null {
  return (
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  )
}

function defaultContext(): AudioContext | null {
  const Context = audioContextClass()
  return Context ? new Context() : null
}
