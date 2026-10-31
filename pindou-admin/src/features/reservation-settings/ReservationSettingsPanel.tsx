import {
  Banner,
  Button,
  Card,
  CheckboxGroup,
  DatePicker,
  Descriptions,
  Input,
  InputNumber,
  Switch,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useState } from 'react'
import { hasRole, useCurrentAccount } from '../../account'
import {
  openReservationsQuery,
  reservationsApi,
  type ReservationEntry,
  type ReservationSettings,
  type ReservationView,
} from '../../api/reservations'
import { Field } from '../../components/Field'
import { QueryState } from '../../components/Page'
import {
  addClosedDate,
  closedDayImpact,
  dayLabel,
  diffSettings,
  impactText,
  isContactSetting,
  splitCoordPair,
  maxClosedDates,
  rebaseDraft,
  settingsFields,
  settingsFormSchema,
  saveErrorMessage,
  settingText,
  settingValue,
  toFormValues,
  toSettings,
  weekdayNames,
  wholeLimits,
  type ClosedDayImpact,
  type SettingChange,
  type SettingsFormValues,
} from './settings'
import { storeToday } from '../../lib/format'
import { confirmDialog } from '../../components/confirm'

// 「系统设置 › 营业与预约」（原「预约设置」页，2026-10-10 并进系统设置）：顾客自助预约的可选范围、歇业日、爽约限制和
// 门店联系方式，只有老板能改（后端校验）。每天最晚结束也是「到打烊」套餐的打烊时间。
// 改动后才出现保存与放弃；保存前确认改了什么；离开时有未保存的改动要确认。
// 新设的歇业日上已有预约时，保存前列出哪天几个：它们不会自动取消，要老板联系顾客。

/** 一份设置和它的版本：保存时把开始编辑那一刻的版本原样回传，别人先改了后端回 409。 */
interface Snapshot {
  settings: ReservationSettings
  version: string
}

const snapshotOf = (view: ReservationView): Snapshot => ({ settings: view.settings, version: view.settingsVersion })

const numberFields = [
  { name: 'slotMinutes', label: '时段粒度', unit: '分钟', help: '可选开始时间的间隔，例如 30 分钟：09:00、09:30……' },
  { name: 'advanceDays', label: '最多提前', unit: '天', help: '从此刻起最多能约到几天以后。' },
  { name: 'leadMinutes', label: '最短提前', unit: '分钟', help: '顾客至少要提前多久预约；员工代客登记不受此限制。' },
  {
    name: 'graceMinutes',
    label: '迟到宽限',
    unit: '分钟',
    help: '超过开始时间这么久仍未到店，座位自动释放、预约显示为已过期，仍需员工标记爽约或取消。',
  },
] as const

// 爽约限制：最近 D 天被标记爽约达到 N 次的顾客暂停自助预约
const noShowFields = [
  {
    name: 'noShowLimit',
    label: '爽约几次后暂停',
    unit: '次',
    help: '达到这个次数的顾客暂时不能自助预约；0 表示不限制。',
  },
  {
    name: 'noShowWindowDays',
    label: '统计最近',
    unit: '天',
    help: '按门店日期，含今天；更早的爽约不算，过了这些天自动恢复。',
  },
] as const

// 微信提醒（2026-10-20 起）：顾客在小程序提交预约时允许了的，开始前这么久发一条
const remindFields = [
  {
    name: 'remindHours',
    label: '提前几小时提醒',
    unit: '小时',
    help: '开始前这么久给顾客发一条提醒；填 0 不发这条（确认、取消的通知照发）。离开始已经不到这么久才确认的预约不再提醒。',
  },
] as const

/** 日期选择器给的本地日历日 → YYYY-MM-DD（选的是日历上的那一天，就是门店的那一天）。 */
const calendarDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// 门店联系方式：小程序在超限提示、包间说明、预约须知里给顾客看
const contactFields = [
  {
    name: 'contactPhone',
    label: '门店电话',
    placeholder: '如 0571-8888 6666',
    help: '顾客点一下即可拨打。只能填数字、空格、+、-、括号。',
  },
  {
    name: 'contactWechat',
    label: '门店微信号',
    placeholder: '微信号',
    help: '顾客点一下即可复制，再到微信里添加。',
  },
] as const

// 门店经纬度（2026-10-20 起）：小程序首页「导航」用它打开地图。坐标用腾讯地图坐标拾取器取（GCJ-02，和微信内置地图同一套），
// 拾取器给的是「纬度,经度」，整段粘进纬度框会一次填好两项
const coordPicker = 'https://lbs.qq.com/getPoint/'
const coordFields = [
  { name: 'latitude', label: '门店纬度', placeholder: '如 39.118' },
  { name: 'longitude', label: '门店经度', placeholder: '如 117.199' },
] as const

/** 营业与预约：老板能改，其他员工只读。 */
export function ReservationSettingsPanel() {
  const me = useCurrentAccount()
  const isOwner = hasRole(me, 'owner')
  const query = useQuery(openReservationsQuery())
  return (
    <QueryState query={query}>
      {(view) =>
        isOwner ? (
          <SettingsEditorHost
            latest={snapshotOf(view)}
            reservations={view.reservations}
            reload={async () => {
              const result = await query.refetch()
              return result.data ? snapshotOf(result.data) : undefined
            }}
          />
        ) : (
          <ReadonlySettings settings={view.settings} />
        )
      }
    </QueryState>
  )
}

function ReadonlySettings({ settings }: { settings: ReservationSettings }) {
  return (
    <Card title="当前设置">
      <Banner
        type="info"
        closeIcon={null}
        description="只有老板可以修改营业与预约设置。"
        style={{ marginBottom: 16 }}
      />
      <Descriptions
        data={settingsFields.map(({ key, label }) => ({
          key: label,
          value: settingText(key, settingValue(settings, key)),
        }))}
      />
    </Card>
  )
}

/**
 * 管表单的「基准」：没有改动时始终跟最新设置走（别人在小程序或另一台电脑改了，这里跟着变）；
 * 一旦有改动就固定在开始编辑那一刻的设置和版本上，保存时据此确认。
 * 放弃、保存成功、重新读取后按新基准重建表单（换 key），不在渲染期间改表单状态。
 */
function SettingsEditorHost({
  latest,
  reservations,
  reload,
}: {
  latest: Snapshot
  reservations: ReservationEntry[]
  reload: () => Promise<Snapshot | undefined>
}) {
  const [pinned, setPinned] = useState<Snapshot | null>(null)
  // 重新读取后要带进新表单的改动，只对那一版基准有效
  const [seed, setSeed] = useState<{ version: string; values: SettingsFormValues } | null>(null)
  const [generation, setGeneration] = useState(0)
  const base = pinned ?? latest
  const restart = (nextPinned: Snapshot | null, nextSeed: SettingsFormValues | null) => {
    setPinned(nextPinned)
    setSeed(nextPinned && nextSeed ? { version: nextPinned.version, values: nextSeed } : null)
    setGeneration((value) => value + 1)
  }
  return (
    <SettingsEditor
      key={`${base.version}:${generation}`}
      base={base}
      latest={latest}
      reservations={reservations}
      initial={seed?.version === base.version ? seed.values : toFormValues(base.settings)}
      onDirtyChange={(dirty) => setPinned(dirty ? base : null)}
      onDiscard={() => restart(null, null)}
      onSaved={() => restart(null, null)}
      onRebase={async (values) => {
        const fresh = await reload()
        if (!fresh) return
        const merged = rebaseDraft(base.settings, fresh.settings, values)
        const stillDirty = diffSettings(fresh.settings, merged).length > 0
        restart(stillDirty ? fresh : null, stillDirty ? merged : null)
      }}
    />
  )
}

function SettingsEditor({
  base,
  latest,
  reservations,
  initial,
  onDirtyChange,
  onDiscard,
  onSaved,
  onRebase,
}: {
  base: Snapshot
  latest: Snapshot
  /** 还要处理的预约（待确认、已确认），用来列出新设的歇业日上已有的预约。 */
  reservations: ReservationEntry[]
  initial: SettingsFormValues
  onDirtyChange: (dirty: boolean) => void
  onDiscard: () => void
  onSaved: () => void
  onRebase: (values: SettingsFormValues) => Promise<void>
}) {
  const queryClient = useQueryClient()
  const [reloading, setReloading] = useState(false)
  // 日期选择器里选中、还没点「加入」的那一天；加入后清空，选择器（受控）跟着清空
  const [pickedDay, setPickedDay] = useState('')
  const save = useMutation({
    mutationFn: ({ settings, version }: { settings: ReservationSettings; version: string }) =>
      reservationsApi.saveSettings(settings, version),
    onSuccess: (view) => {
      Toast.success('营业与预约设置已保存')
      // 接口返回的就是保存后的预约视图，先放进缓存，表单立刻按它重建，再整体重读
      queryClient.setQueryData(openReservationsQuery().queryKey, view)
      void queryClient.invalidateQueries()
      onSaved()
    },
  })

  const form = useForm({
    defaultValues: initial,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: settingsFormSchema },
    listeners: {
      onChange: ({ formApi }) => onDirtyChange(diffSettings(base.settings, formApi.state.values).length > 0),
    },
    onSubmit: async ({ value }) => {
      const settings = toSettings(value)
      const changes = diffSettings(base.settings, value)
      if (!settings || changes.length === 0) return
      const expectedVersion = base.version
      const impact = closedDayImpact(reservations, base.settings, value, storeToday())
      const confirmed = await confirmDialog({
        title: '确认保存营业与预约设置',
        okText: '确认保存',
        content: <ChangeList changes={changes} impact={impact} />,
      })
      if (!confirmed) return
      try {
        await save.mutateAsync({ settings, version: expectedVersion })
      } catch {
        // 失败原因显示在表单上方，改动保留
      }
    },
  })

  const values = useStore(form.store, (state) => state.values)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const changes = diffSettings(base.settings, values)
  const dirty = changes.length > 0
  const today = storeToday()
  const lastDay = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`
  const impact = closedDayImpact(reservations, base.settings, values, today)
  const busy = submitting || save.isPending || reloading
  const staleBase = dirty && latest.version !== base.version

  useBlocker({
    shouldBlockFn: () =>
      confirmDialog({
        title: '离开营业与预约？',
        content: `还有 ${changes.length} 项改动没有保存，离开后会丢失。`,
        okText: '放弃改动并离开',
        cancelText: '留下继续编辑',
        // 会丢掉改动：确认按钮用危险样式
        okType: 'danger',
      }).then((leave) => !leave),
    enableBeforeUnload: dirty,
    disabled: !dirty,
  })

  const rebase = async () => {
    setReloading(true)
    try {
      save.reset()
      await onRebase(form.state.values)
    } finally {
      setReloading(false)
    }
  }

  return (
    <Card title="营业时间与自助预约">
      {save.isError ? (
        <Banner
          type="danger"
          closeIcon={null}
          style={{ marginBottom: 16 }}
          description={
            <span>
              {saveErrorMessage(save.error)}
              {(save.error as { status?: number }).status === 409 ? (
                <>
                  {' '}
                  点「重新读取」以最新设置为底保留你的改动，核对后再保存。{' '}
                  <Button size="small" theme="borderless" loading={reloading} onClick={() => void rebase()}>
                    重新读取
                  </Button>
                </>
              ) : null}
            </span>
          }
        />
      ) : staleBase ? (
        <Banner
          type="warning"
          closeIcon={null}
          style={{ marginBottom: 16 }}
          description={
            <span>
              营业与预约设置刚被修改过（另一台电脑或小程序）。点「重新读取」以最新设置为底保留你的改动，核对后再保存。{' '}
              <Button size="small" theme="borderless" loading={reloading} onClick={() => void rebase()}>
                重新读取
              </Button>
            </span>
          }
        />
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="enabled">
          {(field) => (
            <Field
              label="开放顾客自助预约"
              help="关闭后顾客不能在小程序自助预约，员工仍可代客登记。只是某几天不营业时，在下面设歇业日。"
            >
              {(control) => (
                <Switch
                  id={control.id}
                  aria-describedby={control['aria-describedby']}
                  checked={field.state.value}
                  disabled={busy}
                  onChange={(checked) => field.handleChange(checked)}
                />
              )}
            </Field>
          )}
        </form.Field>
        {/* 六个输入框排成对齐的网格，窄屏自动换行 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', columnGap: 24 }}>
          <form.Field name="openMinute">
            {(field) => (
              <Field label="每天开始接待" help="最早可约的开始时间，如 09:00。" errors={field.state.meta.errors}>
                {(control) => (
                  <Input
                    {...control}
                    style={{ width: 160 }}
                    placeholder="09:00"
                    disabled={busy}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </Field>
            )}
          </form.Field>
          <form.Field name="closeMinute">
            {(field) => (
              <Field
                label="每天最晚结束"
                help="套餐必须在这个时间之前结束，「到打烊」的套餐用到这个时间；最晚 24:00。"
                errors={field.state.meta.errors}
              >
                {(control) => (
                  <Input
                    {...control}
                    style={{ width: 160 }}
                    placeholder="22:00"
                    disabled={busy}
                    value={field.state.value}
                    onChange={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </Field>
            )}
          </form.Field>
          {numberFields.map(({ name, label, unit, help }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field label={label} help={help} errors={field.state.meta.errors}>
                  {(control) => (
                    <InputNumber
                      {...control}
                      style={{ width: 160 }}
                      suffix={unit}
                      disabled={busy}
                      // 不给 min、max、precision：Semi 失焦时会把超出范围的数、小数悄悄改掉，这里要照样显示填错的原因；
                      // 范围只告诉读屏（spinbutton 的 aria-valuemin/max）
                      aria-valuemin={wholeLimits[name][0]}
                      aria-valuemax={wholeLimits[name][1]}
                      value={field.state.value ?? undefined}
                      onChange={(value) => field.handleChange(typeof value === 'number' ? value : null)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ))}
        </div>
        <Typography.Title heading={6} style={{ marginBottom: 4 }}>
          歇业日
        </Typography.Title>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
          这些天顾客不能在小程序自助预约，日期条上显示「店休」；员工仍可代客登记。日期按门店所在的中国时区，日子过了自动作废。
          已经约在这些天的预约不会自动取消。
        </Typography.Paragraph>
        <form.Field name="closedDates">
          {(field) => (
            // 日期选择器的触发框名字写死成英文 Choose date、也不收 id，没法用 <label for> 接上：
            // 标题、说明、错误挂在外层这一组上，选择器、「加入歇业日」和已设的日期都在组里
            <Field
              label="歇业日期"
              labelMode="group"
              help={`选一天点「加入歇业日」，最多 ${maxClosedDates} 个，最远到一年以后；点标签上的 × 去掉。`}
              errors={field.state.meta.errors}
            >
              {() => (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <DatePicker
                      type="date"
                      format="yyyy-MM-dd"
                      placeholder="选择歇业日期"
                      style={{ width: 200 }}
                      disabled={busy}
                      // 受控：加入后把选中的日子清空，选择器跟着清空
                      value={pickedDay || undefined}
                      disabledDate={(date) => {
                        if (!date) return false
                        const day = calendarDay(date)
                        return day < today || day > lastDay || field.state.value.includes(day)
                      }}
                      onChange={(_, text) => setPickedDay(typeof text === 'string' ? text : '')}
                    />
                    <Button
                      disabled={busy || !pickedDay || field.state.value.includes(pickedDay)}
                      onClick={() => {
                        field.handleChange(addClosedDate(field.state.value, pickedDay))
                        setPickedDay('')
                      }}
                    >
                      加入歇业日
                    </Button>
                  </div>
                  <div className="closed-dates" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    {field.state.value.length ? (
                      field.state.value.map((day) => (
                        <Tag
                          key={day}
                          size="large"
                          closable={!busy}
                          onClose={(_, event) => {
                            // 自己从列表里去掉，不让 Tag 自己藏起来（表单是唯一来源）
                            event.preventDefault()
                            field.handleChange(field.state.value.filter((item) => item !== day))
                          }}
                        >
                          {/* 只给一段文字：Semi 按文字生成读屏用的说明 */}
                          {`${day.slice(0, 5)}${dayLabel(day)}`}
                        </Tag>
                      ))
                    ) : (
                      <Typography.Text type="tertiary">还没有设歇业日期</Typography.Text>
                    )}
                  </div>
                </>
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="closedWeekdays">
          {(field) => (
            // 多选组是 role=list 的 div，<label for> 指不到它：标题经 aria-labelledby 接上
            <Field
              label="每周休息日"
              labelMode="labelledby"
              help="每周固定不接待的日子，最多 6 天；整周都不接待请关闭顾客自助预约。"
              errors={field.state.meta.errors}
            >
              {(control) => (
                <CheckboxGroup
                  id={control.id}
                  aria-labelledby={control['aria-labelledby']}
                  aria-describedby={control['aria-describedby']}
                  aria-invalid={control['aria-invalid']}
                  aria-errormessage={control['aria-errormessage']}
                  direction="horizontal"
                  disabled={busy}
                  value={field.state.value}
                  options={weekdayNames.slice(1).map((name, index) => ({ label: name, value: index + 1 }))}
                  onChange={(checked) => field.handleChange([...(checked as number[])].sort((a, b) => a - b))}
                />
              )}
            </Field>
          )}
        </form.Field>
        {impact.length ? (
          <Banner
            type="warning"
            closeIcon={null}
            style={{ marginBottom: 20 }}
            description={<ImpactNotice impact={impact} />}
          />
        ) : null}
        <Typography.Title heading={6} style={{ marginBottom: 4 }}>
          爽约限制
        </Typography.Title>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
          最近一段时间里被员工标记爽约达到次数的顾客，暂时不能在小程序自助预约，小程序会提示他联系门店；员工仍可代客登记。
        </Typography.Paragraph>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', columnGap: 24 }}>
          {noShowFields.map(({ name, label, unit, help }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field label={label} help={help} errors={field.state.meta.errors}>
                  {(control) => (
                    <InputNumber
                      {...control}
                      style={{ width: 160 }}
                      suffix={unit}
                      disabled={busy}
                      // 不给 min、max、precision：Semi 失焦时会把超出范围的数、小数悄悄改掉，这里要照样显示填错的原因；
                      // 范围只告诉读屏（spinbutton 的 aria-valuemin/max）
                      aria-valuemin={wholeLimits[name][0]}
                      aria-valuemax={wholeLimits[name][1]}
                      value={field.state.value ?? undefined}
                      onChange={(value) => field.handleChange(typeof value === 'number' ? value : null)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ))}
        </div>
        <Typography.Title heading={6} style={{ marginBottom: 4 }}>
          微信提醒
        </Typography.Title>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
          顾客在小程序提交预约时可以允许微信提醒：店员确认、店员取消预约时各收到一条微信通知，开始前再收到一条提醒。
        </Typography.Paragraph>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', columnGap: 24 }}>
          {remindFields.map(({ name, label, unit, help }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field label={label} help={help} errors={field.state.meta.errors}>
                  {(control) => (
                    <InputNumber
                      {...control}
                      style={{ width: 160 }}
                      suffix={unit}
                      disabled={busy}
                      // 不给 min、max、precision：Semi 失焦时会把超出范围的数、小数悄悄改掉，这里要照样显示填错的原因；
                      // 范围只告诉读屏（spinbutton 的 aria-valuemin/max）
                      aria-valuemin={wholeLimits[name][0]}
                      aria-valuemax={wholeLimits[name][1]}
                      value={field.state.value ?? undefined}
                      onChange={(value) => field.handleChange(typeof value === 'number' ? value : null)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ))}
        </div>
        <Typography.Title heading={6} style={{ marginBottom: 4 }}>
          门店联系方式
        </Typography.Title>
        <Typography.Paragraph type="tertiary" size="small" style={{ marginBottom: 16 }}>
          填了会在小程序里给顾客看：电话、微信用在首页门店一行、自助预约超过每人 2
          个的提示、爽约暂停的说明、包间说明和预约须知（都不填时只写「请联系门店」）；地址和经纬度用在首页门店一行和「导航」。
        </Typography.Paragraph>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', columnGap: 24 }}>
          {contactFields.map(({ name, label, placeholder, help }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field label={label} help={help} errors={field.state.meta.errors}>
                  {(control) => (
                    <Input
                      {...control}
                      style={{ width: 240 }}
                      placeholder={placeholder}
                      showClear
                      disabled={busy}
                      value={field.state.value}
                      onChange={(value) => field.handleChange(value)}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ))}
        </div>
        <form.Field name="address">
          {(field) => (
            <Field label="门店地址" help="小程序首页门店一行显示，最多 100 个字。" errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  style={{ maxWidth: 504 }}
                  placeholder="如 天津市和平区南京路 1 号 2 楼"
                  showClear
                  disabled={busy}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', columnGap: 24 }}>
          {coordFields.map(({ name, label, placeholder }) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field
                  label={label}
                  help={
                    name === 'latitude' ? (
                      <>
                        在
                        <Typography.Text link={{ href: coordPicker, target: '_blank', rel: 'noreferrer' }} size="small">
                          腾讯地图坐标拾取器
                        </Typography.Text>
                        里点门店的位置，把「纬度,经度」整段粘到这里。
                      </>
                    ) : (
                      '经纬度要一起填；都不填时首页不显示「导航」。'
                    )
                  }
                  errors={field.state.meta.errors}
                >
                  {(control) => (
                    <Input
                      {...control}
                      style={{ width: 240 }}
                      placeholder={placeholder}
                      showClear
                      disabled={busy}
                      value={field.state.value}
                      onChange={(value) => {
                        const pair = name === 'latitude' ? splitCoordPair(value) : null
                        if (!pair) return field.handleChange(value)
                        field.handleChange(pair.latitude)
                        form.setFieldValue('longitude', pair.longitude)
                      }}
                      onBlur={field.handleBlur}
                    />
                  )}
                </Field>
              )}
            </form.Field>
          ))}
        </div>
        {dirty ? (
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <Button htmlType="submit" theme="solid" type="primary" loading={submitting || save.isPending}>
              保存设置
            </Button>
            <Button disabled={busy} onClick={onDiscard}>
              放弃修改
            </Button>
            <Typography.Text type="tertiary">有 {changes.length} 项改动未保存</Typography.Text>
          </div>
        ) : null}
      </form>
    </Card>
  )
}

/** 新设的歇业日上已有的预约：哪天几个，提醒老板联系顾客。 */
function ImpactNotice({ impact }: { impact: ClosedDayImpact[] }) {
  const total = impact.reduce((sum, item) => sum + item.count, 0)
  return (
    <span>
      新设的歇业日上已有 {total} 个预约：{impactText(impact)}。保存后这些预约不会自动取消，请联系顾客改期或取消。
    </span>
  )
}

function ChangeList({ changes, impact }: { changes: SettingChange[]; impact: ClosedDayImpact[] }) {
  return (
    <div>
      {changes.map((change) => (
        <div key={change.key}>
          {change.label}：{change.from} → {change.to}
        </div>
      ))}
      {impact.length ? (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="warning">
            <ImpactNotice impact={impact} />
          </Typography.Text>
        </div>
      ) : null}
      <div style={{ marginTop: 8 }}>
        <Typography.Text type="tertiary">
          {changes.every((change) => isContactSetting(change.key))
            ? '保存后顾客在小程序里看到的就是新的联系方式。'
            : '只影响之后的新预约，已登记的预约保持原时间。'}
        </Typography.Text>
      </div>
    </div>
  )
}
