import { Banner, Button, Checkbox, Input, Modal, Toast } from '@douyinfe/semi-ui'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { membersApi, type LoyaltyMemberSummary } from '../../api/members'
import { Field } from '../../components/Field'
import { memberAccountFormSchema } from './consumption'

export function OpenMemberModal({
  onClose,
  onOpened,
}: {
  onClose: () => void
  onOpened: (member: LoyaltyMemberSummary) => void
}) {
  const queryClient = useQueryClient()
  const open = useMutation({
    mutationFn: membersApi.openAccount,
    onSuccess: (result) => {
      Toast.success(result.existing ? '这个手机号已经有账户，已为你打开' : '已代开会员')
      void queryClient.invalidateQueries()
      onOpened(result.account)
      onClose()
    },
  })
  const form = useForm({
    defaultValues: { nickname: '', phone: '', consent: false },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: memberAccountFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await open.mutateAsync({ nickname: value.nickname.trim(), phone: value.phone.trim(), consent: true })
      } catch {
        /* 失败说明留在弹框里，输入保留。 */
      }
    },
  })
  return (
    <Modal
      visible
      title="代开会员"
      maskClosable={false}
      onCancel={() => {
        if (!form.state.isSubmitting) onClose()
      }}
      footer={
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <>
              <Button disabled={busy} onClick={onClose}>
                取消
              </Button>
              <Button theme="solid" loading={busy} onClick={() => void form.handleSubmit()}>
                确认代开
              </Button>
            </>
          )}
        </form.Subscribe>
      }
    >
      {open.isError ? <Banner type="danger" closeIcon={null} description={open.error.message} /> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="nickname">
          {(field) => (
            <Field label="称呼" required errors={field.state.meta.errors}>
              {(control) => (
                <Input {...control} value={field.state.value} onChange={field.handleChange} onBlur={field.handleBlur} />
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="phone">
          {(field) => (
            <Field label="手机号" required errors={field.state.meta.errors}>
              {(control) => (
                <Input
                  {...control}
                  type="tel"
                  value={field.state.value}
                  onChange={field.handleChange}
                  onBlur={field.handleBlur}
                />
              )}
            </Field>
          )}
        </form.Field>
        <form.Field name="consent">
          {(field) => (
            <Field errors={field.state.meta.errors}>
              {(control) => (
                <Checkbox
                  id={control.id}
                  aria-describedby={control['aria-describedby']}
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(Boolean(event.target.checked))}
                >
                  顾客已同意门店记下称呼和手机号
                </Checkbox>
              )}
            </Field>
          )}
        </form.Field>
      </form>
    </Modal>
  )
}
