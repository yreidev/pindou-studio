import { Banner, Button, Card, Descriptions, Modal, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { issueTemporaryPassword, type PasswordReset } from '../../api/accounts'
import { confirmDialog } from '../../components/confirm'
import { dateTime } from '../../lib/format'

/**
 * 认领会员用的临时密码：员工代开的会员（或以前在顾客网页注册的账户）没有绑微信，顾客在小程序登录页「店员帮我开过会员，去认领」
 * 里用手机号加这个临时密码认领。临时密码只在弹窗里显示这一次，当面告诉顾客，不另存。
 */
export function ClaimPasswordCard({ accountId, label }: { accountId: string; label: string }) {
  const [issued, setIssued] = useState<PasswordReset | null>(null)
  const reset = useMutation({
    mutationFn: () => issueTemporaryPassword(accountId),
    onSuccess: setIssued,
    onError: (error) => Toast.error(error.message),
  })

  const start = async () => {
    if (reset.isPending) return
    const ok = await confirmDialog({
      title: '发临时密码？',
      content: `给 ${label} 一个临时密码，在小程序登录页认领会员用；之前发的作废。已经绑好微信的顾客用不上。`,
      okText: '发临时密码',
    })
    if (ok) reset.mutate()
  }

  return (
    <Card
      title="认领会员"
      headerExtraContent={
        <Button loading={reset.isPending} onClick={() => void start()}>
          发临时密码
        </Button>
      }
    >
      <Typography.Paragraph type="secondary">
        店员代开的会员还没绑微信：顾客在小程序登录页点「店员帮我开过会员，去认领」，填手机号和这里发的临时密码，就能把会员领到自己的微信上。临时密码
        8 位数字，24 小时内有效，认领后作废；按资料里的手机号发。
      </Typography.Paragraph>
      <Modal
        title="临时密码"
        visible={Boolean(issued)}
        onCancel={() => setIssued(null)}
        footer={
          <Button theme="solid" type="primary" onClick={() => setIssued(null)}>
            已告诉顾客
          </Button>
        }
      >
        {issued ? (
          <>
            <Typography.Title heading={2} copyable={{ content: issued.temporaryPassword }} style={{ margin: 0 }}>
              {issued.temporaryPassword}
            </Typography.Title>
            <Descriptions
              style={{ marginTop: 16 }}
              data={[
                { key: '认领手机号', value: issued.phoneMasked },
                { key: '有效到', value: dateTime(issued.expiresAt) },
              ]}
            />
            <Banner
              style={{ marginTop: 16 }}
              type="info"
              closeIcon={null}
              description="请当面告诉顾客：在小程序登录页点「店员帮我开过会员，去认领」，填手机号和这个临时密码。关掉这个窗口后就看不到了，忘了可以再发一次。"
            />
          </>
        ) : null}
      </Modal>
    </Card>
  )
}
