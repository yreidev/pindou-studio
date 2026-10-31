import { describe, expect, it } from 'vitest'
import type { ServiceCall } from '../../api/service-calls'
import { fakeClock } from '../../test/fake-clock'
import { CallAlertCenter } from './alert-center'
import { defaultAlertPrefs, type AlertPrefs } from './alert-prefs'

const call = (id: string, tableCode = 'B3', seatNumber = 2, patch: Partial<ServiceCall> = {}): ServiceCall => ({
  id,
  venueSessionId: `s-${id}`,
  serviceTableId: 't-1',
  tableCode,
  seatNumber,
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

const zhou = { id: 'u-zhou', nickname: '小周', phoneMasked: '139****0001' }
/** 小周在 claimedAt 点了「我去处理」：此刻认领着（claimed），或认领满 10 分钟还没处理（lapsed）。 */
const claimed = (id: string, claimStatus: 'claimed' | 'lapsed', claimedAt = '2026-10-05T06:01:00Z') =>
  call(id, 'B3', 2, { claimStatus, claimedAt, claimedBy: zhou })

/**
 * 记下每种提醒发了什么；标签页可见与否、窗口有没有焦点、偏好都可以随时改。
 * 持续响铃用假钟，time.advance 让时间往前走。
 */
function setup(initial: Partial<AlertPrefs> = {}) {
  const time = fakeClock()
  const env = {
    prefs: { ...defaultAlertPrefs, ...initial } as AlertPrefs,
    doc: { visibilityState: 'visible' as DocumentVisibilityState, focused: true },
    sounds: 0,
    system: [] as { id: string; closed: boolean }[],
    inPage: [] as string[][],
    /** 每次更新页面提示时是不是正在响（提示上有没有「知道了」）。 */
    ringingShown: [] as boolean[],
    titles: [] as number[],
  }
  const center = new CallAlertCenter({
    prefs: () => env.prefs,
    doc: {
      get visibilityState() {
        return env.doc.visibilityState
      },
      hasFocus: () => env.doc.focused,
    },
    sound: () => {
      env.sounds++
    },
    systemNotify: (c) => {
      const note = { id: c.id, closed: false }
      env.system.push(note)
      return {
        close: () => {
          note.closed = true
        },
      }
    },
    showInPage: (calls, ringing) => {
      env.inPage.push(calls.map((c) => `${c.id}@${c.tableCode}`))
      env.ringingShown.push(ringing)
    },
    title: (count) => env.titles.push(count),
    clock: time.clock,
  })
  return { env, center, time }
}

describe('全站呼叫提醒', () => {
  it('打开页面时已挂着的不提醒；之后新到的才响、才弹', () => {
    const { env, center } = setup()
    expect(center.update([call('a')])).toEqual([])
    expect(env.sounds).toBe(0)
    expect(env.inPage).toEqual([])

    expect(center.update([call('a'), call('b', 'C1')]).map((c) => c.id)).toEqual(['b'])
    expect(env.sounds).toBe(1)
    expect(env.inPage.at(-1)).toEqual(['b@C1'])
    // 人正看着页面（前台、窗口有焦点）：不弹系统通知
    expect(env.system).toEqual([])

    // 同样的列表再读一次（30 秒兜底重读）：不重复提醒
    center.update([call('a'), call('b', 'C1')])
    expect(env.sounds).toBe(1)
    expect(env.inPage).toHaveLength(1)
  })

  it('一次来了好几条只响一次，系统通知每条一条', () => {
    const { env, center } = setup()
    center.update([])
    env.doc.focused = false
    center.update([call('a'), call('b')])
    expect(env.sounds).toBe(1)
    expect(env.system.map((n) => n.id)).toEqual(['a', 'b'])
    expect(env.inPage.at(-1)).toEqual(['a@B3', 'b@B3'])
  })

  it('标签页在后台：弹系统通知，标题数后台来了几条；切回前台标题恢复', () => {
    const { env, center } = setup()
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a')])
    expect(env.system.map((n) => n.id)).toEqual(['a'])
    expect(env.titles.at(-1)).toBe(1)
    center.update([call('a'), call('b')])
    expect(env.titles.at(-1)).toBe(2)

    env.doc.visibilityState = 'visible'
    center.visibilityChanged()
    expect(env.titles.at(-1)).toBe(0)
    // 再切到后台：之前那两条已经看过了，不再算
    env.doc.visibilityState = 'hidden'
    center.visibilityChanged()
    expect(env.titles.at(-1)).toBe(0)
  })

  it('呼叫被处理（列表里没了）：关掉它的系统通知，标题和页面提示跟着减', () => {
    const { env, center } = setup()
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a'), call('b')])
    expect(env.titles.at(-1)).toBe(2)

    center.update([call('b')])
    expect(env.system.find((n) => n.id === 'a')?.closed).toBe(true)
    expect(env.system.find((n) => n.id === 'b')?.closed).toBe(false)
    expect(env.titles.at(-1)).toBe(1)
    expect(env.inPage.at(-1)).toEqual(['b@B3'])

    center.update([])
    expect(env.titles.at(-1)).toBe(0)
    expect(env.inPage.at(-1)).toEqual([])
  })

  it('有人点了「我去处理」（手机上、网页上、自己点的都算）：停响，关掉它的系统通知，标题和页面提示跟着减', () => {
    const { env, center, time } = setup()
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a'), call('b')])
    expect(center.ringing).toBe(true)
    expect(env.titles.at(-1)).toBe(2)

    // a 被认领：还在未处理列表里，但不再提醒
    center.update([claimed('a', 'claimed'), call('b')])
    expect(env.system.find((n) => n.id === 'a')?.closed).toBe(true)
    expect(env.system.find((n) => n.id === 'b')?.closed).toBe(false)
    expect(env.titles.at(-1)).toBe(1)
    expect(env.inPage.at(-1)).toEqual(['b@B3'])
    expect(center.ringing).toBe(true)

    // b 也被认领：引起响铃的都有人去了，停
    const sounds = env.sounds
    center.update([claimed('a', 'claimed'), claimed('b', 'claimed')])
    expect(center.ringing).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(sounds)
    expect(env.titles.at(-1)).toBe(0)
    expect(env.inPage.at(-1)).toEqual([])
    // 认领不是新到：之后重读也不再响
    center.update([claimed('a', 'claimed'), claimed('b', 'claimed')])
    expect(env.sounds).toBe(sounds)
  })

  it('认领满 10 分钟还没处理：当作新到重新提醒；再有人认领又停，再失效又是新的一次', () => {
    const { env, center } = setup()
    center.update([call('a')])
    center.update([claimed('a', 'claimed')])
    expect(env.sounds).toBe(0)

    // 后端按时间标成 lapsed：响、提示、弹通知
    env.doc.focused = false
    expect(center.update([claimed('a', 'lapsed')]).map((c) => c.id)).toEqual(['a'])
    expect(env.sounds).toBe(1)
    expect(center.ringing).toBe(true)
    expect(env.inPage.at(-1)).toEqual(['a@B3'])
    expect(env.system.map((n) => n.id)).toEqual(['a'])
    // 兜底重读还是这次失效：不重复提醒
    center.update([claimed('a', 'lapsed')])
    expect(env.sounds).toBe(1)
    expect(env.system).toHaveLength(1)

    // 有人接手：停，通知关掉
    center.update([claimed('a', 'claimed', '2026-10-05T06:12:00Z')])
    expect(center.ringing).toBe(false)
    expect(env.system[0].closed).toBe(true)
    expect(env.inPage.at(-1)).toEqual([])
    // 接手的人也没处理，又满 10 分钟：再提醒一次
    expect(center.update([claimed('a', 'lapsed', '2026-10-05T06:12:00Z')]).map((c) => c.id)).toEqual(['a'])
    expect(env.sounds).toBe(2)
    expect(env.system).toHaveLength(2)
  })

  it('打开页面时已经认领失效的也不算新到（同打开时已挂着的呼叫）', () => {
    const { env, center } = setup()
    expect(center.update([claimed('a', 'lapsed')])).toEqual([])
    expect(env.sounds).toBe(0)
    expect(center.update([claimed('a', 'lapsed')])).toEqual([])
  })

  it('顾客换了座：页面提示里写新位置', () => {
    const { env, center } = setup()
    center.update([])
    center.update([call('a', 'B3')])
    center.update([call('a', 'D1'), call('b', 'C1')])
    expect(env.inPage.at(-1)).toEqual(['a@D1', 'b@C1'])
  })

  it('关掉提示音或系统通知后：不响、不弹，页面提示照常', () => {
    const { env, center } = setup({ sound: false, notify: false })
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a')])
    expect(env.sounds).toBe(0)
    expect(env.system).toEqual([])
    expect(env.inPage.at(-1)).toEqual(['a@B3'])
    expect(env.titles.at(-1)).toBe(1)

    // 设置随时改，下一条按新的来
    env.prefs = { ...defaultAlertPrefs }
    center.update([call('a'), call('b')])
    expect(env.sounds).toBe(1)
    expect(env.system.map((n) => n.id)).toEqual(['b'])
  })

  it('人关掉了页面提示：之后只列再来的', () => {
    const { env, center } = setup()
    center.update([])
    center.update([call('a')])
    center.dismissInPage()
    center.update([call('a'), call('b')])
    expect(env.inPage.at(-1)).toEqual(['b@B3'])
    // 关掉之后 a 被处理，不必再动页面提示
    const before = env.inPage.length
    center.update([call('b')])
    expect(env.inPage).toHaveLength(before)
  })

  it('退出登录：关掉弹出去的系统通知、收起提示、恢复标题', () => {
    const { env, center } = setup()
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a')])
    center.dispose()
    expect(env.system[0].closed).toBe(true)
    expect(env.inPage.at(-1)).toEqual([])
    expect(env.titles.at(-1)).toBe(0)
  })
})

describe('提示音的响铃时长', () => {
  it('默认一直响到有人处理：每 4 秒一轮，呼叫在别处被处理（接口不再返回它）就停', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    expect(env.sounds).toBe(1)
    expect(center.ringing).toBe(true)
    // 提示上有「知道了」
    expect(env.ringingShown.at(-1)).toBe(true)
    time.advance(12_000)
    expect(env.sounds).toBe(4)
    // 兜底重读还是那一条：接着响，不另起一路
    center.update([call('a')])
    time.advance(4_000)
    expect(env.sounds).toBe(5)

    // 店员在手机上点了已处理：重读后列表里没了，停
    center.update([])
    expect(center.ringing).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(5)
    expect(env.inPage.at(-1)).toEqual([])
  })

  it('一直没人处理：最长响 5 分钟，停了以后提示留着、收起「知道了」', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    time.advance(5 * 60_000)
    expect(env.sounds).toBe(75)
    expect(center.ringing).toBe(false)
    expect(env.inPage.at(-1)).toEqual(['a@B3'])
    expect(env.ringingShown.at(-1)).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(75)
  })

  it('响 30 秒、响 1 分钟：满了就停；响一下只响一轮，提示上没有「知道了」', () => {
    for (const [ringFor, rounds] of [
      ['30s', 8],
      ['1m', 15],
      ['once', 1],
    ] as const) {
      const { env, center, time } = setup({ ringFor })
      center.update([])
      center.update([call('a')])
      expect(env.ringingShown.at(-1)).toBe(ringFor !== 'once')
      time.advance(10 * 60_000)
      expect(env.sounds).toBe(rounds)
      expect(center.ringing).toBe(false)
    }
  })

  it('几条一起响：都处理了才停，处理掉一条不停', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a'), call('b')])
    center.update([call('b')])
    expect(center.ringing).toBe(true)
    time.advance(4_000)
    expect(env.sounds).toBe(2)
    center.update([])
    expect(center.ringing).toBe(false)
  })

  it('响着时又来新呼叫：马上响一轮、从新呼叫起重新计时，只有一路；之前那条处理了也接着响', () => {
    const { env, center, time } = setup({ ringFor: '30s' })
    center.update([])
    center.update([call('a')])
    time.advance(18_000) // 0…16 秒响了 5 轮
    expect(env.sounds).toBe(5)
    center.update([call('a'), call('b')])
    expect(env.sounds).toBe(6)
    // 原来那一路本该在 20 秒响，没有了；新的一路在 22 秒（18 + 4）响
    time.advance(2_000)
    expect(env.sounds).toBe(6)
    time.advance(2_000)
    expect(env.sounds).toBe(7)
    // a 处理了，b 还挂着：接着响
    center.update([call('b')])
    expect(center.ringing).toBe(true)
    // 从 18 秒起响满 30 秒（到 48 秒）：18、22、…、46 共 8 轮
    time.advance(25_999)
    expect(center.ringing).toBe(true)
    time.advance(1)
    expect(center.ringing).toBe(false)
    expect(env.sounds).toBe(5 + 8)
  })

  it('点「知道了」（或点了系统通知）：停，页面提示留着、不再有「知道了」；再来新呼叫重新响', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    time.advance(4_000)
    center.acknowledge()
    expect(center.ringing).toBe(false)
    expect(env.inPage.at(-1)).toEqual(['a@B3'])
    expect(env.ringingShown.at(-1)).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(2)

    // 新来一条：只为它响，a 不再算（已经知道了）
    center.update([call('a'), call('b')])
    expect(env.sounds).toBe(3)
    expect(env.ringingShown.at(-1)).toBe(true)
    // b 处理了：a 还挂着也停
    center.update([call('a')])
    expect(center.ringing).toBe(false)
  })

  it('关掉页面提示、点「去现场处理」也算看到了：停', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    center.dismissInPage()
    expect(center.ringing).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(1)
  })

  it('关掉提示音：马上停；改了时长按新时长从响起时算', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    time.advance(40_000)
    env.prefs = { ...env.prefs, ringFor: '1m' }
    center.prefsChanged()
    expect(center.ringing).toBe(true)
    env.prefs = { ...env.prefs, ringFor: '30s' }
    center.prefsChanged()
    expect(center.ringing).toBe(false)
    expect(env.ringingShown.at(-1)).toBe(false)

    center.update([call('a'), call('b')])
    expect(center.ringing).toBe(true)
    const before = env.sounds
    env.prefs = { ...env.prefs, sound: false }
    center.prefsChanged()
    expect(center.ringing).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(before)
    // 改音量不影响在不在响
    center.prefsChanged()
    expect(center.ringing).toBe(false)
  })

  it('系统通知每条只弹一次，不随每轮响铃再弹', () => {
    const { env, center, time } = setup()
    center.update([])
    env.doc.visibilityState = 'hidden'
    center.update([call('a')])
    time.advance(60_000)
    center.update([call('a')])
    time.advance(60_000)
    expect(env.sounds).toBeGreaterThan(20)
    expect(env.system.map((n) => n.id)).toEqual(['a'])
  })

  it('到了看板：没在响就收起提示；正在响就留着（上面有「知道了」）', () => {
    const { env, center } = setup()
    center.update([])
    center.update([call('a')])
    center.enteredBoard()
    expect(env.inPage.at(-1)).toEqual(['a@B3'])
    expect(env.ringingShown.at(-1)).toBe(true)
    center.acknowledge()
    center.enteredBoard()
    expect(env.inPage.at(-1)).toEqual([])
  })

  it('退出登录：停止响铃', () => {
    const { env, center, time } = setup()
    center.update([])
    center.update([call('a')])
    center.dispose()
    expect(center.ringing).toBe(false)
    time.advance(60_000)
    expect(env.sounds).toBe(1)
    expect(time.pending()).toBe(0)
  })
})
