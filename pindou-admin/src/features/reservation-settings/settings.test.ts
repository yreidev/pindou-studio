import { describe, expect, it } from 'vitest'
import type { ReservationEntry, ReservationSettings } from '../../api/reservations'
import {
  addClosedDate,
  addressValid,
  clockLabel,
  closedDayImpact,
  closedOn,
  contactPhoneValid,
  contactWechatValid,
  dayLabel,
  diffSettings,
  impactText,
  parseClock,
  parseCoord,
  rebaseDraft,
  saveErrorMessage,
  settingsFormSchema,
  splitCoordPair,
  toFormValues,
  toSettings,
  type SettingsFormValues,
  weekdayOf,
  wholeIn,
} from './settings'

// 未设置时的后端默认值：每天 09:00–22:00、30 分钟粒度、最多提前 7 天、至少提前 30 分钟、迟到宽限 30 分钟，
// 不设歇业日，不限制爽约（统计 30 天）。没设置过提前几小时提醒时接口不返回这一项（按 2 小时算）。
const defaults: ReservationSettings = {
  enabled: true,
  openMinute: 540,
  closeMinute: 1320,
  slotMinutes: 30,
  advanceDays: 7,
  leadMinutes: 30,
  graceMinutes: 30,
  closedDates: [],
  closedWeekdays: [],
  noShowLimit: 0,
  noShowWindowDays: 30,
}

// 保存时整份设置一起提交，没设置过的提醒写明 2 小时
const submitted: ReservationSettings = { ...defaults, remindHours: 2 }

const issues = (values: SettingsFormValues) =>
  settingsFormSchema.safeParse(values).error?.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`) ?? []

describe('预约设置表单', () => {
  it('时间按「时:分」读写，结束可到 24:00', () => {
    expect(clockLabel(540)).toBe('09:00')
    expect(clockLabel(1440)).toBe('24:00')
    expect(parseClock('9:00')).toBe(540)
    expect(parseClock('21：30')).toBe(1290)
    expect(parseClock('24:00')).toBe(1440)
    expect(parseClock('24:30')).toBeNull()
    expect(parseClock('12:60')).toBeNull()
    expect(parseClock('0900')).toBeNull()
  })

  it('分钟数、天数、次数是数字输入框给的数：整数且在范围内才算数，清空是 null', () => {
    expect(wholeIn(30, 5, 240)).toBe(30)
    expect(wholeIn(4, 5, 240)).toBeNull()
    expect(wholeIn(1.5, 0, 10)).toBeNull()
    expect(wholeIn(null, 0, 10)).toBeNull()
    expect(wholeIn(0, 0, 20)).toBe(0)
    // 表单里存的就是数字，保存的是同样的整数（契约不变）
    const form = toFormValues(defaults)
    expect(form.slotMinutes).toBe(30)
    expect(form.noShowLimit).toBe(0)
    expect(toSettings({ ...form, graceMinutes: 15 })).toEqual({ ...submitted, graceMinutes: 15 })
    expect(issues({ ...form, graceMinutes: 15.5 })).toEqual(['graceMinutes:填 5–240 之间的整数分钟'])
  })

  it('读进来再原样转回去，值不变；没设置过的提醒保存时写明 2 小时', () => {
    expect(toSettings(toFormValues(defaults))).toEqual(submitted)
    expect(
      toSettings(toFormValues({ ...defaults, closeMinute: 1440, enabled: false, leadMinutes: 0, remindHours: 0 })),
    ).toEqual({
      ...defaults,
      closeMinute: 1440,
      enabled: false,
      leadMinutes: 0,
      remindHours: 0,
    })
  })

  it('提前几小时提醒：没设置过按 2 小时，0 不提醒，最多 24 小时', () => {
    const form = toFormValues(defaults)
    expect(form.remindHours).toBe(2)
    // 写明 2 小时和没设置过一样，不算改动
    expect(diffSettings({ ...defaults, remindHours: 2 }, form)).toEqual([])
    expect(diffSettings(defaults, { ...form, remindHours: 0 })).toEqual([
      { key: 'remindHours', label: '微信提醒', from: '开始前 2 小时提醒', to: '不提醒' },
    ])
    expect(diffSettings({ ...defaults, remindHours: 0 }, { ...form, remindHours: 3 })).toEqual([
      { key: 'remindHours', label: '微信提醒', from: '不提醒', to: '开始前 3 小时提醒' },
    ])
    expect(issues({ ...form, remindHours: 25 })).toEqual(['remindHours:填 0–24 之间的整数小时，0 表示不提醒'])
    expect(issues({ ...form, remindHours: 1.5 })).toEqual(['remindHours:填 0–24 之间的整数小时，0 表示不提醒'])
  })

  it('照后端规则校验，错误落在对应的字段上', () => {
    const form = toFormValues(defaults)
    expect(issues(form)).toEqual([])
    expect(issues({ ...form, slotMinutes: 3, advanceDays: 91, leadMinutes: -1, graceMinutes: null })).toEqual([
      'slotMinutes:填 5–240 之间的整数分钟',
      'advanceDays:填 1–90 之间的整数天',
      'leadMinutes:填 0–1440 之间的整数分钟',
      'graceMinutes:填 5–240 之间的整数分钟',
    ])
    expect(issues({ ...form, openMinute: '9点' })).toEqual(['openMinute:请按「时:分」填写，例如 09:00，最晚 24:00'])
    // 营业至少 1 小时
    expect(issues({ ...form, openMinute: '21:30', closeMinute: '22:00' })).toEqual([
      'closeMinute:最晚结束要比开始接待至少晚 1 小时',
    ])
    // 开始时间要落在粒度的整数倍上
    expect(issues({ ...form, openMinute: '09:10' })).toEqual([
      'openMinute:开始接待须落在 30 分钟一档的时间上（从 00:00 起算），例如 09:00',
    ])
    expect(issues({ ...form, openMinute: '09:10', slotMinutes: 10 })).toEqual([])
    expect(toSettings({ ...form, openMinute: '09:10' })).toBeNull()
  })

  it('列出改了哪些；写法不同但值相同不算改动', () => {
    const form = toFormValues(defaults)
    expect(diffSettings(defaults, form)).toEqual([])
    expect(diffSettings(defaults, { ...form, openMinute: '9:00' })).toEqual([])
    expect(diffSettings(defaults, { ...form, enabled: false, graceMinutes: 15, slotMinutes: 3 })).toEqual([
      { key: 'enabled', label: '顾客自助预约', from: '开放', to: '关闭' },
      { key: 'slotMinutes', label: '时段粒度', from: '30 分钟', to: '3' },
      { key: 'graceMinutes', label: '迟到宽限', from: '30 分钟', to: '15 分钟' },
    ])
    // 清空了的照样算改动，写成「（空）」
    expect(diffSettings(defaults, { ...form, advanceDays: null })).toEqual([
      { key: 'advanceDays', label: '最多提前', from: '7 天', to: '（空）' },
    ])
  })

  it('别人改过设置后重新核对：只保留我改过的项，其余跟最新值', () => {
    const mine = { ...toFormValues(defaults), openMinute: '10:00' }
    const theirs = { ...defaults, graceMinutes: 15, openMinute: 600 + 30 }
    const rebased = rebaseDraft(defaults, theirs, mine)
    // 宽限是别人改的，跟最新；开始时间两边都改了，保留我的
    expect(rebased).toEqual({ ...toFormValues(theirs), openMinute: '10:00' })
    expect(diffSettings(theirs, rebased)).toEqual([
      { key: 'openMinute', label: '每天开始接待', from: '10:30', to: '10:00' },
    ])
  })

  it('门店联系方式可选：去掉首尾空白再校验，空的不提交', () => {
    expect(contactPhoneValid('')).toBe(true)
    expect(contactPhoneValid(' +86 (0571) 8888-6666 ')).toBe(true)
    expect(contactPhoneValid('0571-abc')).toBe(false)
    expect(contactPhoneValid('（0571）88886666')).toBe(false)
    expect(contactPhoneValid('1'.repeat(21))).toBe(false)
    expect(contactWechatValid('')).toBe(true)
    expect(contactWechatValid(' examplebrand_pindou ')).toBe(true)
    expect(contactWechatValid('贝'.repeat(40))).toBe(true)
    expect(contactWechatValid('贝'.repeat(41))).toBe(false)
    expect(contactWechatValid('examplebrand pindou')).toBe(false)

    const form = toFormValues(defaults)
    expect(form.contactPhone).toBe('')
    expect(form.contactWechat).toBe('')
    expect(issues({ ...form, contactPhone: '0571-abc', contactWechat: 'examplebrand pindou' })).toEqual([
      'contactPhone:只能填数字、空格、+、-、括号，最多 20 个字符',
      'contactWechat:最多 40 个字符，不能有空格',
    ])
    // 填了就去掉首尾空白提交；没填的不发
    expect(toSettings({ ...form, contactPhone: ' 0571-8888 6666 ', contactWechat: 'examplebrand_pindou' })).toEqual({
      ...submitted,
      contactPhone: '0571-8888 6666',
      contactWechat: 'examplebrand_pindou',
    })
    expect(toSettings({ ...form, contactPhone: '   ' })).toEqual(submitted)

    // 接口没返回的联系方式当作没填；只多了空白不算改动
    const saved = { ...defaults, contactPhone: '0571-8888 6666' }
    expect(toFormValues(saved).contactPhone).toBe('0571-8888 6666')
    expect(diffSettings(saved, { ...toFormValues(saved), contactPhone: ' 0571-8888 6666 ' })).toEqual([])
    expect(
      diffSettings(saved, { ...toFormValues(saved), contactPhone: '', contactWechat: 'examplebrand_pindou' }),
    ).toEqual([
      { key: 'contactPhone', label: '门店电话', from: '0571-8888 6666', to: '未填' },
      { key: 'contactWechat', label: '门店微信号', from: '未填', to: 'examplebrand_pindou' },
    ])
  })

  it('门店地址和经纬度可选：经纬度要一起填，坐标拾取器的「纬度,经度」能一次拆好', () => {
    expect(addressValid('')).toBe(true)
    expect(addressValid('贝'.repeat(100))).toBe(true)
    expect(addressValid('贝'.repeat(101))).toBe(false)
    expect(addressValid('南京路\n1 号')).toBe(false)
    expect(parseCoord('latitude', ' 39.118 ')).toBe(39.118)
    expect(parseCoord('latitude', '')).toBe('')
    expect(parseCoord('latitude', '91')).toBeNull()
    expect(parseCoord('longitude', '-180')).toBe(-180)
    expect(parseCoord('longitude', '117,2')).toBeNull()
    expect(parseCoord('longitude', '1e2')).toBeNull()
    expect(splitCoordPair('39.118123,117.199456')).toEqual({ latitude: '39.118123', longitude: '117.199456' })
    expect(splitCoordPair(' 39.1 ， 117.2 ')).toEqual({ latitude: '39.1', longitude: '117.2' })
    expect(splitCoordPair('39.118')).toBeNull()

    const form = toFormValues(defaults)
    expect([form.address, form.latitude, form.longitude]).toEqual(['', '', ''])
    expect(issues({ ...form, latitude: '39.118' })).toEqual(['longitude:经纬度要一起填；都不填表示首页不给导航'])
    expect(issues({ ...form, latitude: '99', longitude: 'abc' })).toEqual([
      'latitude:纬度是 -90～90 之间的数，如 39.118',
      'longitude:经度是 -180～180 之间的数，如 117.199',
    ])
    expect(toSettings({ ...form, address: ' 南京路 1 号 ', latitude: '39.118', longitude: '117.199' })).toEqual({
      ...submitted,
      address: '南京路 1 号',
      latitude: 39.118,
      longitude: 117.199,
    })
    expect(toSettings({ ...form, address: '  ' })).toEqual(submitted)

    const saved = { ...defaults, address: '南京路 1 号', latitude: 39.118, longitude: 117.199 }
    expect(toFormValues(saved)).toMatchObject({ latitude: '39.118', longitude: '117.199' })
    expect(diffSettings(saved, { ...toFormValues(saved), latitude: '39.1180' })).toEqual([])
    expect(diffSettings(saved, { ...toFormValues(saved), latitude: '', longitude: '' })).toEqual([
      { key: 'latitude', label: '门店纬度', from: '39.118', to: '未填' },
      { key: 'longitude', label: '门店经度', from: '117.199', to: '未填' },
    ])
  })

  it('歇业日期与每周休息日：去重排好提交，改动按日期和星期列出', () => {
    // 2026-10-08 是周四，2026-10-11 是周日
    expect(weekdayOf('2026-10-08')).toBe(4)
    expect(weekdayOf('2026-10-11')).toBe(7)
    expect(dayLabel('2026-10-08')).toBe('10-08 周四')
    expect(addClosedDate(['2026-10-20'], '2026-10-08')).toEqual(['2026-10-08', '2026-10-20'])
    expect(addClosedDate(['2026-10-08'], '2026-10-08')).toEqual(['2026-10-08'])
    expect(closedOn({ closedDates: ['2026-10-08'], closedWeekdays: [7] }, '2026-10-08')).toBe(true)
    expect(closedOn({ closedDates: ['2026-10-08'], closedWeekdays: [7] }, '2026-10-11')).toBe(true)
    expect(closedOn({ closedDates: ['2026-10-08'], closedWeekdays: [7] }, '2026-10-09')).toBe(false)

    const saved = { ...defaults, closedDates: ['2026-10-08'], closedWeekdays: [1] }
    const form = toFormValues(saved)
    expect(form.closedDates).toEqual(['2026-10-08'])
    expect(form.closedWeekdays).toEqual([1])
    expect(form.noShowWindowDays).toBe(30)
    expect(diffSettings(saved, form)).toEqual([])
    expect(toSettings(form)).toEqual({ ...saved, remindHours: 2 })

    const changed = { ...form, closedDates: ['2026-10-20', '2026-10-08'], closedWeekdays: [7, 3] }
    expect(toSettings(changed)).toEqual({
      ...saved,
      closedDates: ['2026-10-08', '2026-10-20'],
      closedWeekdays: [3, 7],
      remindHours: 2,
    })
    expect(diffSettings(saved, changed)).toEqual([
      { key: 'closedDates', label: '歇业日期', from: '10-08 周四', to: '10-08 周四、10-20 周二' },
      { key: 'closedWeekdays', label: '每周休息日', from: '周一', to: '周三、周日' },
    ])
    expect(diffSettings(saved, { ...form, closedDates: [], closedWeekdays: [] })).toEqual([
      { key: 'closedDates', label: '歇业日期', from: '10-08 周四', to: '无' },
      { key: 'closedWeekdays', label: '每周休息日', from: '周一', to: '无' },
    ])
    // 每周最多休 6 天，日期最多 90 个
    expect(issues({ ...form, closedWeekdays: [1, 2, 3, 4, 5, 6, 7] })).toEqual([
      'closedWeekdays:每周最多休 6 天；整周都不接待请关闭顾客自助预约',
    ])
    const many = Array.from(
      { length: 91 },
      (_, i) => `2027-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    )
    expect(issues({ ...form, closedDates: many })).toEqual(['closedDates:歇业日期最多设 90 个'])
    // 重新读取时，歇业日期是我改的就保留我的，别人改的爽约限制跟最新
    const theirs = { ...saved, noShowLimit: 2 }
    const rebased = rebaseDraft(saved, theirs, changed)
    expect(rebased.closedDates).toEqual(['2026-10-20', '2026-10-08'])
    expect(rebased.noShowLimit).toBe(2)
  })

  it('爽约限制：0 表示不限制，次数 0–20、统计 1–365 天', () => {
    const form = toFormValues(defaults)
    expect(form.noShowLimit).toBe(0)
    expect(issues({ ...form, noShowLimit: 21, noShowWindowDays: 0 })).toEqual([
      'noShowLimit:填 0–20 之间的整数，0 表示不限制',
      'noShowWindowDays:填 1–365 之间的整数天',
    ])
    expect(toSettings({ ...form, noShowLimit: 3, noShowWindowDays: 60 })).toEqual({
      ...submitted,
      noShowLimit: 3,
      noShowWindowDays: 60,
    })
    expect(diffSettings(defaults, { ...form, noShowLimit: 3 })).toEqual([
      { key: 'noShowLimit', label: '爽约暂停', from: '不限制', to: '爽约 3 次后暂停自助预约' },
    ])
    expect(
      diffSettings(
        { ...defaults, noShowLimit: 3 },
        { ...toFormValues({ ...defaults, noShowLimit: 3 }), noShowWindowDays: 7 },
      ),
    ).toEqual([{ key: 'noShowWindowDays', label: '爽约统计', from: '最近 30 天', to: '最近 7 天' }])
  })

  it('新设的歇业日上已有的预约：按门店日期数，只算还要到店的、原来不歇业的、今天及以后的', () => {
    const entry = (
      id: string,
      startAt: string,
      displayStatus: ReservationEntry['displayStatus'],
    ): ReservationEntry => ({
      reservation: {
        id,
        serviceTableId: 't',
        seatNumber: 1,
        packageId: 'p',
        packageName: '三小时',
        durationMinutes: 180,
        amountCents: 10000,
        startAt,
        status:
          displayStatus === 'expired' ? 'confirmed' : (displayStatus as ReservationEntry['reservation']['status']),
        createdBy: 'u',
        createdAt: '2026-10-01T00:00:00Z',
      },
      displayStatus,
      endAt: startAt,
    })
    const entries = [
      entry('a', '2026-10-08T06:00:00Z', 'pending'), // 门店 10-08 14:00
      entry('b', '2026-10-07T16:30:00Z', 'confirmed'), // UTC 还是 7 日，门店已是 10-08 00:30
      entry('c', '2026-10-11T02:00:00Z', 'confirmed'), // 门店 10-11 周日
      entry('d', '2026-10-09T06:00:00Z', 'confirmed'), // 10-09 不歇业
      entry('e', '2026-10-08T07:00:00Z', 'cancelled'), // 取消的不算
      entry('f', '2026-10-05T06:00:00Z', 'expired'), // 已经过去
    ]
    const form = { ...toFormValues(defaults), closedDates: ['2026-10-05', '2026-10-08'], closedWeekdays: [7] }
    const impact = closedDayImpact(entries, defaults, form, '2026-10-06')
    expect(impact).toEqual([
      { day: '2026-10-08', count: 2 },
      { day: '2026-10-11', count: 1 },
    ])
    expect(impactText(impact)).toBe('10-08 周四 2 个、10-11 周日 1 个')
    // 原来就歇业的日子不再提醒
    expect(closedDayImpact(entries, { ...defaults, closedWeekdays: [7] }, form, '2026-10-06')).toEqual([
      { day: '2026-10-08', count: 2 },
    ])
    expect(closedDayImpact(entries, defaults, toFormValues(defaults), '2026-10-06')).toEqual([])
  })

  it('保存失败：业务错误原样显示，鉴权的英文 forbidden 换成中文', () => {
    expect(saveErrorMessage({ status: 409, message: '预约设置已变化，请重新读取后确认' })).toBe(
      '预约设置已变化，请重新读取后确认',
    )
    expect(saveErrorMessage({ status: 403, message: 'forbidden' })).toBe('当前账号无权修改预约设置：只有老板可以修改。')
    expect(saveErrorMessage(undefined)).toBe('保存失败，请稍后重试')
  })
})
