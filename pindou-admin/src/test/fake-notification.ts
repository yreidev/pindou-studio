/** 假的浏览器 Notification：记下弹了哪些、请求过几次授权，可以模拟点击。 */
export function fakeNotificationApi(initial: NotificationPermission = 'granted') {
  const shown: FakeNotification[] = []
  const requests = { count: 0, answer: 'granted' as NotificationPermission }

  class FakeNotification {
    static permission: NotificationPermission = initial
    static async requestPermission(): Promise<NotificationPermission> {
      requests.count++
      FakeNotification.permission = requests.answer
      return requests.answer
    }
    readonly title: string
    readonly options: NotificationOptions
    closed = false
    onclick: ((event: Event) => void) | null = null
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title
      this.options = options
      shown.push(this)
    }
    close() {
      this.closed = true
    }
    /** 模拟人点了这条通知。 */
    click() {
      this.onclick?.(new Event('click', { cancelable: true }))
    }
  }

  return { api: FakeNotification as unknown as typeof Notification, Fake: FakeNotification, shown, requests }
}
