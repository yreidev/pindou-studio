import { DatePicker } from '@douyinfe/semi-ui'
import { Field, type FieldErrors } from '../../components/Field'
import { calendarDay, serviceDateError } from './consumption'

export function ServiceDateField({
  label,
  value,
  onChange,
  canBackdate,
  disabled,
  errors,
}: {
  label: string
  value: string
  onChange: (day: string) => void
  canBackdate: boolean
  disabled?: boolean
  errors?: FieldErrors
}) {
  return (
    <Field
      label={label}
      labelMode="group"
      required
      errors={errors}
      help={
        canBackdate
          ? '按门店日期（中国时间），可补录以前的记录，不能选将来。'
          : '按门店日期（中国时间），可选今天往前 7 天以内；更早的请店长、老板补录。'
      }
    >
      {() => (
        <DatePicker
          type="date"
          format="yyyy-MM-dd"
          placeholder={`选择${label}`}
          value={value}
          showClear={false}
          disabled={disabled}
          disabledDate={(date) => Boolean(date && serviceDateError(calendarDay(date), canBackdate))}
          onChange={(_, text) => {
            if (typeof text === 'string') onChange(text)
          }}
        />
      )}
    </Field>
  )
}
