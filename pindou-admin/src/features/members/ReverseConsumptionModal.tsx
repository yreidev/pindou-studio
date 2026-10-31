import { Banner, Button, Modal, TextArea, Toast } from '@douyinfe/semi-ui'
import { revalidateLogic, useForm } from '@tanstack/react-form'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { useState } from 'react'
import { isPreviousApplied } from '../../api/client'
import { membersApi, type LoyaltyEntry } from '../../api/members'
import { Field } from '../../components/Field'
import { money } from '../../lib/format'
import { entryDate, entryTitle } from './entries'
import { counterErrorMessage, isConflict } from './errors'
import { reasonMaxLength } from './forms'

const reverseSchema = z.object({
  reason: z
    .string()
    .refine((text) => Boolean(text.trim()), '请填写撤销原因')
    .refine((text) => [...text.trim()].length <= reasonMaxLength, '原因最多 200 字'),
})

export function ReverseConsumptionModal({
  entry,
  accountId,
  expectedVersion,
  onClose,
  onReload,
}: {
  entry: LoyaltyEntry
  accountId: string
  expectedVersion: string
  onClose: () => void
  onReload: () => void
}) {
  const [version] = useState(expectedVersion)
  const queryClient = useQueryClient()
  const reverse = useMutation({
    mutationFn: membersApi.reverseConsumption,
    onSuccess: () => {
      Toast.success('已撤销消费，另记了一条反向流水')
      void queryClient.invalidateQueries()
      onClose()
    },
  })
  const form = useForm({
    defaultValues: { reason: '' },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: reverseSchema },
    onSubmit: async ({ value }) => {
      try {
        await reverse.mutateAsync({
          accountId,
          targetId: entry.id,
          expectedVersion: version,
          reason: value.reason.trim(),
        })
      } catch {
        /* 失败保留原因，版本冲突后须重新核对。 */
      }
    },
  })
  return (
    <Modal
      visible
      title="撤销消费"
      maskClosable={false}
      onCancel={() => {
        if (!form.state.isSubmitting) onClose()
      }}
      footer={
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <>
              <Button onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button type="danger" theme="solid" loading={busy} onClick={() => void form.handleSubmit()}>
                确认撤销
              </Button>
            </>
          )}
        </form.Subscribe>
      }
    >
      <p>
        {entryDate(entry)} · {entryTitle(entry)}
      </p>
      <p>
        退回本金 {money(-entry.principalCents)}、赠送余额 {money(-entry.giftCents)}、智能豆板 {-(entry.boardUses ?? 0)}{' '}
        次。
      </p>
      <p>撤销另记一条反向流水，原消费记录保留。另付款项如需退还，请在线下办理。</p>
      {reverse.isError ? (
        <Banner
          type={isPreviousApplied(reverse.error) ? 'warning' : 'danger'}
          closeIcon={null}
          description={
            <span>
              {counterErrorMessage(reverse.error)}
              {isConflict(reverse.error) ? (
                <Button
                  size="small"
                  onClick={() => {
                    onReload()
                    onClose()
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
        <form.Field name="reason">
          {(field) => (
            <Field label="撤销原因" required errors={field.state.meta.errors}>
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
      </form>
    </Modal>
  )
}
