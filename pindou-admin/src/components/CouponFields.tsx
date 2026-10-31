import { Input, Radio, RadioGroup } from '@douyinfe/semi-ui'
import { useId } from 'react'
import { couponPlatforms, couponProblem, maxCouponCode, type CouponDraft, type CouponPlatform } from '../lib/coupon'
import { Field } from './Field'

/**
 * 团购记录的两项：平台（美团、大众点评、到店再买，可以不选）和券码。都选填，只是记下来给店员看，
 * 店员在美团开店宝扫顾客手机上的券码核销。代客登记预约、确认扫码入座时用。
 */
export function CouponFields({
  value,
  onChange,
  disabled,
}: {
  value: CouponDraft
  onChange: (value: CouponDraft) => void
  disabled?: boolean
}) {
  const name = useId()
  const problem = couponProblem(value)
  return (
    <>
      <Field
        label="团购平台"
        labelMode="radiogroup"
        help="选填。顾客在哪儿买的团购；还没买、到店再买的选「到店再买」。"
      >
        {() => (
          <RadioGroup
            type="button"
            name={`${name}-platform`}
            disabled={disabled}
            // 「不填」用 none 占位：空串当单选的值，有的版本会当成没选中
            value={value.platform || 'none'}
            onChange={(event) => {
              const picked = event.target.value as CouponPlatform | 'none'
              const platform = picked === 'none' ? '' : picked
              // 不填、到店再买都没有券码：换过去时清掉（券码框随之藏起来，不留看不见的错误）
              onChange({ platform, code: platform === '' || platform === 'in_store' ? '' : value.code })
            }}
          >
            <Radio value="none">不填</Radio>
            {couponPlatforms.map((item) => (
              <Radio key={item.value} value={item.value}>
                {item.label}
              </Radio>
            ))}
          </RadioGroup>
        )}
      </Field>
      {value.platform && value.platform !== 'in_store' ? (
        <Field
          label="券码"
          help={`选填，照顾客手机上的抄，空格不用管；只能是字母和数字，最多 ${maxCouponCode} 位。`}
          errors={problem ? [problem] : undefined}
        >
          {(control) => (
            <Input
              {...control}
              style={{ width: 280 }}
              placeholder="如 1234 5678 9012"
              disabled={disabled}
              value={value.code}
              onChange={(code) => onChange({ ...value, code })}
            />
          )}
        </Field>
      ) : null}
    </>
  )
}
