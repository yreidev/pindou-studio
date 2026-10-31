import {
  Banner,
  Button,
  Card,
  DatePicker,
  Input,
  Radio,
  RadioGroup,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm, useStore } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { useId, useMemo, useState } from 'react'
import { isPreviousApplied } from '../../api/client'
import { useBillingEnabled } from '../../api/billing'
import { reservationsApi, type ReservationRegister, type ReservationView } from '../../api/reservations'
import { CouponFields } from '../../components/CouponFields'
import { CustomerPicker } from '../../components/CustomerPicker'
import { Field } from '../../components/Field'
import { askDiscard } from '../inventory/useLeaveGuard'
import { customerText as accountText } from '../board/board'
import { clockTime, dateOnly, money } from '../../lib/format'
import { packageDuration } from '../../lib/packages'
import {
  bookablePackages,
  bookingMinutes,
  charLength,
  dayText,
  defaultRegisterForm,
  guestNameLimit,
  inUseUntil,
  noteLimit,
  registerDays,
  registerDirty,
  registerFormSchema,
  registerInput,
  registerSlots,
  slotMinutesOf,
  seatUnits,
  unitReserved,
  untilText,
  type RegisterFormValues,
  type SeatUnit,
} from './reservations'

const hm = (value: number) => clockTime(value).slice(0, 5)

/** 日期选择器给的本地日历日 → YYYY-MM-DD（选的是日历上的那一天，就是门店的那一天）。 */
const calendarDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/**
 * 代客登记（电话或到店口头预约），字段与校验同小程序员工「预约 › 代客登记」：顾客账户或称呼（二选一，不记手机号）、
 * 套餐、到店日期与时间、座位、团购记录、备注。登记后直接生效（已确认），预约不收钱，到店开台时才按当时的套餐计时
 * （系统内收费开着时生成订单）。
 * 员工代客登记不受最短提前、每人上限、歇业日、爽约限制和现场定时会话的限制：歇业日、座位上正在进行的会话只提示。
 * 座位是否已被预约看接口给的 busy；能不能登记以后端为准，被拒时显示后端原话、输入保留。
 */
export function RegisterForm({
  view,
  now,
  onDone,
}: {
  view: ReservationView
  now: number
  /** 登记成功：回列表看那一天。 */
  onDone: (day: string) => void
}) {
  const queryClient = useQueryClient()
  const billing = useBillingEnabled()
  const today = dateOnly(now)
  const packages = useMemo(() => bookablePackages(view.packages), [view.packages])
  const units = useMemo(() => seatUnits(view.tables), [view.tables])
  const groupId = useId()
  // 初值：今天、只有一个套餐时选上它；登记成功后按当时的今天重新清空
  const [baseline] = useState(() => defaultRegisterForm(today, packages))

  const register = useMutation({
    mutationFn: (input: ReservationRegister) => reservationsApi.act(input),
    onSuccess: () => {
      Toast.success('预约已登记')
      void queryClient.invalidateQueries()
    },
    // 多半是座位刚被别人约了、状态变了：重读一次，输入不动
    onError: () => void queryClient.invalidateQueries(),
  })

  const form = useForm({
    defaultValues: baseline,
    validationLogic: revalidateLogic(),
    validators: { onDynamic: registerFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const unit = units.find((item) => item.key === value.unit)
      const pkg = packages.find((rule) => rule.id === value.packageId)
      if (!unit || !pkg) return
      // 刚选好座位又被别人约了（实时重读后 busy 变了）：不提交，页面上已经写明
      if (unitReserved(view.busy, unit, value.start, bookingMinutes(pkg, value.start, view.settings.closeMinute)))
        return
      try {
        await register.mutateAsync(registerInput(value, unit))
      } catch {
        return // 后端原话显示在表单下面，输入保留；改好或直接重试（同内容沿用同一个幂等键）
      }
      const day = value.day
      formApi.reset(defaultRegisterForm(dateOnly(Date.now()), packages))
      onDone(day)
    },
  })

  const values = useStore(form.store, (state) => state.values)
  const submitting = useStore(form.store, (state) => state.isSubmitting)
  const dirty = registerDirty(values)
  const busy = submitting || register.isPending

  // 填了东西去别的页面（侧栏、后退）先确认；本页切到「预约列表」不丢输入，不拦
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: async ({ current, next }) => {
      if (next.pathname === '/login' || next.pathname === current.pathname) return false
      return !(await askDiscard())
    },
  })

  const settings = view.settings
  const selected = packages.find((rule) => rule.id === values.packageId)
  const days = registerDays(settings, now)
  const slots = selected ? registerSlots(settings, values.day, slotMinutesOf(selected), now) : []
  // 「到打烊」的套餐按所选开始时间约到打烊
  const minutes = selected && values.start ? bookingMinutes(selected, values.start, settings.closeMinute) : 0
  const closed = view.closedDays.includes(values.day)
  const picked = units.find((unit) => unit.key === values.unit)
  const reserved = (unit: SeatUnit) => Boolean(minutes && unitReserved(view.busy, unit, values.start, minutes))
  const sessionUntil = (unit: SeatUnit) => (minutes ? inUseUntil(view.busy, unit, values.start, minutes) : null)
  const pickedReserved = picked ? reserved(picked) : false
  const pickedInUse = picked && !pickedReserved ? sessionUntil(picked) : null

  return (
    <Card className="reservation-register">
      <Typography.Paragraph type="tertiary" style={{ marginBottom: 16 }}>
        电话或到店口头预约由员工登记，登记后直接生效，无需顾客再次确认。预约不收取任何费用，到店开台时才产生套餐订单。
      </Typography.Paragraph>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="customer">
          {(field) => (
            <Field label="顾客账户" labelMode="group" help="已注册的顾客搜昵称或手机尾号；没有账户的在下面填称呼。">
              {() => (
                <div style={{ maxWidth: 420 }}>
                  <CustomerPicker
                    label="顾客账户"
                    value={field.state.value}
                    onChange={(account) => {
                      field.handleChange(account)
                      if (account) form.setFieldValue('guestName', '')
                    }}
                    disabled={busy}
                    clearable
                  />
                </div>
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="guestName">
          {(field) => (
            <Field
              label="或填写称呼"
              help="只保存称呼，不记录手机号；到店开台时再选择或注册账户。"
              errors={field.state.meta.errors}
            >
              {(control) => (
                <Input
                  {...control}
                  style={{ maxWidth: 420 }}
                  placeholder="尚无账户的顾客，如「张阿姨」"
                  disabled={busy || Boolean(values.customer)}
                  value={field.state.value}
                  getValueLength={charLength}
                  maxLength={guestNameLimit}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>

        <form.Field name="packageId">
          {(field) => (
            <Field
              label="套餐"
              labelMode="radiogroup"
              required
              help={
                billing
                  ? '时长取自套餐（「到打烊」的约到当天打烊）；到店开台按当时现行的套餐计时计价。'
                  : '时长取自套餐（「到打烊」的约到当天打烊）；到店开台按当时现行的套餐计时。'
              }
              errors={field.state.meta.errors}
            >
              {() =>
                packages.length ? (
                  <RadioGroup
                    type="pureCard"
                    // 同一表单有几组单选：每组自己的 name，不然浏览器把它们当成一组
                    name={`${groupId}-package`}
                    className="reservation-choices reservation-choices-wide"
                    disabled={busy}
                    value={field.state.value}
                    onChange={(event) => {
                      field.handleChange(String(event.target.value))
                      form.setFieldValue('start', 0)
                      form.setFieldValue('unit', '')
                    }}
                  >
                    {packages.map((rule) => (
                      <Radio
                        key={rule.id}
                        value={rule.id}
                        extra={
                          billing ? `${packageDuration(rule)} · ${money(rule.amountCents)}` : packageDuration(rule)
                        }
                      >
                        {rule.name}
                      </Radio>
                    ))}
                  </RadioGroup>
                ) : (
                  <Typography.Text type="warning">
                    尚未发布计时套餐，无法登记预约（套餐在「经营规则」里发布）。
                  </Typography.Text>
                )
              }
            </Field>
          )}
        </form.Field>

        {selected ? (
          <>
            <form.Field name="day">
              {(field) => (
                // 日期选择器的触发框名字写死成英文、也不收 id：标题、说明挂在外层这一组上
                <Field
                  label="到店日期"
                  labelMode="group"
                  required
                  help={`按门店日期（中国时间），最多约到 ${settings.advanceDays} 天以后。`}
                >
                  {() => (
                    <div className="toolbar-field" style={{ flexWrap: 'wrap' }}>
                      <DatePicker
                        type="date"
                        format="yyyy-MM-dd"
                        style={{ width: 180 }}
                        placeholder="选择到店日期"
                        showClear={false}
                        disabled={busy}
                        value={field.state.value}
                        disabledDate={(date) => {
                          if (!date) return false
                          const day = calendarDay(date)
                          return day < days.first || day > days.last
                        }}
                        onChange={(_, text) => {
                          if (typeof text !== 'string' || !text) return
                          field.handleChange(text)
                          form.setFieldValue('start', 0)
                          form.setFieldValue('unit', '')
                        }}
                      />
                      <Typography.Text type="secondary">
                        {dayText(field.state.value, today)}
                        {closed ? '（歇业日）' : ''}
                      </Typography.Text>
                    </div>
                  )}
                </Field>
              )}
            </form.Field>
            {closed ? (
              <Banner
                type="warning"
                closeIcon={null}
                style={{ marginBottom: 16 }}
                description="这天是歇业日，顾客不能自助预约；代客登记照常可以，请和顾客确认门店这天会有人接待。"
              />
            ) : null}

            <form.Field name="start">
              {(field) => (
                <Field label="到店时间" labelMode="radiogroup" required errors={field.state.meta.errors}>
                  {() =>
                    slots.length ? (
                      <RadioGroup
                        type="pureCard"
                        name={`${groupId}-start`}
                        className="reservation-choices"
                        disabled={busy}
                        value={field.state.value || undefined}
                        onChange={(event) => {
                          field.handleChange(Number(event.target.value))
                          form.setFieldValue('unit', '')
                        }}
                      >
                        {slots.map((slot) => (
                          <Radio key={slot} value={slot}>
                            {hm(slot)}
                          </Radio>
                        ))}
                      </RadioGroup>
                    ) : (
                      <Typography.Text type="tertiary">这天已没有可登记的时间，请换一天。</Typography.Text>
                    )
                  }
                </Field>
              )}
            </form.Field>
          </>
        ) : null}

        {selected && values.start ? (
          <form.Field name="unit">
            {(field) => (
              <Field
                label="座位"
                labelMode="radiogroup"
                required
                help="已被别的预约占着的不能选；座位上正在计时的只提示，员工可以和顾客另行确认。"
                errors={field.state.meta.errors}
              >
                {() => (
                  <RadioGroup
                    type="pureCard"
                    name={`${groupId}-unit`}
                    className="reservation-choices"
                    disabled={busy}
                    value={field.state.value || undefined}
                    onChange={(event) => field.handleChange(String(event.target.value))}
                  >
                    {units.map((unit) => {
                      const taken = reserved(unit)
                      const until = taken ? null : sessionUntil(unit)
                      return (
                        <Radio
                          key={unit.key}
                          value={unit.key}
                          disabled={taken}
                          extra={taken ? '已约' : until ? `使用中至 ${untilText(until, values.start)}` : undefined}
                        >
                          {unit.label}
                        </Radio>
                      )
                    })}
                  </RadioGroup>
                )}
              </Field>
            )}
          </form.Field>
        ) : null}
        {pickedReserved ? (
          <Banner
            type="danger"
            closeIcon={null}
            style={{ marginBottom: 16 }}
            description="刚选的座位这个时段已被别的预约占了，请换一个座位或时间。"
          />
        ) : null}
        {pickedInUse ? (
          <Banner
            type="warning"
            closeIcon={null}
            style={{ marginBottom: 16 }}
            description={`这个座位现场正在使用，到 ${untilText(pickedInUse, values.start)} 才空出；代客登记照常可以，请和顾客确认到店时间。`}
          />
        ) : null}

        <form.Field name="coupon">
          {(field) => (
            <CouponFields value={field.state.value} onChange={(value) => field.handleChange(value)} disabled={busy} />
          )}
        </form.Field>

        <form.Field name="note">
          {(field) => (
            <Field label="备注" errors={field.state.meta.errors}>
              {(control) => (
                <TextArea
                  {...control}
                  style={{ maxWidth: 560 }}
                  placeholder="顾客要求、同行人数等（可不填）"
                  disabled={busy}
                  maxCount={noteLimit}
                  getValueLength={charLength}
                  autosize={{ minRows: 2, maxRows: 5 }}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>

        {/* 后端的原话：座位或时段冲突、同一顾客这个时段已有预约……；「上一次其实已经生效」不是失败，用提醒的样子 */}
        {register.error ? (
          <Banner
            type={isPreviousApplied(register.error) ? 'warning' : 'danger'}
            closeIcon={null}
            style={{ marginBottom: 16 }}
            description={register.error.message}
          />
        ) : null}
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button htmlType="submit" theme="solid" type="primary" loading={busy} disabled={pickedReserved}>
            登记预约
          </Button>
          <Typography.Text type="tertiary" data-register-summary>
            {summary(values, selected?.name, picked?.label, today)}
          </Typography.Text>
        </div>
      </form>
    </Card>
  )
}

/** 按钮旁的一行：「小王（138****1234）· 10-07 周三 14:00 · A3 · 畅玩 2 小时」，没选的不写。 */
function summary(values: RegisterFormValues, pkg: string | undefined, seat: string | undefined, today: string): string {
  const who = values.customer ? accountText(values.customer) : values.guestName.trim()
  const when = values.start ? `${dayText(values.day, today).split(' · ')[0]} ${hm(values.start)}` : ''
  return [who, when, seat, pkg].filter(Boolean).join(' · ')
}
