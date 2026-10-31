import {
  Banner,
  Button,
  Descriptions,
  Radio,
  RadioGroup,
  SideSheet,
  TimePicker,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, type ReactNode } from 'react'
import { useCurrentAccount } from '../../account'
import { useBillingEnabled } from '../../api/billing'
import { boardApi, type PackageRule, type ReservationEntry, type SessionOpenInput } from '../../api/board'
import { isPreviousApplied } from '../../api/client'
import { CustomerPicker } from '../../components/CustomerPicker'
import { NamedSelect } from '../../components/NamedSelect'
import { useSheetFocus } from '../../components/useSheetFocus'
import { seatPlace, seatStateNames, startable, type BoardSeat } from './board'
import {
  backfillWindow,
  bookingText,
  closeNote,
  defaultOpenForm,
  disabledClock,
  durationPrice,
  minutesText,
  openDurations,
  openFormSchema,
  openSessionInput,
  openSummary,
  otherChoices,
  storeClock,
  tableBookings,
  type OpenTiming,
} from './open'

/**
 * 点空闲座位：「开台」侧边面板（整桌开台，同小程序桌位页的开台弹层）。顾客不选就是散客；计时按已发布计时套餐的时长
 * （读不到退回 1、2、3 小时，默认第二个；系统内收费开着时标价）、其他时长（30 分钟一档到 8 小时）、到打烊或自由计时；
 * 开始时间默认「现在」——没改就在点确认的那一刻取当前时间，可回填（店员 60 分钟内，店长、老板当天）。
 * 后端拒绝（座位被预约、桌已被占、无权回填）时原话显示在面板上，输入保留。成功后提示并关闭，看板随实时事件重读。
 */
export function OpenSheet({
  seat,
  visible,
  packages,
  closeMinute,
  reservations,
  now,
  onClose,
  afterClose,
}: {
  /** 关闭动画期间仍是刚才那个座位，内容不变空。 */
  seat: BoardSeat | null
  visible: boolean
  /** 已发布的计时套餐：时长按钮按它列、标价。 */
  packages: PackageRule[]
  /** 每天最晚结束（从 0 点起的分钟数）：「到打烊」写用到几点。 */
  closeMinute: number
  /** 还要处理的预约：这张桌今天还有的，面板上先提醒。 */
  reservations: ReservationEntry[]
  now: number
  onClose: () => void
  /** 关闭动画结束：这时才清掉座位。 */
  afterClose: () => void
}) {
  const title = seat ? `开台 · ${seat.code}` : '开台'
  const focus = useSheetFocus(visible, { className: 'board-open-sheet', label: title })
  return (
    <SideSheet
      className="board-open-sheet"
      visible={visible}
      title={title}
      width={440}
      // 选了顾客、改了时间再误点遮罩就全丢了：只从右上角或「取消」关
      maskClosable={false}
      onCancel={onClose}
      afterVisibleChange={(shown) => {
        focus(shown)
        if (!shown) afterClose()
      }}
      bodyStyle={{ paddingBottom: 24 }}
    >
      {seat ? (
        <OpenForm
          key={seat.code}
          seat={seat}
          packages={packages}
          closeMinute={closeMinute}
          reservations={reservations}
          now={now}
          onClose={onClose}
        />
      ) : null}
    </SideSheet>
  )
}

/** 表单里的一组：标题、内容、说明。标题、说明经 aria-labelledby、aria-describedby 交给这一组（单选组、下拉框自己不带可见标题）。 */
function Section({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={id}
      aria-describedby={help ? `${id}-help` : undefined}
      style={{ display: 'grid', gap: 8 }}
    >
      <div id={id}>
        <Typography.Text strong>{title}</Typography.Text>
      </div>
      {children}
      {help ? (
        <Typography.Text id={`${id}-help`} type="tertiary" size="small">
          {help}
        </Typography.Text>
      ) : null}
    </div>
  )
}

function OpenForm({
  seat,
  packages,
  closeMinute,
  reservations,
  now,
  onClose,
}: {
  seat: BoardSeat
  packages: PackageRule[]
  closeMinute: number
  reservations: ReservationEntry[]
  now: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const billing = useBillingEnabled()
  const { roles } = useCurrentAccount()
  const schema = useMemo(() => openFormSchema(roles), [roles])
  const clockId = useId()
  const groupId = useId()
  const table = seat.table
  const durations = useMemo(() => openDurations(packages), [packages])

  const open = useMutation({
    mutationFn: (input: SessionOpenInput) => boardApi.openSession(input),
    onSuccess: () => {
      Toast.success(`${seat.code} 已开台，开始计时`)
      void queryClient.invalidateQueries()
      onClose()
    },
    // 多半是别人刚开了这张桌或预约变了：重读一次，面板里的输入不动
    onError: () => void queryClient.invalidateQueries(),
  })

  const form = useForm({
    defaultValues: defaultOpenForm(durations),
    validationLogic: revalidateLogic(),
    validators: { onDynamic: schema },
    onSubmit: async ({ value }) => {
      if (!table) return
      try {
        // 开始时间没改就取这一刻：不是打开面板的那一刻
        await open.mutateAsync(openSessionInput(table.id, value, Date.now()))
      } catch {
        // 后端的原话显示在面板上，输入保留
      }
    },
  })

  const free = startable(seat)
  const busy = open.isPending
  const limits = backfillWindow(roles, now)
  const disabled = disabledClock(limits, now)
  const bookings = table ? tableBookings(reservations, table.id, now) : []

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Descriptions align="left" data={[{ key: '座位', value: seatPlace(seat) }]} />

      {!free ? (
        <Banner
          type="warning"
          closeIcon={null}
          description={`${seat.code} 现在是「${seatStateNames[seat.state]}」，不能开台。关掉面板看平面图上的最新状态。`}
        />
      ) : null}
      {bookings.length ? (
        <Banner
          type="warning"
          closeIcon={null}
          description={
            <div>
              <div>这张桌今天还有预约：</div>
              {bookings.map((entry) => (
                <div key={entry.reservation.id}>{bookingText(entry)}</div>
              ))}
              <div>开台的时段压到预约时系统会拒绝开台，请先处理预约或换一张桌。</div>
            </div>
          }
        />
      ) : null}

      <form.Field name="customer">
        {(field) => (
          <Section title="顾客" help="不选就是散客。选了顾客账户，顾客在小程序「本次手作」里能看到这一台的计时。">
            <CustomerPicker
              label="顾客账户（不选为散客）"
              value={field.state.value}
              onChange={(account) => field.handleChange(account)}
              disabled={busy}
              clearable
            />
          </Section>
        )}
      </form.Field>

      <form.Field name="timing">
        {(field) => {
          const timing = field.state.value
          // 从「其他时长」选的：时长按钮里没有，单选组一个都不勾，下拉框里写着选的时长
          const other = typeof timing === 'number' && !durations.includes(timing)
          return (
            <Section
              title="计时"
              help={
                billing
                  ? '这里只管计时。实际收多少钱，结账时按商品或套餐算。'
                  : '这里只管计时，钱在美团、大众点评收。到打烊的用到打烊为止，不能暂停、续时、标陪客。'
              }
            >
              <RadioGroup
                type="pureCard"
                direction="horizontal"
                // 不给 name 时 Semi 的单选组都叫 default：两组原生单选框成了一组，选了开始时间，计时就被浏览器取消勾选
                name={`${groupId}-timing`}
                aria-label="计时"
                className="board-open-timing"
                disabled={busy}
                value={timing}
                onChange={(event) => field.handleChange(event.target.value as OpenTiming)}
              >
                {durations.map((minutes) => (
                  // 有对应套餐、收费开着才标价；读不到套餐时的 1、2、3 小时只写时长，不编一个价出来
                  <Radio key={minutes} value={minutes} extra={durationPrice(packages, minutes, billing) || undefined}>
                    {minutesText(minutes)}
                  </Radio>
                ))}
                <Radio value="close" extra={closeNote(closeMinute, now)}>
                  到打烊
                </Radio>
                <Radio value="free" extra="没有结束时间">
                  自由计时
                </Radio>
              </RadioGroup>
              <NamedSelect
                label="其他时长"
                placeholder="其他时长"
                style={{ width: 200 }}
                disabled={busy}
                value={other ? timing : undefined}
                onChange={(value) => field.handleChange(Number(value))}
                optionList={otherChoices(durations).map((minutes) => ({
                  value: minutes,
                  label: minutesText(minutes),
                }))}
              />
            </Section>
          )
        }}
      </form.Field>

      <Section title="开始时间" help={limits.help}>
        <form.Field name="start">
          {(field) => (
            <RadioGroup
              type="button"
              name={`${groupId}-start`}
              aria-label="开始时间"
              disabled={busy}
              value={field.state.value}
              onChange={(event) => {
                const next = event.target.value as 'now' | 'earlier'
                field.handleChange(next)
                // 改成回填时先填上此刻，员工从这里往前调
                if (next === 'earlier' && !form.getFieldValue('clock'))
                  form.setFieldValue('clock', storeClock(Date.now()))
              }}
            >
              <Radio value="now">现在</Radio>
              <Radio value="earlier">回填更早的时间</Radio>
            </RadioGroup>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.start}>
          {(start) =>
            start === 'now' ? (
              <Typography.Text type="secondary" size="small">
                从点「确认开台」的那一刻开始计时。
              </Typography.Text>
            ) : (
              <form.Field name="clock">
                {(field) => {
                  const error = field.state.meta.errors
                    .map((item) => (typeof item === 'string' ? item : item?.message))
                    .filter(Boolean)
                    .join('；')
                  return (
                    <div style={{ display: 'grid', gap: 4 }}>
                      {/* 只选时:分，日期固定是门店的今天；值按「时:分」字符串存取，不经过电脑时区 */}
                      <TimePicker
                        aria-label="回填的开始时间"
                        format="HH:mm"
                        style={{ width: 160 }}
                        showClear={false}
                        hideDisabledOptions
                        disabled={busy}
                        disabledHours={disabled.hours}
                        disabledMinutes={disabled.minutes}
                        value={field.state.value || undefined}
                        validateStatus={error ? 'error' : 'default'}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? clockId : undefined}
                        onChange={(_time: unknown, text: unknown) =>
                          field.handleChange(typeof text === 'string' ? text : '')
                        }
                      />
                      {error ? (
                        <Typography.Text id={clockId} type="danger" size="small">
                          {error}
                        </Typography.Text>
                      ) : null}
                    </div>
                  )
                }}
              </form.Field>
            )
          }
        </form.Subscribe>
      </Section>

      {/* 后端的原话：座位被预约、桌已被占、无权回填……；「上一次其实已经生效」不是失败，用提醒的样子 */}
      {open.error ? (
        <Banner
          type={isPreviousApplied(open.error) ? 'warning' : 'danger'}
          closeIcon={null}
          description={open.error.message}
        />
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        <form.Subscribe selector={(state) => state.values}>
          {(values) => (
            <Typography.Text type="secondary" data-open-summary>
              {openSummary(values)}
            </Typography.Text>
          )}
        </form.Subscribe>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            type="primary"
            theme="solid"
            size="large"
            style={{ flex: 1 }}
            loading={busy}
            disabled={!free}
            onClick={() => void form.handleSubmit()}
          >
            确认开台
          </Button>
          <Button size="large" disabled={busy} onClick={onClose}>
            取消
          </Button>
        </div>
      </div>
    </div>
  )
}
