import {
  Banner,
  Button,
  Card,
  Col,
  Input,
  Radio,
  RadioGroup,
  Row,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { hasRole, useCurrentAccount } from '../../account'
import { isPreviousApplied } from '../../api/client'
import { membersApi, type LoyaltyEntry, type LoyaltyMember } from '../../api/members'
import { confirmDialog } from '../../components/confirm'
import { Field } from '../../components/Field'
import { NamedSelect } from '../../components/NamedSelect'
import { parseYuan } from '../../lib/format'
import { consumptionConfirmText, consumptionFormSchema, defaultDayType, emptyConsumptionForm } from './consumption'
import { counterErrorMessage, isConflict } from './errors'
import { reasonMaxLength } from './forms'
import { ServiceDateField } from './ServiceDateField'
import { CopyMemberEntry } from './CopyMemberEntry'
import { registeredEntry } from './copy'
import { packagesByDuration } from './consumption'

export function ConsumptionCard({
  member,
  accountId,
  label,
}: {
  member: LoyaltyMember
  accountId: string
  label: string
}) {
  const canBackdate = hasRole(useCurrentAccount(), 'manager', 'owner')
  const queryClient = useQueryClient()
  const [rereading, setRereading] = useState(false)
  const [registered, setRegistered] = useState<LoyaltyEntry>()
  const consume = useMutation({
    mutationFn: membersApi.consume,
    onSuccess: () => {
      Toast.success('已登记消费')
      void queryClient.invalidateQueries()
    },
  })
  const form = useForm({
    defaultValues: emptyConsumptionForm(),
    validationLogic: revalidateLogic(),
    validators: { onDynamic: consumptionFormSchema(canBackdate, member.balance.boardUses) },
    onSubmit: async ({ value, formApi }) => {
      // 确认框打开后不替换版本；期间发生的资产变化由后端拒绝，员工重读后再确认。
      const expectedVersion = member.version
      const amountCents = parseYuan(value.amount) as number
      const boardUses = Number(value.boardUses)
      const packageName = member.rules.find((rule) => rule.id === value.packageId)?.name ?? '其他'
      if (
        !(await confirmDialog({
          title: '确认消费登记',
          okText: '确认登记',
          content: (
            <div>
              <div>会员：{label}</div>
              <div>
                {value.serviceDate} · {value.headcount === '1' ? '单人' : '双人'} · {packageName} ·{' '}
                {value.dayType === 'holiday' ? '节假日' : '工作日'}
              </div>
              {consumptionConfirmText(member.balance, amountCents, boardUses).map((line) => (
                <div key={line}>{line}</div>
              ))}
              {value.reason.trim() ? <div>备注：{value.reason.trim()}</div> : null}
              <Typography.Text type="tertiary">以上数字供核对，登记结果以后端返回为准。</Typography.Text>
            </div>
          ),
        }))
      )
        return
      try {
        const result = await consume.mutateAsync({
          accountId,
          expectedVersion,
          serviceDate: value.serviceDate,
          reason: value.reason.trim() || undefined,
          consumption: {
            packageId: value.packageId || undefined,
            headcount: value.headcount === '1' ? 1 : 2,
            dayType: value.dayType,
            amountCents,
            boardUses,
          },
        })
        setRegistered(registeredEntry(member.entries, result.entries, 'consume'))
        formApi.reset(emptyConsumptionForm())
      } catch {
        /* 失败保留输入，重新读取后由员工再次确认。 */
      }
    },
  })
  return (
    <Card title="消费登记">
      {registered ? <CopyMemberEntry entry={registered} entries={member.entries} success /> : null}
      {consume.isError ? (
        <Banner
          type={isPreviousApplied(consume.error) ? 'warning' : 'danger'}
          closeIcon={null}
          style={{ marginBottom: 12 }}
          description={
            <span>
              {counterErrorMessage(consume.error)}
              {isConflict(consume.error) ? (
                <Button
                  size="small"
                  theme="borderless"
                  loading={rereading}
                  onClick={async () => {
                    setRereading(true)
                    try {
                      await queryClient.invalidateQueries({ queryKey: ['loyalty'] }, { throwOnError: true })
                      consume.reset()
                    } catch (error) {
                      Toast.error(error instanceof Error ? error.message : '重新读取失败，请稍后重试')
                    } finally {
                      setRereading(false)
                    }
                  }}
                >
                  重新读取
                </Button>
              ) : null}
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
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <fieldset disabled={busy || rereading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <Row gutter={16}>
                <Col span={24} md={12}>
                  <form.Field name="serviceDate">
                    {(field) => (
                      <ServiceDateField
                        label="消费日期"
                        value={field.state.value}
                        errors={field.state.meta.errors}
                        canBackdate={canBackdate}
                        disabled={busy || rereading}
                        onChange={(day) => {
                          field.handleChange(day)
                          form.setFieldValue('dayType', defaultDayType(day))
                        }}
                      />
                    )}
                  </form.Field>
                </Col>
                <Col span={24} md={12}>
                  <form.Field name="packageId">
                    {(field) => (
                      <Field label="消费套餐" labelMode="labelledby" errors={field.state.meta.errors}>
                        {(control) => (
                          <NamedSelect
                            {...control}
                            label="消费套餐"
                            disabled={busy || rereading}
                            style={{ width: '100%' }}
                            value={field.state.value}
                            onChange={(value) => field.handleChange(String(value ?? ''))}
                            optionList={[
                              ...packagesByDuration(member.rules).map((rule) => ({ value: rule.id, label: rule.name })),
                              { value: '', label: '其他' },
                            ]}
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                </Col>
                <Col span={24} md={12}>
                  <form.Field name="headcount">
                    {(field) => (
                      <Field label="消费人数" labelMode="radiogroup">
                        {() => (
                          <RadioGroup
                            name="consumption-headcount"
                            type="button"
                            disabled={busy || rereading}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(String(event.target.value))}
                          >
                            <Radio value="1">单人</Radio>
                            <Radio value="2">双人</Radio>
                          </RadioGroup>
                        )}
                      </Field>
                    )}
                  </form.Field>
                </Col>
                <Col span={24} md={12}>
                  <form.Field name="dayType">
                    {(field) => (
                      <Field label="日期类型" labelMode="radiogroup" help="周六日默认节假日，法定节假日可手动改。">
                        {() => (
                          <RadioGroup
                            name="consumption-day-type"
                            type="button"
                            disabled={busy || rereading}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value as 'workday' | 'holiday')}
                          >
                            <Radio value="workday">工作日</Radio>
                            <Radio value="holiday">节假日</Radio>
                          </RadioGroup>
                        )}
                      </Field>
                    )}
                  </form.Field>
                </Col>
                <Col span={24} md={12}>
                  <form.Field name="amount">
                    {(field) => (
                      <Field label="消费金额（元）" required errors={field.state.meta.errors}>
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="decimal"
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                            placeholder="按价目填写，可为 0"
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                </Col>
                <Col span={24} md={12}>
                  <form.Field name="boardUses">
                    {(field) => (
                      <Field
                        label="智能豆板用几次"
                        help={`当前剩 ${member.balance.boardUses} 次，每笔最多用 100 次。`}
                        errors={field.state.meta.errors}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="numeric"
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                          />
                        )}
                      </Field>
                    )}
                  </form.Field>
                </Col>
              </Row>
              <form.Field name="reason">
                {(field) => (
                  <Field label="消费备注" help="选「其他」时必填，最多 200 字。" errors={field.state.meta.errors}>
                    {(control) => (
                      <TextArea
                        {...control}
                        rows={2}
                        autosize
                        maxCount={reasonMaxLength}
                        value={field.state.value}
                        onChange={field.handleChange}
                        onBlur={field.handleBlur}
                      />
                    )}
                  </Field>
                )}
              </form.Field>
              <Button htmlType="submit" theme="solid" loading={busy}>
                登记消费
              </Button>
            </fieldset>
          )}
        </form.Subscribe>
      </form>
    </Card>
  )
}
