import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServiceCall } from '../../api/service-calls'
import { fakeNotificationApi } from '../../test/fake-notification'
import {
  callNotificationText,
  notificationState,
  requestNotificationPermission,
  resetNotificationSupportForTest,
  shouldNotifySystem,
  showCallNotification,
  showTestNotification,
} from './system-notification'

const call = (patch: Partial<ServiceCall> = {}): ServiceCall => ({
  id: 'call-1',
  venueSessionId: 's-1',
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

afterEach(() => {
  resetNotificationSupportForTest()
  vi.restoreAllMocks()
})

describe('系统通知', () => {
  it('文字：标题写哪桌哪座呼叫店员，正文写顾客称呼', () => {
    expect(callNotificationText(call())).toEqual({
      title: 'B3 桌 · 2 号座 呼叫店员',
      body: '顾客：小林。点这里打开「现场」处理',
    })
    expect(callNotificationText(call({ seatNumber: 0, customer: null })).title).toBe('B3 桌 呼叫店员')
    expect(callNotificationText(call({ customer: null })).body).toContain('顾客：顾客')
    // 认领满 10 分钟还没处理、重新提醒的：写上是谁说去了还没处理
    const lapsed = call({
      claimStatus: 'lapsed',
      claimedAt: '2026-10-05T06:01:00Z',
      claimedBy: { id: 'u-zhou', nickname: '小周', phoneMasked: '139****0001' },
    })
    expect(callNotificationText(lapsed, Date.parse('2026-10-05T06:13:00Z')).body).toBe(
      '顾客：小林。小周 12 分钟前说去处理，还没处理。点这里打开「现场」处理',
    )
  })

  it('授权状态如实读：不支持、还没问、允许、拒绝', () => {
    expect(notificationState(null)).toBe('unsupported')
    for (const permission of ['default', 'granted', 'denied'] as const)
      expect(notificationState(fakeNotificationApi(permission).api)).toBe(permission)
  })

  it('请求授权：浏览器怎么答就返回什么；不支持时不请求', async () => {
    const fake = fakeNotificationApi('default')
    expect(await requestNotificationPermission(fake.api)).toBe('granted')
    expect(fake.requests.count).toBe(1)
    const refusing = fakeNotificationApi('default')
    refusing.requests.answer = 'denied'
    expect(await requestNotificationPermission(refusing.api)).toBe('denied')
    expect(await requestNotificationPermission(null)).toBe('unsupported')
  })

  it('允许了才弹：tag 用呼叫编号，同一条呼叫只留一条通知', () => {
    const fake = fakeNotificationApi('granted')
    const note = showCallNotification(call(), () => {}, fake.api)
    expect(note).not.toBeNull()
    expect(fake.shown).toHaveLength(1)
    expect(fake.shown[0].title).toBe('B3 桌 · 2 号座 呼叫店员')
    expect(fake.shown[0].options).toMatchObject({ body: '顾客：小林。点这里打开「现场」处理', tag: 'call-1' })

    for (const permission of ['default', 'denied'] as const) {
      const other = fakeNotificationApi(permission)
      expect(showCallNotification(call(), () => {}, other.api)).toBeNull()
      expect(other.shown).toHaveLength(0)
    }
    expect(showCallNotification(call(), () => {}, null)).toBeNull()
  })

  it('点通知：把浏览器窗口切到前面、关掉通知、去「现场」', () => {
    const fake = fakeNotificationApi('granted')
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const open = vi.fn()
    showCallNotification(call(), open, fake.api)
    fake.shown[0].click()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(fake.shown[0].closed).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('安卓浏览器不许页面直接弹（构造时抛错）：之后当作不支持', () => {
    const fake = fakeNotificationApi('granted')
    const Throwing = class {
      static permission = 'granted'
      static requestPermission = fake.api.requestPermission
      constructor() {
        throw new TypeError('Illegal constructor')
      }
    } as unknown as typeof Notification
    expect(showCallNotification(call(), () => {}, Throwing)).toBeNull()
    expect(notificationState(fake.api)).toBe('unsupported')
    expect(showTestNotification(fake.api)).toBe(false)
  })

  it('什么时候弹：标签页在后台或窗口不在最前面；人正看着页面时不弹', () => {
    expect(shouldNotifySystem({ visibilityState: 'hidden', hasFocus: () => false })).toBe(true)
    expect(shouldNotifySystem({ visibilityState: 'hidden', hasFocus: () => true })).toBe(true)
    expect(shouldNotifySystem({ visibilityState: 'visible', hasFocus: () => false })).toBe(true)
    expect(shouldNotifySystem({ visibilityState: 'visible', hasFocus: () => true })).toBe(false)
  })

  it('发一条试试：允许了才发', () => {
    const fake = fakeNotificationApi('granted')
    expect(showTestNotification(fake.api)).toBe(true)
    expect(fake.shown[0].title).toBe('呼叫提醒测试')
    expect(showTestNotification(fakeNotificationApi('denied').api)).toBe(false)
  })
})
