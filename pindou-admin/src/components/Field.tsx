import { Typography } from '@douyinfe/semi-ui'
import { useId, type ReactNode } from 'react'

// 表单的一项：标题、控件、说明、校验错误。全站的表单都用它（退款、库存、结账、预约设置、规则草稿）。
//
// 表单状态用 TanStack Form，不用 Semi 的 Form：Semi 虽然单独导出了 Form.Label、Form.ErrorMessage，但 Form 的静态属性
// 挂着全部字段控件（树选择、级联、上传、评分……），引一个 Form 就把这些从没用过的控件都打进包里。所以这里自己排版，
// 无障碍照 Semi 表单字段的做法接好：标题接到控件上，控件带 aria-describedby 指向说明和错误，
// 出错时 aria-invalid、aria-errormessage，必填时 aria-required。

/** TanStack Form 给的错误：Zod issue、字符串，或 undefined。 */
export type FieldErrors = ReadonlyArray<unknown>

/** 字段的校验错误合成一句，同一句只显示一次。 */
export function errorMessages(errors: FieldErrors | undefined): string {
  const texts = (errors ?? [])
    .map((error) => (typeof error === 'string' ? error : (error as { message?: string } | undefined)?.message))
    .filter((text): text is string => Boolean(text))
  return [...new Set(texts)].join('；')
}

/**
 * 交给控件的属性：Semi 的 Input、InputNumber、TextArea、Select 都原样放到原生输入元素（或下拉框的 combobox）上，
 * 直接展开即可；Switch、CheckboxGroup 不收 validateStatus，按需取用。
 */
export interface FieldControl {
  id: string
  validateStatus: 'error' | 'default'
  'aria-describedby'?: string
  'aria-errormessage'?: string
  'aria-invalid'?: true
  'aria-required'?: true
  /** 只在 labelMode 为 labelledby 时给：控件用它指向标题。 */
  'aria-labelledby'?: string
}

/**
 * 标题怎么接到控件上：
 * - for（默认）：<label for>，控件是原生输入（Input、InputNumber、TextArea、Switch）；
 * - labelledby：控件自己认 aria-labelledby，但不是能被 <label for> 指向的元素（Select 的 combobox、CheckboxGroup 的 list）；
 * - group、radiogroup：控件自己起不了名字（Semi 单选组的外层是不带角色的 div、日期选择器的触发框名字写死成英文），
 *   由外层这一组带上标题、说明和错误。
 */
export type FieldLabelMode = 'for' | 'labelledby' | 'group' | 'radiogroup'

export function Field({
  label,
  help,
  errors,
  required,
  labelMode = 'for',
  compact,
  children,
}: {
  /** 不给标题时控件自己用 aria-label 起名（明细表里的一格，列头已经写了是什么）。 */
  label?: ReactNode
  help?: ReactNode
  errors?: FieldErrors
  /** 必填：标题后加红色星号，控件带 aria-required。 */
  required?: boolean
  labelMode?: FieldLabelMode
  /** 表格里的一格：下面不留间距。 */
  compact?: boolean
  children: (control: FieldControl) => ReactNode
}) {
  const id = useId()
  const labelId = `${id}-label`
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  const error = errorMessages(errors)
  const describedBy = [help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined
  const group = labelMode === 'group' || labelMode === 'radiogroup'
  // 成组时标题、说明、错误都挂在外层这一组上，里面的控件不再重复挂（读屏进组时念一次）
  const control: FieldControl = group
    ? { id, validateStatus: error ? 'error' : 'default' }
    : {
        id,
        validateStatus: error ? 'error' : 'default',
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true, 'aria-errormessage': errorId } : {}),
        ...(required ? { 'aria-required': true } : {}),
        ...(labelMode === 'labelledby' && label ? { 'aria-labelledby': labelId } : {}),
      }
  // aria-invalid、aria-required 只有单选组这种角色认，普通的 group 不认（错误照样在说明里念）
  const groupState =
    labelMode === 'radiogroup'
      ? {
          'aria-invalid': error ? true : undefined,
          'aria-errormessage': error ? errorId : undefined,
          'aria-required': required ? true : undefined,
        }
      : {}
  // 必填的星号放在标题元素外面：读屏念名字、端到端按标题找输入框时都不带「*」
  const title = label ? (
    <div className="field-label">
      {labelMode === 'for' ? (
        <label id={labelId} htmlFor={id}>
          <Typography.Text strong>{label}</Typography.Text>
        </label>
      ) : (
        <span id={labelId}>
          <Typography.Text strong>{label}</Typography.Text>
        </span>
      )}
      {required ? (
        <Typography.Text type="danger" strong aria-hidden>
          {' *'}
        </Typography.Text>
      ) : null}
    </div>
  ) : null
  return (
    <div
      className={compact ? 'field field-compact' : 'field'}
      {...(group
        ? {
            role: labelMode,
            'aria-labelledby': label ? labelId : undefined,
            'aria-describedby': describedBy,
            ...groupState,
          }
        : {})}
    >
      {title}
      {children(control)}
      {help ? (
        <div id={helpId} className="field-help">
          <Typography.Text type="tertiary" size="small">
            {help}
          </Typography.Text>
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="field-error">
          <Typography.Text type="danger" size="small">
            {error}
          </Typography.Text>
        </div>
      ) : null}
    </div>
  )
}
