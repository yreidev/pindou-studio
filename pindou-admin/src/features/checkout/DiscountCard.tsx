import { Banner, Button, Card, Input, Radio, RadioGroup, Typography } from '@douyinfe/semi-ui'
import { useId } from 'react'
import { Field } from '../../components/Field'
import { discountFormZeroesOrder, discountKindNames, zeroReceivableMessage, type DiscountKind } from './discount'
import type { DiscountForm } from './forms'

/**
 * 人工折扣（店长、老板）：比例或固定金额，写原因。明细改过要先保存，再按保存后的应收打折；
 * 减多少钱由后端算，应用后页面换成后端返回的订单（已有的折扣列在收款卡片里）。
 * 会把应收减到 0 的（减免 100%、固定减免不少于应收）填的时候就说明、不给提交：整单不收钱要用免单，后端也拒绝。
 */
export function DiscountCard({
  form,
  receivableCents,
  disabled,
  linesDirty,
  applying,
  error,
  errorType = 'danger',
}: {
  form: DiscountForm
  /** 保存后的应收（已扣掉之前的折扣）。 */
  receivableCents: number
  disabled: boolean
  linesDirty: boolean
  applying: boolean
  error: string | null
  /** 「上一次其实已经生效」这类不是失败的说明用 warning。 */
  errorType?: 'danger' | 'warning'
}) {
  const locked = disabled || linesDirty
  // 原生单选框按 name 分组：不给 name 时 Semi 都叫 default，会和收款方式那一组搅在一起
  const kindGroupName = useId()
  return (
    <Card title="人工折扣">
      {error ? <Banner type={errorType} closeIcon={null} description={error} style={{ marginBottom: 12 }} /> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!locked) void form.handleSubmit()
        }}
      >
        <form.Field name="kind">
          {(field) => (
            <Field label="折扣方式" labelMode="radiogroup">
              {() => (
                <RadioGroup
                  type="button"
                  name={`${kindGroupName}-kind`}
                  disabled={locked}
                  value={field.state.value}
                  onChange={(event) => {
                    field.handleChange(event.target.value as DiscountKind)
                    // 换方式时清空数值：同一个数在两种方式下意思完全不同（10 元和 10%）
                    form.setFieldValue('value', '')
                  }}
                >
                  {(['percentage', 'fixed'] as const).map((kind) => (
                    <Radio key={kind} value={kind}>
                      {discountKindNames[kind]}
                    </Radio>
                  ))}
                </RadioGroup>
              )}
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.kind}>
          {(kind) => (
            <form.Field name="value">
              {(field) => {
                // 会把应收减到 0 的：和填错一样挂在这个框上，读屏聚焦时一起念
                const zeroes = discountFormZeroesOrder({ kind, value: field.state.value }, receivableCents)
                return (
                  <Field
                    label={kind === 'fixed' ? '减免金额（元）' : '减免百分比'}
                    required
                    help={kind === 'fixed' ? '直接减免的金额，单位为元' : '减免比例，例如 10 表示减免 10%，即付九折'}
                    errors={zeroes ? [...field.state.meta.errors, zeroReceivableMessage] : field.state.meta.errors}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        prefix={kind === 'fixed' ? '¥' : undefined}
                        suffix={kind === 'fixed' ? undefined : '%'}
                        placeholder="例如 10"
                        disabled={locked}
                        value={field.state.value}
                        onChange={(value) => field.handleChange(value)}
                        onBlur={field.handleBlur}
                      />
                    )}
                  </Field>
                )
              }}
            </form.Field>
          )}
        </form.Subscribe>
        <form.Field name="reason">
          {(field) => (
            <Field label="折扣原因" required errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  placeholder="必须填写原因"
                  maxLength={200}
                  disabled={locked}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value)}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => discountFormZeroesOrder(state.values, receivableCents)}>
          {(zeroes) => (
            <Button htmlType="submit" loading={applying} disabled={locked || zeroes}>
              应用折扣
            </Button>
          )}
        </form.Subscribe>
        {linesDirty ? (
          <Typography.Text type="tertiary" size="small" className="field-help">
            明细改过还没保存：请先保存明细，再按保存后的应收打折。
          </Typography.Text>
        ) : null}
      </form>
    </Card>
  )
}
