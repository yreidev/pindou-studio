import { Card, Descriptions, Tag, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useCurrentAccount } from '../../account'
import { getHealth, getMiniappVersion } from '../../api/auth'
import { useBillingEnabled } from '../../api/billing'
import { visibleNavItems } from '../../nav'
import { useRealtime } from '../../realtime/RealtimeProvider'
import { roleNames } from '../../session'
import { clockTime, dateTime } from '../../lib/format'

export const Route = createFileRoute('/_authed/')({
  component: HomePage,
})

function HomePage() {
  const user = useCurrentAccount()
  const { status, connectedAt } = useRealtime()
  const health = useQuery({ queryKey: ['healthz'], queryFn: getHealth, staleTime: 60_000 })
  const miniapp = useQuery({ queryKey: ['miniapp-version'], queryFn: getMiniappVersion })
  const roles = user.roles.filter((role) => role in roleNames).map((role) => roleNames[role])
  const billing = useBillingEnabled()
  const shortcuts = visibleNavItems(user, billing).filter((item) => item.to !== '/')

  return (
    <div className="page">
      <Typography.Title heading={3} style={{ marginBottom: 8 }}>
        你好，{user.nickname}
      </Typography.Title>
      <Typography.Paragraph type="tertiary">
        {roles.length ? `当前身份：${roles.join('、')}。` : '当前没有员工身份。'}
        {billing
          ? '柜台电脑可常开「现场」看板：点空座位开台，处理呼叫、扫码入座、到店开台、换桌和计时；预约登记、会员充值兑换和结账两边都能办，这里还能打印小票。'
          : '柜台电脑可常开「现场」看板：点空座位开台，处理呼叫、扫码入座、到店开台、换桌和计时，用完点「结束」放座；预约登记、会员储值和积分两边都能办。现在系统内不收费，钱在美团、大众点评收。'}
      </Typography.Paragraph>

      <div className="card-grid">
        {shortcuts.map((item) => (
          <Link key={item.to} to={item.to} className="shortcut-link">
            {/* 图标、标题、说明用 Card.Meta 排，不自己拼 */}
            <Card shadows="hover" className="shortcut-card">
              <Card.Meta avatar={item.icon} title={item.text} description={item.summary} />
            </Card>
          </Link>
        ))}
        <Card title="系统状态">
          <Descriptions
            data={[
              {
                key: '实时同步',
                value:
                  status === 'open' ? (
                    <Tag color="green">已连接</Tag>
                  ) : (
                    <Tag color={status === 'connecting' ? 'grey' : 'red'}>
                      {status === 'connecting' ? '正在连接' : '已断开'}
                    </Tag>
                  ),
              },
              { key: '最近连上', value: connectedAt ? clockTime(connectedAt) : '—' },
              {
                // 网页后台和后端分开部署、各自发版（docs/plan-split-release.md）：这一行是构建时写进页面的
                key: '网页后台版本',
                value: (
                  <span>
                    {__ADMIN_VERSION__} <Typography.Text code>{__ADMIN_COMMIT__.slice(0, 7)}</Typography.Text>
                  </span>
                ),
              },
              {
                key: '后端版本',
                value: health.data ? (
                  <span>
                    {health.data.version} <Typography.Text code>{health.data.commit.slice(0, 7)}</Typography.Text>
                  </span>
                ) : health.isError ? (
                  '读取失败'
                ) : (
                  '读取中…'
                ),
              },
              {
                key: '小程序正式版（最近使用）',
                value: miniapp.isError ? (
                  '读取失败'
                ) : miniapp.data ? (
                  miniapp.data.release ? (
                    <span>
                      {miniapp.data.release.version}
                      <Typography.Text type="tertiary" style={{ marginLeft: 8 }}>
                        {dateTime(miniapp.data.release.reportedAt)} 上报
                      </Typography.Text>
                    </span>
                  ) : (
                    '尚未收到'
                  )
                ) : (
                  '读取中…'
                ),
              },
            ]}
          />
          <Typography.Paragraph type="tertiary" style={{ marginBottom: 0 }}>
            小程序版本来自员工手机上报，手机可能尚未更新。
          </Typography.Paragraph>
        </Card>
      </div>
    </div>
  )
}
