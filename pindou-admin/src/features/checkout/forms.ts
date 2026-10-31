import { revalidateLogic, useForm } from '@tanstack/react-form'
import type { DiscountInput, OrderLineInput } from '../../api/checkout'
import { discountFormSchema, emptyDiscountForm, toDiscountInput } from './discount'
import { linesSchema, toOrderLines, type DraftLine } from './lines'

// 结账页的两张表单（TanStack Form + Zod）。表单状态放在结账页本身，订单换了版本（保存、打折、重新读取）时由页面重置；
// 失败原因由页面按请求显示，表单只管输入与校验。提交前先校验，校验过了才发请求。

/** 订单明细：保存时整份替换。onSave 抛错时输入保留（冲突等人工重读，结果不确定可原样再提交）。 */
export function useLinesForm(initial: DraftLine[], onSave: (lines: OrderLineInput[]) => Promise<unknown>) {
  return useForm({
    defaultValues: { lines: initial },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: linesSchema },
    onSubmit: async ({ value }) => {
      try {
        await onSave(toOrderLines(value.lines))
      } catch {
        // 失败原因显示在明细卡片上，输入保留
      }
    },
  })
}

export type LinesForm = ReturnType<typeof useLinesForm>

/** 人工折扣：成功后清空；失败时保留输入（版本冲突后重读，再由人确认）。 */
export function useDiscountForm(onApply: (input: Omit<DiscountInput, 'expectedVersion'>) => Promise<unknown>) {
  return useForm({
    defaultValues: emptyDiscountForm(),
    validationLogic: revalidateLogic(),
    validators: { onDynamic: discountFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await onApply(toDiscountInput(value))
      } catch {
        return
      }
      formApi.reset(emptyDiscountForm())
    },
  })
}

export type DiscountForm = ReturnType<typeof useDiscountForm>
