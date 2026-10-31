import {
  Banner,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Modal,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { billingApi, billingSettingsQuery, type BillingSettings } from '../../api/billing'
import { ApiError } from '../../api/client'
import { dateTime } from '../../lib/format'
import { canSubmit, maxReasonLength, missingStep, modeOf, saveErrorMessage, switchNote } from './billing'

/**
 * 系统内收费：员工都能看，只有老板能改（后端校验）。平时只读；点「打开…」「关掉…」才弹出对话框，
 * 看清后果、写原因、勾选确认后才能提交。
 */
export function BillingCard({ settings, canEdit }: { settings: BillingSettings; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  const mode = modeOf(settings.enabled)
  return (
    <Card
      title="系统内收费"
      headerExtraContent={
        canEdit ? (
          <Button type={settings.enabled ? 'danger' : 'primary'} onClick={() => setEditing(true)}>
            {settings.enabled ? '关掉…' : '打开…'}
          </Button>
        ) : null
      }
    >
      <Descriptions
        data={[
          {
            key: '现在',
            value: (
              <Tag color={mode.color} size="large">
                {mode.label}
              </Tag>
            ),
          },
          { key: '最后修改', value: settings.updatedAt ? dateTime(settings.updatedAt) : '没改过（默认关）' },
        ]}
      />
      <Typography.Paragraph style={{ marginTop: 8 }}>{mode.summary}</Typography.Paragraph>
      <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
        {mode.effects.map((text) => (
          <li key={text}>
            <Typography.Text type="secondary">{text}</Typography.Text>
          </li>
        ))}
      </ul>
      <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 8 }}>
        结账、订单的功能都还在，打开就恢复。{canEdit ? '' : '只有老板可以开关。'}
      </Typography.Paragraph>
      {editing ? <ToggleDialog settings={settings} onClose={() => setEditing(false)} /> : null}
    </Card>
  )
}

function ToggleDialog({ settings, onClose }: { settings: BillingSettings; onClose: () => void }) {
  const queryClient = useQueryClient()
  // 确认的是打开对话框时看到的状态：期间别人改了（实时事件会刷新 settings），不能悄悄换成新的再提交
  const [expected, setExpected] = useState(settings.enabled)
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const target = !expected
  const draft = { reason, acknowledged }
  const missing = missingStep(draft)
  const action = target ? '打开' : '关掉'

  const save = useMutation({
    mutationFn: () => billingApi.save({ enabled: target, expectedEnabled: expected, reason: reason.trim() }),
    onSuccess: (saved) => {
      queryClient.setQueryData(billingSettingsQuery().queryKey, saved)
      Toast.success(saved.enabled ? '系统内收费已打开：结账后才放座' : '系统内收费已关掉：用完点「结束」放座')
      // 侧栏、看板、套餐价格都跟着开关变，整体重读
      void queryClient.invalidateQueries()
      onClose()
    },
    onError: async (error) => {
      setFailure(saveErrorMessage(error))
      if (error instanceof ApiError && error.code === 'billing_settings_conflict') {
        const fresh = await queryClient.fetchQuery({ ...billingSettingsQuery(), staleTime: 0 })
        setExpected(fresh.enabled)
        setAcknowledged(false)
      }
    },
  })

  return (
    <Modal
      title={`${action}系统内收费`}
      visible
      maskClosable={false}
      width={640}
      onCancel={onClose}
      footer={
        <>
          {missing ? (
            <Typography.Text type="tertiary" style={{ marginRight: 12 }}>
              还差：{missing}
            </Typography.Text>
          ) : null}
          <Button onClick={onClose}>取消</Button>
          <Button
            theme="solid"
            type={target ? 'primary' : 'danger'}
            disabled={!canSubmit(draft)}
            loading={save.isPending}
            onClick={() => {
              setFailure(null)
              save.mutate()
            }}
          >
            确认{action}
          </Button>
        </>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        现在 <Tag color={modeOf(expected).color}>{modeOf(expected).label}</Tag>，{action}后：
      </Typography.Paragraph>
      <Banner
        type="warning"
        fullMode={false}
        closeIcon={null}
        title={modeOf(target).summary}
        description={
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {[...modeOf(target).effects, switchNote(target)].map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        }
        style={{ marginBottom: 16 }}
      />
      <Typography.Text strong style={{ display: 'block', margin: '0 0 8px' }}>
        为什么改（记进操作记录）
      </Typography.Text>
      <TextArea
        aria-label="修改原因"
        placeholder={target ? '例如：开始在系统里结账收款' : '例如：门店的钱都在美团、大众点评收'}
        value={reason}
        maxCount={maxReasonLength}
        autosize={{ minRows: 2, maxRows: 4 }}
        onChange={setReason}
      />
      <Checkbox
        checked={acknowledged}
        onChange={(event) => setAcknowledged(Boolean(event.target.checked))}
        style={{ marginTop: 12 }}
      >
        我已看清{action}后店里怎么收钱、怎么放座
      </Checkbox>
      {failure ? (
        <Banner type="warning" fullMode={false} closeIcon={null} description={failure} style={{ marginTop: 12 }} />
      ) : null}
    </Modal>
  )
}
