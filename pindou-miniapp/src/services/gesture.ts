// 手势的计算（docs/plan-interaction.md 第 2、4 节）：测速、松手关不关、拖出边界的阻尼、惯性滑行。
// 除了逐帧跑的 frames 都是纯函数，弹层（components/sheet.tsx）和做图纸的画布共用。

/**
 * 松手前的速度（像素/毫秒）：只看最后约 100 毫秒走了多远。
 * 不用相邻两次触点（间隔不到 1 毫秒时速度会跳到十几），也不用整段平均（慢慢拖了两秒再一甩，甩的那下会被平均掉）。
 */
export function velocityTracker(windowMs = 100) {
  const samples: [number, number, number][] = []
  return {
    reset() {
      samples.length = 0
    },
    push(time: number, x: number, y: number) {
      samples.push([time, x, y])
      if (samples.length > 12) samples.shift()
    },
    /** [横向, 纵向]；不到两个触点是 [0, 0] */
    get(): [number, number] {
      if (samples.length < 2) return [0, 0]
      const last = samples[samples.length - 1]
      let i = samples.length - 2
      while (i > 0 && last[0] - samples[i][0] < windowMs) i--
      const dt = last[0] - samples[i][0]
      return dt > 0 ? [(last[1] - samples[i][1]) / dt, (last[2] - samples[i][2]) / dt] : [0, 0]
    },
  }
}

/** 往下甩到这个速度（像素/毫秒）就关，不管拖了多远 */
export const FLING_SPEED = 0.55

/**
 * 弹层松手关不关：拖过面板高度的三分之一，或者往下甩得够快。只看一样都不行——
 * 只看距离，轻轻一甩会弹回来；只看速度，慢慢拖到底也关不掉。拖远了又往上甩回去的不关。
 */
export function shouldDismiss(offset: number, height: number, velocity: number) {
  if (velocity > FLING_SPEED) return true
  return offset > height / 3 && velocity > -FLING_SPEED
}

/** 往不该去的方向拖（弹层往上）：只走三成，不是一下拦死。 */
export const resist = (distance: number) => distance * 0.3

/** 拖出边界 over 像素时实际走多远：越往外越拖不动，永远到不了 max。 */
export function rubberBand(over: number, max: number) {
  if (max <= 0) return 0
  return Math.sign(over) * max * (1 - Math.exp(-Math.abs(over) / max))
}

/** 惯性滑行起步的最低速度（像素/毫秒）：松手前几乎没在动就不滑 */
export const GLIDE_START = 0.2
/** 速度小于这个（像素/毫秒）就停 */
export const GLIDE_STOP = 0.02

/** 滑行一帧：经过 dt 毫秒，这一帧走多远、之后的速度（按每 16 毫秒乘 friction 递减）。 */
export function glideStep(velocity: number, dt: number, friction = 0.92) {
  return { distance: velocity * dt, velocity: velocity * Math.pow(friction, dt / 16) }
}

/** 弹回去的一帧：离目标的距离按每 16 毫秒剩七成收拢，差不到 epsilon（默认半个像素）就到位。 */
export function approach(from: number, to: number, dt: number, epsilon = 0.5) {
  const next = to + (from - to) * Math.pow(0.7, dt / 16)
  return Math.abs(next - to) < epsilon ? to : next
}

/** 逐帧跑 step（参数是离上一帧的毫秒数），返回 false 就停；返回的函数让它立刻停下（手指又按下了）。 */
export function frames(step: (dt: number) => boolean) {
  let last = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    const now = Date.now()
    const keep = step(Math.min(48, Math.max(1, now - last)))
    last = now
    timer = keep ? setTimeout(tick, 16) : undefined
  }
  timer = setTimeout(tick, 16)
  return () => clearTimeout(timer)
}
