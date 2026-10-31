import { Select } from '@douyinfe/semi-ui'
import { useEffect, useId, type ComponentProps, type ComponentRef, type Ref } from 'react'

type SelectProps = ComponentProps<typeof Select>
/** Semi 下拉框的实例（close、clearInput 等方法）。 */
export type SelectInstance = ComponentRef<typeof Select>

/**
 * 有读屏名的下拉框。Semi 的 Select 不收 aria-label：combobox 上的 aria-label 由它自己写，选中后是英文 selected、
 * 没选时为空，传进去的会被丢掉；名字只能经 aria-labelledby 指向一段文字。可搜索（filter）时框里另有一个搜索框，
 * 用 inputProps 起同样的名字。
 * 页面上已有可见标题时（Field 的 labelledby 模式）调用方会传 aria-labelledby，这里就不再另放一段隐藏文字。
 *
 * focusOnMount：挂上时把焦点放到下拉框上，但不展开。Semi 自己的 autoFocus 在可搜索时会顺带展开下拉列表
 * （弹窗还在打开动画里，列表位置会错开），所以不用它。
 * selectRef：要调 Semi 下拉框实例方法（close、clearInput）时传。
 */
export function NamedSelect({
  label,
  focusOnMount = false,
  selectRef,
  ...props
}: SelectProps & { label: string; focusOnMount?: boolean; selectRef?: Ref<SelectInstance> }) {
  const id = useId()
  const labelledBy = props['aria-labelledby'] ?? id
  useEffect(() => {
    if (!focusOnMount) return
    document
      .querySelector<HTMLElement>(`[role="combobox"][aria-labelledby="${CSS.escape(labelledBy)}"]`)
      ?.focus({ preventScroll: true })
  }, [focusOnMount, labelledBy])
  return (
    <>
      {props['aria-labelledby'] ? null : (
        <span id={id} hidden>
          {label}
        </span>
      )}
      <Select
        {...props}
        ref={selectRef}
        aria-labelledby={labelledBy}
        inputProps={{ ...props.inputProps, 'aria-label': label }}
      />
    </>
  )
}
