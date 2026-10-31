import { IconEdit } from '@douyinfe/semi-icons'
import { Button, Input, Space, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { inventoryApi } from '../../api/inventory'
import { alertChangeLines, parseAlertAt } from './alert'
import { errorText } from './errors'
import type { StockRow } from './products'
import { confirmDialog } from '../../components/confirm'

function confirmAlertChange(lines: string[]): Promise<boolean> {
  return confirmDialog({
    title: '修改预警线',
    content: (
      <div>
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    ),
    okText: '确认修改',
  })
}

/**
 * 库存表「预警线」一格：店长、老板点「改」就地输入，确认后提交（带幂等键）。
 * 改后是否偏低以接口重读为准，这里不推算。同一时间只编辑一行，由库存表控制。
 */
export function AlertCell({
  row,
  canManage,
  editing,
  onEdit,
  onDone,
}: {
  row: StockRow
  canManage: boolean
  editing: boolean
  onEdit: () => void
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const update = useMutation({
    mutationFn: (alertAt: number) => inventoryApi.updateStockAlert(row.id, alertAt),
    onSuccess: (item) => {
      Toast.success(`${row.name} 的预警线已改为 ${item.alertAt} 件`)
      void queryClient.invalidateQueries()
    },
  })

  if (!editing) {
    return (
      <Space spacing={4}>
        <span>{row.alertAt}</span>
        {canManage ? (
          <Button
            size="small"
            theme="borderless"
            icon={<IconEdit />}
            aria-label={`修改${row.name}的预警线`}
            onClick={() => {
              setText(String(row.alertAt))
              setProblem(null)
              update.reset()
              onEdit()
            }}
          />
        ) : null}
      </Space>
    )
  }

  const save = async () => {
    const parsed = parseAlertAt(text, row.alertAt)
    if (!parsed.ok) {
      setProblem(parsed.message)
      return
    }
    setProblem(null)
    const lines = alertChangeLines({ name: row.name, quantity: row.quantity, from: row.alertAt, to: parsed.value })
    if (!(await confirmAlertChange(lines))) return
    try {
      await update.mutateAsync(parsed.value)
    } catch {
      return // 失败原因显示在输入框下面，输入保留
    }
    onDone()
  }
  const message = problem ?? (update.isError ? errorText(update.error) : null)

  return (
    <div className="alert-editor">
      <Space spacing={4}>
        <Input
          size="small"
          aria-label="新预警线"
          inputMode="numeric"
          suffix="件"
          style={{ width: 96 }}
          autoFocus
          value={text}
          validateStatus={message ? 'error' : 'default'}
          onChange={(value) => {
            setText(value)
            setProblem(null)
          }}
          onEnterPress={() => void save()}
        />
        <Button size="small" theme="solid" type="primary" loading={update.isPending} onClick={() => void save()}>
          保存
        </Button>
        <Button size="small" theme="borderless" type="tertiary" disabled={update.isPending} onClick={onDone}>
          取消
        </Button>
      </Space>
      {message ? (
        <Typography.Text type="danger" size="small" className="field-error">
          {message}
        </Typography.Text>
      ) : null}
    </div>
  )
}
