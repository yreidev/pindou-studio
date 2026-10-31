/** 假的 WebAudio：记下响了几声、每声在声音时钟上哪一刻开始、峰值音量多大。currentTime 由测试改。 */
export class FakeAudioContext {
  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = {}
  starts = 0
  /** 每声开始的时刻（声音时钟，秒）。 */
  startTimes: number[] = []
  /** 每声渐入到的峰值增益。 */
  peaks: number[] = []
  resume = async () => {
    this.state = 'running'
  }
  close = async () => {
    this.state = 'closed'
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: (when = 0) => {
        this.starts++
        this.startTimes.push(when)
      },
      stop: () => {},
    }
  }
  createGain() {
    let peaked = false
    return {
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: (value: number) => {
          // 先渐入到峰值、再渐出：第一次就是峰值
          if (peaked) return
          peaked = true
          this.peaks.push(value)
        },
      },
      connect: (node: unknown) => node,
    }
  }
}
