import { Input, Text, View } from '@tarojs/components'
import { Button } from './button'
import { couponPlatforms, couponProblem, maxCouponCode, type CouponDraft } from '../services/coupon'
import './coupon-fields.scss'

/**
 * 团购记录的两项：平台（美团、大众点评、到店再买，可以不选）和券码，都选填。顾客预约、扫码入座时填，
 * 员工确认入座时可以改；店员在美团开店宝扫顾客手机上的券码核销，系统只记下来。
 */
export function CouponFields({
  value,
  onChange,
  disabled = false,
  customer = false,
}: {
  value: CouponDraft
  onChange: (value: CouponDraft) => void
  disabled?: boolean
  /** 顾客自己填：说明换成对顾客说的话 */
  customer?: boolean
}) {
  const problem = couponProblem(value)
  const options: { value: CouponDraft['platform']; label: string }[] = [
    { value: '', label: '不填' },
    ...couponPlatforms,
  ]
  return (
    <View className="coupon-fields">
      <Text className="field-label">团购（选填）</Text>
      <View className="coupon-platforms" role="radiogroup">
        {options.map((option) => {
          const on = value.platform === option.value
          return (
            <Button
              key={option.value || 'none'}
              className={`coupon-platform ${on ? 'coupon-platform-selected' : ''}`}
              disabled={disabled}
              ariaLabel={`${option.label}${on ? '，已选中' : ''}`}
              onClick={() =>
                // 不填、到店再买都没有券码：换过去时清掉（券码框随之藏起来，不留看不见的错误）
                onChange({
                  platform: option.value,
                  code: option.value === '' || option.value === 'in_store' ? '' : value.code,
                })
              }
            >
              {option.label}
            </Button>
          )
        })}
      </View>
      {value.platform && value.platform !== 'in_store' ? (
        <View className="coupon-code">
          <Text className="field-label">券码（选填）</Text>
          <Input
            className={`input ${problem ? 'input-invalid' : ''}`}
            value={value.code}
            maxlength={maxCouponCode + 16}
            disabled={disabled}
            placeholder="如 1234 5678 9012"
            onInput={(event) => onChange({ ...value, code: event.detail.value })}
          />
        </View>
      ) : null}
      {problem ? (
        <View className="field-error" role="alert">
          {problem}
        </View>
      ) : (
        <Text className="field-help">
          {customer
            ? '在美团、大众点评买了团购的选一下，券码照手机上的抄，到店给店员核销；还没买的选「到店再买」。'
            : '顾客在哪儿买的团购；券码照顾客手机上的抄，空格不用管。核销在美团开店宝做。'}
        </Text>
      )}
    </View>
  )
}
