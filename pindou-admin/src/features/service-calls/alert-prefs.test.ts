import { describe, expect, it } from 'vitest'
import {
  alertPrefsKey,
  defaultAlertPrefs,
  loadAlertPrefs,
  parseAlertPrefs,
  saveAlertPrefs,
  type AlertPrefs,
} from './alert-prefs'

const prefs = (patch: Partial<AlertPrefs>): AlertPrefs => ({ ...defaultAlertPrefs, ...patch })

describe('呼叫提醒的偏好', () => {
  it('没存过时：提示音、系统通知都开，一直响到有人处理，音量 80', () => {
    expect(defaultAlertPrefs).toEqual({ sound: true, notify: true, ringFor: 'untilHandled', volume: 80 })
    expect(loadAlertPrefs()).toEqual(defaultAlertPrefs)
  })

  it('存了就按浏览器记住，刷新后照旧', () => {
    saveAlertPrefs(prefs({ sound: false }))
    expect(JSON.parse(window.localStorage.getItem(alertPrefsKey) ?? '')).toEqual({
      sound: false,
      notify: true,
      ringFor: 'untilHandled',
      volume: 80,
    })
    expect(loadAlertPrefs()).toEqual(prefs({ sound: false }))
    saveAlertPrefs({ sound: true, notify: false, ringFor: '30s', volume: 45 })
    expect(loadAlertPrefs()).toEqual({ sound: true, notify: false, ringFor: '30s', volume: 45 })
  })

  it('旧版本只存了两个开关：照读，响铃时长和音量补上默认值', () => {
    window.localStorage.setItem(alertPrefsKey, '{"sound":false,"notify":true}')
    expect(loadAlertPrefs()).toEqual({ sound: false, notify: true, ringFor: 'untilHandled', volume: 80 })
  })

  it('内容坏了回到默认；只坏了一项时只那一项按默认', () => {
    expect(parseAlertPrefs('不是 JSON')).toEqual(defaultAlertPrefs)
    expect(parseAlertPrefs('null')).toEqual(defaultAlertPrefs)
    expect(parseAlertPrefs('[1,2]')).toEqual(defaultAlertPrefs)
    expect(parseAlertPrefs('"on"')).toEqual(defaultAlertPrefs)
    expect(parseAlertPrefs('{"sound":"off","notify":false}')).toEqual(prefs({ notify: false }))
    expect(parseAlertPrefs('{"sound":false}')).toEqual(prefs({ sound: false }))
    // 不认识的时长、超出范围或不是数的音量
    expect(parseAlertPrefs('{"ringFor":"forever","volume":30}')).toEqual(prefs({ volume: 30 }))
    expect(parseAlertPrefs('{"ringFor":"1m","volume":130}')).toEqual(prefs({ ringFor: '1m' }))
    expect(parseAlertPrefs('{"ringFor":"once","volume":-1}')).toEqual(prefs({ ringFor: 'once' }))
    expect(parseAlertPrefs('{"volume":"80"}')).toEqual(defaultAlertPrefs)
    expect(parseAlertPrefs('{"volume":null}')).toEqual(defaultAlertPrefs)
    // 音量 0 是有效的（开着但不出声），小数取整
    expect(parseAlertPrefs('{"volume":0}')).toEqual(prefs({ volume: 0 }))
    expect(parseAlertPrefs('{"volume":42.6}')).toEqual(prefs({ volume: 43 }))
  })

  it('存储读写抛错（隐私模式、站点数据被禁）时不影响页面：读按默认，写静默放弃', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadAlertPrefs(broken)).toEqual(defaultAlertPrefs)
    expect(() => saveAlertPrefs(prefs({ sound: false, notify: false }), broken)).not.toThrow()
    expect(loadAlertPrefs(null)).toEqual(defaultAlertPrefs)
  })

  it('返回的是新对象，改了不会改到默认值', () => {
    const loaded = loadAlertPrefs()
    loaded.sound = false
    loaded.volume = 10
    expect(defaultAlertPrefs.sound).toBe(true)
    expect(defaultAlertPrefs.volume).toBe(80)
  })
})
