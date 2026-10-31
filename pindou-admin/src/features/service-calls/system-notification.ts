import type { ServiceCall } from '../../api/service-calls'
import { callerName, callPlace, claimNote } from './calls'

/**
 * 新呼叫的系统通知（浏览器的 Notification API，电脑右下角或右上角那种）。
 *
 * ★ 只用页面里的 Notification，不做 Web Push / Service Worker 推送：Chrome 的推送要经过谷歌的服务，国内基本连不上。
 *   所以页面得开着（最小化、放在后台标签页都行），关掉页面就收不到。
 * ★ 授权弹窗只能由用户点击触发（requestPermission 必须在点击回调里调用），拒绝过之后网页再也弹不出授权，
 *   只能由人到地址栏左侧的站点设置里改回「允许」。
 * ★ 安卓上的浏览器不许页面直接 new Notification（要 Service Worker），会抛错；遇到一次就当这个浏览器不支持。
 */
export type NotificationState = NotificationPermission | 'unsupported'

type NotificationApi = typeof Notification

let constructorRejected = false

function browserApi(): NotificationApi | null {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : null
}

/** 这个浏览器现在的通知授权：granted 允许、denied 拒绝、default 还没问过、unsupported 不支持。 */
export function notificationState(api: NotificationApi | null = browserApi()): NotificationState {
  if (!api || constructorRejected) return 'unsupported'
  return api.permission
}

/** 请求通知授权。必须在点击回调里调用，否则浏览器直接拒绝或不理。 */
export async function requestNotificationPermission(
  api: NotificationApi | null = browserApi(),
): Promise<NotificationState> {
  if (!api || constructorRejected) return 'unsupported'
  try {
    return await api.requestPermission()
  } catch {
    return notificationState(api)
  }
}

/**
 * 系统通知的文字：标题「B3 桌 · 2 号座 呼叫店员」，正文写顾客称呼和点了去哪。认领满 10 分钟还没处理、重新提醒的，
 * 正文里加上是谁说去了还没处理。
 */
export function callNotificationText(call: ServiceCall, now = Date.now()): { title: string; body: string } {
  const note = claimNote(call, now)
  const claim = note && !note.claimed ? `${note.text}。` : ''
  return { title: `${callPlace(call)} 呼叫店员`, body: `顾客：${callerName(call)}。${claim}点这里打开「现场」处理` }
}

/**
 * 这时候该不该弹系统通知：标签页不在前台（切走、最小化）或浏览器窗口不在最前面。
 * 人正看着这个页面时有页面里的提示和提示音，不再弹系统通知。
 */
export function shouldNotifySystem(doc: Pick<Document, 'visibilityState' | 'hasFocus'> = document): boolean {
  return doc.visibilityState !== 'visible' || !doc.hasFocus()
}

/**
 * 弹一条呼叫的系统通知。tag 用呼叫编号：同一条呼叫只留一条通知，不重复弹。
 * 通知一直留着直到点掉或这条呼叫被处理（requireInteraction，支持的浏览器上才有效）。
 * 点通知：把浏览器窗口切到前面、关掉通知，再由 onOpen 跳到「现场」。没授权、不支持或弹不出时返回 null。
 */
export function showCallNotification(
  call: ServiceCall,
  onOpen: () => void,
  api: NotificationApi | null = browserApi(),
): Notification | null {
  if (!api || constructorRejected || api.permission !== 'granted') return null
  const { title, body } = callNotificationText(call)
  let notification: Notification
  try {
    notification = new api(title, { body, tag: call.id, requireInteraction: true, lang: 'zh-CN', icon: '/favicon.png' })
  } catch {
    constructorRejected = true
    return null
  }
  notification.onclick = (event) => {
    event.preventDefault()
    window.focus()
    notification.close()
    onOpen()
  }
  return notification
}

/** 设置里「发一条试试」：确认这台电脑真的能弹出来（系统的勿扰模式、通知设置也可能把它拦下）。 */
export function showTestNotification(api: NotificationApi | null = browserApi()): boolean {
  if (!api || constructorRejected || api.permission !== 'granted') return false
  try {
    const notification = new api('呼叫提醒测试', {
      body: '能看到这条，顾客呼叫时就会这样提醒。',
      tag: 'service-call-test',
      lang: 'zh-CN',
      icon: '/favicon.png',
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return true
  } catch {
    constructorRejected = true
    return false
  }
}

/** 测试用：把「构造函数被拒」的记忆清掉。 */
export function resetNotificationSupportForTest(): void {
  constructorRejected = false
}
