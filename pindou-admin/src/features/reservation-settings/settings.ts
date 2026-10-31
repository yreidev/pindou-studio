import { z } from 'zod'
import type { ReservationEntry, ReservationSettings } from '../../api/reservations'
import { dateOnly } from '../../lib/format'

// 预约设置表单：字段与校验严格照后端 reservations/domain 的 Settings.Validate 与 docs/api.yaml。
// 时间按中国时区，存的是从当天 00:00 起的分钟数；结束可以是 24:00（1440）。
// 门店电话、微信号可选，给小程序的顾客看（超限提示、包间说明、预约须知），去掉首尾空白后再校验，空的不提交。
// 门店地址和经纬度（2026-10-20 起）可选，小程序首页门店一行显示地址、按经纬度导航；经纬度要么都填要么都不填。
// 歇业日期是门店时区的日期（YYYY-MM-DD），每周休息日 1 周一 … 7 周日；爽约 N 次后暂停自助预约（0 不限制），统计最近 D 天。
// 提前几小时提醒（2026-10-20 起）：开始前几小时给允许了微信提醒的顾客发一条，0 不提醒；没设置过时接口不返回，按 2 小时算。

export type SettingsKey = keyof ReservationSettings
type ContactKey = 'contactPhone' | 'contactWechat' | 'address'
type CoordKey = 'latitude' | 'longitude'
type ListKey = 'closedDates' | 'closedWeekdays'
type ClockKey = 'openMinute' | 'closeMinute'
type WholeKey = Exclude<SettingsKey, 'enabled' | ListKey | ClockKey | ContactKey | CoordKey>
type SettingValue = number | boolean | string | string[] | number[]

/**
 * 表单里的值：开关是布尔，歇业日期与每周休息日是列表，时间、联系方式与经纬度是输入框里的文字（时间提交前转成分钟数）；
 * 分钟数、天数、次数用数字输入框，是数字，清空了是 null。
 */
export type SettingsFormValues = { enabled: boolean; closedDates: string[]; closedWeekdays: number[] } & Record<
  ClockKey | ContactKey | CoordKey,
  string
> &
  Record<WholeKey, number | null>

export const settingsFields: { key: SettingsKey; label: string }[] = [
  { key: 'enabled', label: '顾客自助预约' },
  { key: 'openMinute', label: '每天开始接待' },
  { key: 'closeMinute', label: '每天最晚结束' },
  { key: 'slotMinutes', label: '时段粒度' },
  { key: 'advanceDays', label: '最多提前' },
  { key: 'leadMinutes', label: '最短提前' },
  { key: 'graceMinutes', label: '迟到宽限' },
  { key: 'closedDates', label: '歇业日期' },
  { key: 'closedWeekdays', label: '每周休息日' },
  { key: 'noShowLimit', label: '爽约暂停' },
  { key: 'noShowWindowDays', label: '爽约统计' },
  { key: 'remindHours', label: '微信提醒' },
  { key: 'contactPhone', label: '门店电话' },
  { key: 'contactWechat', label: '门店微信号' },
  { key: 'address', label: '门店地址' },
  { key: 'latitude', label: '门店纬度' },
  { key: 'longitude', label: '门店经度' },
]

/** 歇业日期最多几个（已经过去的不算，后端读取时就不再返回）。 */
export const maxClosedDates = 90

/** 1 周一 … 7 周日。 */
export const weekdayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

const isContact = (key: SettingsKey): key is ContactKey =>
  key === 'contactPhone' || key === 'contactWechat' || key === 'address'
const isCoord = (key: SettingsKey): key is CoordKey => key === 'latitude' || key === 'longitude'
/** 改的只是门店联系方式和地址（不影响预约）。 */
export const isContactSetting = (key: SettingsKey) => isContact(key) || isCoord(key)
const isList = (key: SettingsKey): key is ListKey => key === 'closedDates' || key === 'closedWeekdays'

/** 门店电话：数字、空格、+、-、括号，去掉首尾空白后最多 20 个字符；空表示不填。 */
export const contactPhoneValid = (text: string) => /^[0-9 +()-]{0,20}$/.test(text.trim())

/** 门店微信号：去掉首尾空白后最多 40 个字符，中间不能有空白；空表示不填。 */
export const contactWechatValid = (text: string) => {
  const value = text.trim()
  return Array.from(value).length <= 40 && !/[\s\p{Cc}]/u.test(value)
}

/** 门店地址：去掉首尾空白后最多 100 个字，不能换行；空表示不填。 */
export const addressValid = (text: string) => {
  const value = text.trim()
  return Array.from(value).length <= 100 && !/\p{Cc}/u.test(value)
}

/** 经纬度的范围：纬度 -90～90，经度 -180～180。 */
const coordLimits = { latitude: 90, longitude: 180 } as const

/** 输入框里的纬度或经度 → 数；空的是 ''（不填），不是数或超出范围是 null。 */
export function parseCoord(key: CoordKey, text: string): number | '' | null {
  const value = text.trim()
  if (!value) return ''
  if (!/^-?\d{1,3}(\.\d+)?$/.test(value)) return null
  const number = Number(value)
  return Math.abs(number) <= coordLimits[key] ? number : null
}

/**
 * 从腾讯地图坐标拾取器复制来的「纬度,经度」（如 39.118,117.199，逗号可以是中文的）拆成两项；不是这种写法返回 null。
 * 填在纬度框里时一次填好两项。
 */
export function splitCoordPair(text: string): { latitude: string; longitude: string } | null {
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text)
  return match ? { latitude: match[1], longitude: match[2] } : null
}

/** 没设置过提前几小时提醒时后端按几小时算（照后端 DefaultRemindHours）。 */
export const defaultRemindHours = 2

/** 设置里某一项的值；没填的联系方式、地址和经纬度接口不返回，当作空串；没设置过的提醒按默认小时数。 */
export const settingValue = (settings: ReservationSettings, key: SettingsKey): SettingValue =>
  key === 'remindHours' ? (settings.remindHours ?? defaultRemindHours) : (settings[key] ?? '')

const pad = (value: number) => String(value).padStart(2, '0')

/** 分钟数 → 「时:分」，1440 → 24:00。 */
export function clockLabel(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
}

/** 「时:分」→ 分钟数，允许 9:00 和 24:00；不合法返回 null。 */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2})[:：](\d{2})$/.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null
  return hour * 60 + minute
}

/** 数字输入框里的整数；没填、不是整数或超出范围返回 null。 */
export function wholeIn(value: number | null, min: number, max: number): number | null {
  return value !== null && Number.isInteger(value) && value >= min && value <= max ? value : null
}

/** 门店日期（YYYY-MM-DD）是周几：1 周一 … 7 周日。日期本身不带时区，按日历算。 */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay() || 7
}

/** 「2026-10-08」→「10-08 周四」。 */
export function dayLabel(day: string): string {
  return `${day.slice(5)} ${weekdayNames[weekdayOf(day)]}`
}

/** 按这份设置，门店日期 day 是不是歇业日（设了的歇业日期，或每周休息日）。 */
export function closedOn(settings: { closedDates: string[]; closedWeekdays: number[] }, day: string): boolean {
  return settings.closedDates.includes(day) || settings.closedWeekdays.includes(weekdayOf(day))
}

/** 加一个歇业日期：去重、按日期排好。 */
export function addClosedDate(dates: string[], day: string): string[] {
  return [...new Set([...dates, day])].sort()
}

/** 分钟数、天数、次数能填的范围（照后端 Settings.Validate）。 */
export const wholeLimits = {
  slotMinutes: [5, 240],
  advanceDays: [1, 90],
  leadMinutes: [0, 1440],
  graceMinutes: [5, 240],
  noShowLimit: [0, 20],
  noShowWindowDays: [1, 365],
  remindHours: [0, 24],
} as const

/** 表单里的值 → 设置值；不合法返回 null。 */
function parseField(key: SettingsKey, values: SettingsFormValues): SettingValue | null {
  if (key === 'enabled') return values.enabled
  if (key === 'closedDates') return [...new Set(values.closedDates)].sort()
  if (key === 'closedWeekdays') return [...new Set(values.closedWeekdays)].sort((a, b) => a - b)
  if (key === 'contactPhone') return contactPhoneValid(values[key]) ? values[key].trim() : null
  if (key === 'contactWechat') return contactWechatValid(values[key]) ? values[key].trim() : null
  if (key === 'address') return addressValid(values[key]) ? values[key].trim() : null
  if (isCoord(key)) return parseCoord(key, values[key])
  if (key === 'openMinute' || key === 'closeMinute') return parseClock(values[key])
  const [min, max] = wholeLimits[key]
  return wholeIn(values[key], min, max)
}

export function toFormValues(settings: ReservationSettings): SettingsFormValues {
  return {
    enabled: settings.enabled,
    openMinute: clockLabel(settings.openMinute),
    closeMinute: clockLabel(settings.closeMinute),
    slotMinutes: settings.slotMinutes,
    advanceDays: settings.advanceDays,
    leadMinutes: settings.leadMinutes,
    graceMinutes: settings.graceMinutes,
    closedDates: [...settings.closedDates],
    closedWeekdays: [...settings.closedWeekdays],
    noShowLimit: settings.noShowLimit,
    noShowWindowDays: settings.noShowWindowDays,
    remindHours: settings.remindHours ?? defaultRemindHours,
    contactPhone: settings.contactPhone ?? '',
    contactWechat: settings.contactWechat ?? '',
    address: settings.address ?? '',
    latitude: settings.latitude === undefined ? '' : String(settings.latitude),
    longitude: settings.longitude === undefined ? '' : String(settings.longitude),
  }
}

const clock = z.string().refine((value) => parseClock(value) !== null, '请按「时:分」填写，例如 09:00，最晚 24:00')
// 没填（null）、小数、超出范围都报同一句，说清能填多少
const whole = (key: WholeKey, message: string) =>
  z
    .number({ error: message })
    .nullable()
    .refine((value) => wholeIn(value, wholeLimits[key][0], wholeLimits[key][1]) !== null, message)

export const settingsFormSchema = z
  .object({
    enabled: z.boolean(),
    openMinute: clock,
    closeMinute: clock,
    slotMinutes: whole('slotMinutes', '填 5–240 之间的整数分钟'),
    advanceDays: whole('advanceDays', '填 1–90 之间的整数天'),
    leadMinutes: whole('leadMinutes', '填 0–1440 之间的整数分钟'),
    graceMinutes: whole('graceMinutes', '填 5–240 之间的整数分钟'),
    closedDates: z.array(z.string()).max(maxClosedDates, `歇业日期最多设 ${maxClosedDates} 个`),
    closedWeekdays: z.array(z.number().int().min(1).max(7)).max(6, '每周最多休 6 天；整周都不接待请关闭顾客自助预约'),
    noShowLimit: whole('noShowLimit', '填 0–20 之间的整数，0 表示不限制'),
    noShowWindowDays: whole('noShowWindowDays', '填 1–365 之间的整数天'),
    remindHours: whole('remindHours', '填 0–24 之间的整数小时，0 表示不提醒'),
    contactPhone: z.string().refine(contactPhoneValid, '只能填数字、空格、+、-、括号，最多 20 个字符'),
    contactWechat: z.string().refine(contactWechatValid, '最多 40 个字符，不能有空格'),
    address: z.string().refine(addressValid, '最多 100 个字，不能换行'),
    latitude: z
      .string()
      .refine((value) => parseCoord('latitude', value) !== null, '纬度是 -90～90 之间的数，如 39.118'),
    longitude: z
      .string()
      .refine((value) => parseCoord('longitude', value) !== null, '经度是 -180～180 之间的数，如 117.199'),
  })
  .superRefine((values, ctx) => {
    const open = parseClock(values.openMinute)
    const close = parseClock(values.closeMinute)
    const slot = wholeIn(values.slotMinutes, ...wholeLimits.slotMinutes)
    if (open !== null && close !== null && close - open < 60)
      ctx.addIssue({ code: 'custom', path: ['closeMinute'], message: '最晚结束要比开始接待至少晚 1 小时' })
    if (open !== null && slot !== null && open % slot !== 0)
      ctx.addIssue({
        code: 'custom',
        path: ['openMinute'],
        message: `开始接待须落在 ${slot} 分钟一档的时间上（从 00:00 起算），例如 ${clockLabel(open - (open % slot))}`,
      })
    const latitude = parseCoord('latitude', values.latitude)
    const longitude = parseCoord('longitude', values.longitude)
    if (latitude !== null && longitude !== null && (latitude === '') !== (longitude === ''))
      ctx.addIssue({
        code: 'custom',
        path: [latitude === '' ? 'latitude' : 'longitude'],
        message: '经纬度要一起填；都不填表示首页不给导航',
      })
  })

/** 校验通过的表单 → 要提交的设置；不合法返回 null。 */
export function toSettings(values: SettingsFormValues): ReservationSettings | null {
  if (!settingsFormSchema.safeParse(values).success) return null
  const number = (key: ClockKey | WholeKey) => parseField(key, values) as number
  const phone = values.contactPhone.trim()
  const wechat = values.contactWechat.trim()
  const address = values.address.trim()
  const latitude = parseCoord('latitude', values.latitude)
  const longitude = parseCoord('longitude', values.longitude)
  return {
    enabled: values.enabled,
    openMinute: number('openMinute'),
    closeMinute: number('closeMinute'),
    slotMinutes: number('slotMinutes'),
    advanceDays: number('advanceDays'),
    leadMinutes: number('leadMinutes'),
    graceMinutes: number('graceMinutes'),
    // 整份设置一起保存：歇业与爽约限制每次都带上，空列表就是不歇业
    closedDates: parseField('closedDates', values) as string[],
    closedWeekdays: parseField('closedWeekdays', values) as number[],
    noShowLimit: number('noShowLimit'),
    noShowWindowDays: number('noShowWindowDays'),
    remindHours: number('remindHours'),
    // 没填的不发：整份设置一起保存，不发就是清空
    ...(phone ? { contactPhone: phone } : {}),
    ...(wechat ? { contactWechat: wechat } : {}),
    ...(address ? { address } : {}),
    ...(typeof latitude === 'number' && typeof longitude === 'number' ? { latitude, longitude } : {}),
  }
}

/** 某项设置的中文显示。 */
export function settingText(key: SettingsKey, value: SettingValue): string {
  if (key === 'enabled') return value ? '开放' : '关闭'
  if (isContact(key) || isCoord(key)) return value === '' ? '未填' : String(value)
  if (key === 'closedDates') {
    const dates = value as string[]
    return dates.length ? dates.map(dayLabel).join('、') : '无'
  }
  if (key === 'closedWeekdays') {
    const days = value as number[]
    return days.length ? days.map((day) => weekdayNames[day]).join('、') : '无'
  }
  if (key === 'noShowLimit') return value ? `爽约 ${value} 次后暂停自助预约` : '不限制'
  if (key === 'openMinute' || key === 'closeMinute') return clockLabel(value as number)
  if (key === 'advanceDays') return `${value} 天`
  if (key === 'noShowWindowDays') return `最近 ${value} 天`
  if (key === 'remindHours') return value ? `开始前 ${value} 小时提醒` : '不提醒'
  return `${value} 分钟`
}

const sameValue = (a: SettingValue | null, b: SettingValue) =>
  Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b

export interface SettingChange {
  key: SettingsKey
  label: string
  from: string
  to: string
}

/**
 * 表单和基准设置比，列出改了哪些（确认框用，也用来判断有没有未保存的改动）。
 * 写法不同但值相同（9:00 与 09:00）不算改动；填得不合法的算改动，原样显示。
 */
export function diffSettings(base: ReservationSettings, values: SettingsFormValues): SettingChange[] {
  return settingsFields.flatMap(({ key, label }) => {
    const parsed = parseField(key, values)
    if (sameValue(parsed, settingValue(base, key))) return []
    const raw = key === 'enabled' || isList(key) ? '' : String(values[key] ?? '').trim()
    return [
      {
        key,
        label,
        from: settingText(key, settingValue(base, key)),
        to: parsed === null ? raw || '（空）' : settingText(key, parsed),
      },
    ]
  })
}

/**
 * 编辑期间别人改了设置（另一台电脑或小程序）：以最新设置为底，只保留我真正改过的那几项。
 * 我没动的项跟着最新值走，避免保存时把别人刚改的悄悄改回去；两边都改的项保留我的，确认框里会列出来。
 */
export function rebaseDraft(
  oldBase: ReservationSettings,
  newBase: ReservationSettings,
  values: SettingsFormValues,
): SettingsFormValues {
  const changed = new Set(diffSettings(oldBase, values).map((change) => change.key))
  const fresh = toFormValues(newBase)
  return Object.fromEntries(
    settingsFields.map(({ key }) => [key, changed.has(key) ? values[key] : fresh[key]]),
  ) as SettingsFormValues
}

/** 新设的歇业日上已经有的预约：哪天、几个。 */
export interface ClosedDayImpact {
  day: string
  count: number
}

/**
 * 按表单里的歇业设置，原来营业、现在要歇业的日子上已经有几个还要到店的预约（待确认、已确认，没过期）。
 * 这些预约保存后不会自动取消，保存前列给老板，提醒他联系顾客。日期按门店时区，今天以前的不算。
 */
export function closedDayImpact(
  entries: ReservationEntry[],
  base: ReservationSettings,
  values: SettingsFormValues,
  today: string,
): ClosedDayImpact[] {
  const next = { closedDates: values.closedDates, closedWeekdays: values.closedWeekdays }
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (entry.displayStatus !== 'pending' && entry.displayStatus !== 'confirmed') continue
    const day = dateOnly(entry.reservation.startAt)
    if (day < today || !closedOn(next, day) || closedOn(base, day)) continue
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, count]) => ({ day, count }))
}

/** 「10-08 周四 2 个、10-10 周六 1 个」。 */
export function impactText(impact: ClosedDayImpact[]): string {
  return impact.map(({ day, count }) => `${dayLabel(day)} ${count} 个`).join('、')
}

/** 保存失败的说明：业务错误原样显示；鉴权那一步回的是英文 forbidden，换成中文。 */
export function saveErrorMessage(error: unknown): string {
  const { status, message } = (error ?? {}) as { status?: number; message?: string }
  if (status === 403) return '当前账号无权修改预约设置：只有老板可以修改。'
  return message || '保存失败，请稍后重试'
}
