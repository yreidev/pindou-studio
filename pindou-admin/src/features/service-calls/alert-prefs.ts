/**
 * 呼叫提醒的偏好：提示音开不开、响多久、多大声，系统通知开不开。按浏览器存在 localStorage，只对这台电脑的这个浏览器有效，
 * 不进后端（不是业务数据，换台电脑各设各的）。
 *
 * 默认都开、一直响到有人处理、音量 80：提示音开着要等页面被点过一下才响得出来（浏览器的自动播放限制），
 * 系统通知开着也要浏览器授权才弹。读不到（隐私模式、存储被禁、内容坏了）一律按默认值，某一项坏了只把那一项按默认；
 * 旧版本只存了两个开关，读出来时其余几项补上默认值。
 */
export type RingFor = 'once' | '30s' | '1m' | 'untilHandled'

export interface AlertPrefs {
  sound: boolean
  notify: boolean
  /** 响铃时长：响一下、响 30 秒、响 1 分钟、一直响到有人处理（最长 5 分钟）。 */
  ringFor: RingFor
  /** 音量 0–100。 */
  volume: number
}

export const defaultAlertPrefs: AlertPrefs = { sound: true, notify: true, ringFor: 'untilHandled', volume: 80 }

export const alertPrefsKey = 'pindou-admin.call-alerts'

/** 「一直响到有人处理」最长响多久：没人理也不能一直响下去。 */
export const ringCapMs = 5 * 60_000

/** 「提醒设置」里的选项，按这个顺序列出。 */
export const ringOptions: readonly { value: RingFor; label: string }[] = [
  { value: 'once', label: '响一下' },
  { value: '30s', label: '响 30 秒' },
  { value: '1m', label: '响 1 分钟' },
  { value: 'untilHandled', label: '一直响到有人处理（最长 5 分钟）' },
]

/** 这一档从响起到停下最长多久；0 表示只响一轮。 */
export function ringDurationMs(ringFor: RingFor): number {
  switch (ringFor) {
    case 'once':
      return 0
    case '30s':
      return 30_000
    case '1m':
      return 60_000
    case 'untilHandled':
      return ringCapMs
  }
}

/** 存储读写可能直接抛错（隐私模式、站点数据被禁），由调用方传入便于测试。 */
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStore(): Store | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function isRingFor(value: unknown): value is RingFor {
  return ringOptions.some((option) => option.value === value)
}

export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (!raw) return { ...defaultAlertPrefs }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ...defaultAlertPrefs }
  }
  const stored = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const flag = (key: 'sound' | 'notify') =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : defaultAlertPrefs[key]
  const volume = stored.volume
  return {
    sound: flag('sound'),
    notify: flag('notify'),
    ringFor: isRingFor(stored.ringFor) ? stored.ringFor : defaultAlertPrefs.ringFor,
    volume:
      typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 100
        ? Math.round(volume)
        : defaultAlertPrefs.volume,
  }
}

export function loadAlertPrefs(store: Store | null = browserStore()): AlertPrefs {
  try {
    return parseAlertPrefs(store?.getItem(alertPrefsKey) ?? null)
  } catch {
    return { ...defaultAlertPrefs }
  }
}

export function saveAlertPrefs(prefs: AlertPrefs, store: Store | null = browserStore()): void {
  const { sound, notify, ringFor, volume } = prefs
  try {
    store?.setItem(alertPrefsKey, JSON.stringify({ sound, notify, ringFor, volume }))
  } catch {
    // 存不进去：这次打开页面期间照样按选的来，刷新后回到默认
  }
}
