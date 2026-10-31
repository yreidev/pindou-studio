import { Banner, Modal, TextArea, Typography } from '@douyinfe/semi-ui'
import { useState, type ReactNode } from 'react'
import { isPreviousApplied } from '../../api/client'
import { reservationsApi, type ReservationEntry } from '../../api/reservations'
import { dialogButtons } from '../../components/confirm'
import { Field } from '../../components/Field'
import { useBoardAction } from '../board/useBoardAction'
import { charLength, noteLimit, whenText } from './reservations'

type Kind = 'cancel' | 'no_show'

const texts: Record<Kind, { title: string; done: string; effect: string }> = {
  cancel: {
    title: '取消预约',
    done: '预约已取消',
    effect: '取消后座位释放，顾客在小程序「我的预约」里看到已取消。',
  },
  no_show: {
    title: '标记爽约',
    done: '已标记爽约',
    effect: '记为未到店并释放座位。老板设了爽约限制时，最近爽约次数够了的顾客会暂停自助预约。',
  },
}

/**
 * 取消预约、标记爽约：点了当场问一句原因（可不填，记进这条预约和审计），同小程序。
 * 原因跟着这一次操作走，关了就清掉，不留给下一条预约误用。请求回来之前弹窗不关：失败原因写在弹窗里，填的原因不丢；
 * 结果未知后再点同一个按钮，由接口客户端先原样重发上一次（已生效就提示「上次已生效」）。
 */
export function useReasonDialog({ placeOf }: { placeOf: (entry: ReservationEntry) => string }): {
  ask: (entry: ReservationEntry, kind: Kind) => void
  dialog: ReactNode
} {
  const action = useBoardAction()
  const [target, setTarget] = useState<{ entry: ReservationEntry; kind: Kind } | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  const ask = (entry: ReservationEntry, kind: Kind) => {
    action.reset()
    setReason('')
    setTarget({ entry, kind })
    setOpen(true)
  }
  const tooLong = charLength(reason.trim()) > noteLimit
  const text = target ? texts[target.kind] : texts.cancel

  const dialog = (
    <Modal
      title={text.title}
      visible={open}
      okText={text.title}
      okType="danger"
      confirmLoading={action.isPending}
      okButtonProps={{ ...dialogButtons.okButtonProps, disabled: tooLong }}
      cancelText="返回"
      // 打开时焦点给原因输入框（取消按钮默认会抢走焦点）；请求进行中不让关，免得失败原因没处显示
      cancelButtonProps={{ ...dialogButtons.cancelButtonProps, autoFocus: false, disabled: action.isPending }}
      closable={!action.isPending}
      maskClosable={!action.isPending}
      closeOnEsc={!action.isPending}
      onCancel={() => setOpen(false)}
      afterClose={() => {
        setTarget(null)
        setReason('')
      }}
      onOk={() => {
        // 不返回 Promise：失败时 Semi 会把它再抛成没人接的 rejection
        if (!target || tooLong) return
        const trimmed = reason.trim()
        const { entry, kind } = target
        action.mutate(
          {
            run: () =>
              reservationsApi.act({
                action: kind,
                targetId: entry.reservation.id,
                ...(trimmed ? { reason: trimmed } : {}),
              }),
            done: text.done,
          },
          { onSuccess: () => setOpen(false) },
        )
      }}
    >
      {target ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <Typography.Text>
            {whenText(target.entry)} · {placeOf(target.entry)} · {target.entry.customerName || '未填写称呼'}
          </Typography.Text>
          <Typography.Text type="tertiary" size="small">
            {text.effect}
          </Typography.Text>
          {action.error ? (
            <Banner
              type={isPreviousApplied(action.error) ? 'warning' : 'danger'}
              closeIcon={null}
              description={action.error.message}
            />
          ) : null}
          <Field
            label="原因"
            help="可不填，会记进这条预约，对账时看得到。"
            errors={tooLong ? [`原因最多 ${noteLimit} 字`] : undefined}
          >
            {(control) => (
              <TextArea
                {...control}
                autoFocus
                value={reason}
                onChange={(value) => setReason(value)}
                maxCount={noteLimit}
                getValueLength={charLength}
                autosize={{ minRows: 2, maxRows: 5 }}
                placeholder={target.kind === 'cancel' ? '例如：顾客来电改期' : '例如：电话联系不上'}
              />
            )}
          </Field>
        </div>
      ) : null}
    </Modal>
  )

  return { ask, dialog }
}
