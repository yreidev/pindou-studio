import type { ServiceCall } from '../../api/service-calls'
import { ringDurationMs, type AlertPrefs } from './alert-prefs'
import { alerting, alertKey, arrivals } from './calls'
import { Ringer, type RingClock } from './ringer'
import { shouldNotifySystem } from './system-notification'

/** 呼叫提醒往外发的几种动作，由界面层（CallAlerts.tsx）接上，测试里换成记录。 */
export interface AlertOutputs {
  /** 现在的偏好：设置随时可改，每次现取。 */
  prefs: () => AlertPrefs
  /** 标签页在不在前台、窗口在不在最前面。 */
  doc: Pick<Document, 'visibilityState' | 'hasFocus'>
  /** 响一轮提示音（还没唤醒声音时什么都不做）。持续响时每隔几秒调一次。 */
  sound: () => void
  /** 弹系统通知；没授权、不支持时返回 null。 */
  systemNotify: (call: ServiceCall) => { close: () => void } | null
  /** 页面里的提示：列出还挂着的新呼叫，空列表表示收起；ringing 表示正在持续响（提示上给「知道了」）。 */
  showInPage: (calls: ServiceCall[], ringing: boolean) => void
  /** 标签页标题：后台期间到达、还没处理的新呼叫有几条，0 表示恢复原标题。 */
  title: (count: number) => void
  /** 持续响铃用的钟，测试换成假的。 */
  clock?: RingClock
}

/**
 * 全站的呼叫提醒：每次读到未处理的呼叫列表就交给 update，它算出新到的（这次有、上次没有；打开页面时已挂着的不算），
 * 然后响提示音、弹系统通知（页面不在眼前时）、更新页面里的提示和标签页标题。提醒只从这一处发，
 * 看板上的呼叫栏只列出和处理，不再另外提醒，所以不会两处各响一次。
 *
 * 呼叫被处理（或过期、顾客结账离开）后不再出现在列表里；有员工点了「我去处理」的还在列表里，但不再算要提醒的
 * （calls.ts 的 needsAlert）。两种都一样：对应的系统通知关掉，页面提示和标题里的数字跟着减。
 * 认领满 10 分钟还没处理的（后端标成 lapsed）换一个提醒键，当作新到重新提醒（calls.ts 的 alertKey）。
 * 下面说的「新呼叫」「编号」都是按提醒键算的。
 *
 * 提示音按设置的时长持续响（ringer.ts，每 4 秒一轮），满足任一条件就停：
 * - 引起这次响铃的新呼叫都不用提醒了：有人点了「我去处理」或「已处理」（网页或店员手机上点都算，包括自己，
 *   只看接口重读的结果）；
 * - 人点了提示里的「知道了」、关掉了提示、点了「去「现场」处理」或点了系统通知；
 * - 响满设定的时长（「一直响到有人处理」最长 5 分钟）；
 * - 提示音开关被关掉。
 * 响着时又来了新呼叫：把它也算进来，从现在起重新计时，只有一路声音。系统通知每条呼叫只弹一次，不随每轮响铃再弹。
 */
export class CallAlertCenter {
  /** 上次读到的、要提醒的呼叫（提醒键）；null 表示还没读到过。 */
  private seen: Set<string> | null = null
  /** 页面提示里列着的新呼叫（人关掉提示就清空）。 */
  private readonly inPage = new Map<string, ServiceCall>()
  /** 标签页在后台时到达、还没处理的新呼叫（切回前台清空）。 */
  private readonly whileHidden = new Set<string>()
  /** 弹出去还开着的系统通知，按呼叫编号。 */
  private readonly system = new Map<string, { close: () => void }>()
  /** 这次响铃是哪几条新呼叫引起的：都不在未处理列表里了就停。只在持续响时有内容。 */
  private readonly ringingFor = new Set<string>()
  private readonly ringer: Ringer
  private readonly out: AlertOutputs

  constructor(out: AlertOutputs) {
    this.out = out
    this.ringer = new Ringer(
      () => out.sound(),
      () => {
        // 响满时长：提示上收起「知道了」
        this.ringingFor.clear()
        this.showInPage()
      },
      out.clock,
    )
  }

  /** 现在是不是在持续响。 */
  get ringing(): boolean {
    return this.ringer.ringing
  }

  /** 读到最新的未处理呼叫列表时调用，返回这次新到的（含认领满 10 分钟没处理、重新提醒的）。 */
  update(calls: readonly ServiceCall[]): ServiceCall[] {
    const fresh = arrivals(this.seen, calls)
    // 要提醒的呼叫，按提醒键：有人点了「我去处理」的不在里面，所以它的提示、通知、标题数字、响铃都跟处理了一样收起
    const open = alerting(calls)
    this.seen = new Set(open.keys())

    let changed = false
    for (const [key] of this.inPage) {
      const latest = open.get(key)
      if (latest) {
        // 顾客换了座：提示里跟着写新位置
        this.inPage.set(key, latest)
      } else {
        this.inPage.delete(key)
        changed = true
      }
    }
    for (const key of this.whileHidden) if (!open.has(key)) this.whileHidden.delete(key)
    for (const [key, notification] of this.system) {
      if (open.has(key)) continue
      notification.close()
      this.system.delete(key)
    }

    // 引起响铃的呼叫都不用提醒了（有人认领或处理了，哪一端点的都算）：停
    for (const key of this.ringingFor) if (!open.has(key)) this.ringingFor.delete(key)
    if (this.ringer.ringing && this.ringingFor.size === 0) {
      this.ringer.stop()
      changed = true
    }

    if (fresh.length > 0) {
      const prefs = this.out.prefs()
      const hidden = this.out.doc.visibilityState !== 'visible'
      for (const call of fresh) {
        this.inPage.set(alertKey(call), call)
        if (hidden) this.whileHidden.add(alertKey(call))
      }
      if (prefs.sound) {
        // 正在响：新来的也算进来、从现在重新计时（Ringer 只有一路）。只响一下的那一轮响完就不用记着
        for (const call of fresh) this.ringingFor.add(alertKey(call))
        this.ringer.start(ringDurationMs(prefs.ringFor))
        if (!this.ringer.ringing) this.ringingFor.clear()
      }
      if (prefs.notify && shouldNotifySystem(this.out.doc)) {
        for (const call of fresh) {
          const notification = this.out.systemNotify(call)
          if (notification) this.system.set(alertKey(call), notification)
        }
      }
    }
    if (fresh.length > 0 || changed) this.showInPage()
    this.syncTitle()
    return fresh
  }

  /** 标签页切到前台或后台时调用：回到前台就算看到了，标题恢复。 */
  visibilityChanged(): void {
    if (this.out.doc.visibilityState === 'visible') this.whileHidden.clear()
    this.syncTitle()
  }

  /** 人点了「知道了」或点了系统通知：不再响，页面里的提示照旧留着（只是不再有「知道了」）。 */
  acknowledge(): void {
    if (!this.ringer.ringing) return
    this.stopRinging()
    this.showInPage()
  }

  /** 设置改了：关了提示音就停；改了时长按新时长从这次响起时算，已经响够了就停。 */
  prefsChanged(): void {
    if (!this.ringer.ringing) return
    const prefs = this.out.prefs()
    if (prefs.sound) this.ringer.retime(ringDurationMs(prefs.ringFor))
    else this.ringer.stop()
    if (this.ringer.ringing) return
    this.ringingFor.clear()
    this.showInPage()
  }

  /** 人关掉了页面里的提示，或点了「去「现场」处理」：看到了，不再列着这些，也不再响。 */
  dismissInPage(): void {
    this.inPage.clear()
    this.stopRinging()
  }

  /** 在看板上提示过了（呼叫栏就在旁边）：不再记着这些，提示自己几秒后收起。 */
  forgetInPage(): void {
    this.inPage.clear()
  }

  /** 到了「现场」看板：呼叫栏已经列着，收起页面里的提示；正在响时留着（上面有「知道了」），响停了再收。 */
  enteredBoard(): void {
    if (this.ringer.ringing) {
      this.showInPage()
      return
    }
    this.inPage.clear()
    this.out.showInPage([], false)
  }

  /** 退出登录、离开后台时：停止响铃，关掉弹出去的通知，恢复标题。 */
  dispose(): void {
    this.stopRinging()
    for (const notification of this.system.values()) notification.close()
    this.system.clear()
    this.whileHidden.clear()
    this.inPage.clear()
    this.out.showInPage([], false)
    this.out.title(0)
  }

  private stopRinging(): void {
    this.ringer.stop()
    this.ringingFor.clear()
  }

  private showInPage(): void {
    this.out.showInPage([...this.inPage.values()], this.ringer.ringing)
  }

  private syncTitle(): void {
    this.out.title(this.out.doc.visibilityState === 'visible' ? 0 : this.whileHidden.size)
  }
}
