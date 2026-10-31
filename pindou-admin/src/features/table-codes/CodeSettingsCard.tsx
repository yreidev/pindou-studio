import {
  Banner,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Modal,
  Radio,
  RadioGroup,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../../api/client'
import { codeSettingsApi, codeSettingsQuery, type CodeSettings, type MiniProgramEnv } from '../../api/table-codes'
import { dateTime } from '../../lib/format'
import {
  canSubmit,
  changeWarnings,
  envOption,
  envOptions,
  maxReasonLength,
  missingStep,
  saveErrorMessage,
} from './code-settings'

/**
 * 小程序码指向的版本：员工都能看，只有老板能改（后端校验）。平时只读；点「修改」才打开带提醒的对话框，
 * 要选版本、写原因、勾选确认后才能提交。
 */
export function CodeSettingsCard({ settings, canEdit }: { settings: CodeSettings; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  const current = envOption(settings.envVersion)
  return (
    <Card
      title="小程序码指向的版本"
      style={{ marginBottom: 16 }}
      headerExtraContent={
        canEdit ? (
          <Button type="danger" onClick={() => setEditing(true)}>
            修改…
          </Button>
        ) : null
      }
    >
      <Descriptions
        data={[
          {
            key: '现在指向',
            value: (
              <Tag color={current.color} size="large">
                {current.label}
              </Tag>
            ),
          },
          { key: '最后修改', value: settings.updatedAt ? dateTime(settings.updatedAt) : '没改过（默认体验版）' },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        桌码里的小程序码和网页后台登录页的小程序码都指向这个版本。{current.detail}
        小程序正式版审核发布后再改成正式版，平时不要动。{canEdit ? '' : '只有老板可以修改。'}
      </Typography.Paragraph>
      {editing ? <ChangeEnvDialog settings={settings} onClose={() => setEditing(false)} /> : null}
    </Card>
  )
}

function ChangeEnvDialog({ settings, onClose }: { settings: CodeSettings; onClose: () => void }) {
  const queryClient = useQueryClient()
  // 确认的是打开对话框时看到的版本：期间别人改了（实时事件会刷新 settings），不能悄悄换成新的再提交
  const [expected, setExpected] = useState<MiniProgramEnv>(settings.envVersion)
  const [target, setTarget] = useState<MiniProgramEnv>(settings.envVersion)
  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const draft = { current: expected, target, reason, acknowledged }
  const missing = missingStep(draft)

  const save = useMutation({
    mutationFn: () => codeSettingsApi.save({ envVersion: target, expectedEnvVersion: expected, reason: reason.trim() }),
    onSuccess: (saved) => {
      queryClient.setQueryData(codeSettingsQuery().queryKey, saved)
      Toast.success(`已改成${envOption(saved.envVersion).label}：之后新生成的小程序桌码和网页后台登录码都指向它`)
      onClose()
    },
    onError: async (error) => {
      setFailure(saveErrorMessage(error))
      if (error instanceof ApiError && error.code === 'code_settings_conflict') {
        const fresh = await queryClient.fetchQuery({ ...codeSettingsQuery(), staleTime: 0 })
        setExpected(fresh.envVersion)
        setAcknowledged(false)
      }
    },
  })

  return (
    <Modal
      title="修改小程序码指向的版本"
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
            type="danger"
            disabled={!canSubmit(draft)}
            loading={save.isPending}
            onClick={() => {
              setFailure(null)
              save.mutate()
            }}
          >
            确认改成{envOption(target).label}
          </Button>
        </>
      }
    >
      <Banner
        type="danger"
        fullMode={false}
        closeIcon={null}
        title="不要随便改：改错了顾客扫不开桌码、员工登录不了网页后台"
        description={
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {changeWarnings.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        }
        style={{ marginBottom: 16 }}
      />
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        现在指向 <Tag color={envOption(expected).color}>{envOption(expected).label}</Tag>，改成：
      </Typography.Paragraph>
      <RadioGroup
        type="pureCard"
        direction="vertical"
        name="miniprogram-env"
        value={target}
        onChange={(event) => setTarget(event.target.value as MiniProgramEnv)}
        style={{ width: '100%' }}
      >
        {envOptions.map((option) => (
          <Radio key={option.value} value={option.value} extra={option.detail} style={{ width: '100%' }}>
            {option.label}
            {option.value === expected ? '（现在）' : ''}
          </Radio>
        ))}
      </RadioGroup>
      <Typography.Text strong style={{ display: 'block', margin: '16px 0 8px' }}>
        为什么改（记进操作记录）
      </Typography.Text>
      <TextArea
        aria-label="修改原因"
        placeholder="例如：小程序正式版已审核发布"
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
        我已看完上面的提醒，知道改错会让顾客扫不开桌码、员工登录不了网页后台
      </Checkbox>
      <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 12 }}>
        保存前会先用新版本试生成一次小程序码，微信不接受就不保存，现在的设置不变。
      </Typography.Paragraph>
      {failure ? (
        <Banner type="warning" fullMode={false} closeIcon={null} description={failure} style={{ marginTop: 12 }} />
      ) : null}
    </Modal>
  )
}
