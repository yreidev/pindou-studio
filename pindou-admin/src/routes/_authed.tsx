import { Avatar, Button, Dropdown, Empty, Layout, Nav, SideSheet, Space, Tag, Typography } from '@douyinfe/semi-ui'
import { IconBell, IconExit, IconMenu, IconRefresh } from '@douyinfe/semi-icons'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useLocation, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { accountQuery } from '../api/accounts'
import { logoutCurrentSession } from '../api/auth'
import { useBillingEnabled } from '../api/billing'
import mark from '../assets/examplebrand-mark.png'
import { CallAlertsProvider, useCallAlerts } from '../features/service-calls/CallAlerts'
import { phoneQuery, useMediaQuery } from '../lib/useMediaQuery'
import { activeNavKey, visibleNavItems } from '../nav'
import { RealtimeProvider, useRealtime } from '../realtime/RealtimeProvider'
import { clearSession, isStaff, loadSession, roleNames, type Account } from '../session'

export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ location }) => {
    const session = loadSession()
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } })
    return { session }
  },
  component: AuthedLayout,
})

// 角色标记用 Semi 自带的标签色：店员绿、店长蓝、老板琥珀，始终带角色名。
const roleColors = { clerk: 'green', manager: 'blue', owner: 'amber' } as const

// 平板竖屏等窄屏默认收起侧栏，只留图标；可以手动展开。手机宽度改成顶栏菜单按钮 + 抽屉。
function startsCollapsed(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches
}

function AuthedLayout() {
  const { session } = Route.useRouteContext()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState(startsCollapsed)
  const phone = useMediaQuery(phoneQuery)
  const [menuOpen, setMenuOpen] = useState(false)

  // 角色以接口为准：登录后可能被任命或撤销，本地存的只是登录那一刻的样子。
  // 会话失效时这个请求返回 401，接口客户端会清掉会话并跳回登录页。
  const account = useQuery(accountQuery(session.user.id))
  const user: Account = account.data ?? session.user
  const verifySession = useCallback(
    () => queryClient.fetchQuery({ ...accountQuery(session.user.id), staleTime: 0 }),
    [queryClient, session.user.id],
  )
  const openBoard = useCallback(() => void navigate({ to: '/board' }), [navigate])

  const logout = async () => {
    try {
      await logoutCurrentSession()
    } catch {
      // 网络失败也要在本机退出；服务端会话到期自然失效
    }
    clearSession()
    // 先离开后台页面再清缓存，否则还挂着的查询会立刻不带令牌重读一次
    await navigate({ to: '/login', replace: true })
    queryClient.clear()
  }

  if (!isStaff(user)) {
    // 没有员工身份就不连实时、不显示后台框架
    return <NoStaffRole onLogout={logout} />
  }

  return (
    // 换了人（别的标签页重新登录）就重建实时连接，不沿用上一个人的令牌。
    <RealtimeProvider key={`${session.user.id}:${session.expiresAt}`} beforeReconnect={verifySession}>
      {/* 呼叫店员的提醒挂在这里：停在哪一页都提醒，见 features/service-calls/CallAlerts.tsx */}
      <CallAlertsProvider onBoard={location.pathname === '/board'} onOpenBoard={openBoard}>
        <Layout style={{ height: '100vh' }}>
          {phone ? null : (
            <Layout.Sider style={{ backgroundColor: 'var(--semi-color-bg-1)' }}>
              <SideNav user={user} collapsed={collapsed} onCollapseChange={setCollapsed} />
            </Layout.Sider>
          )}
          <Layout>
            <Layout.Header className="admin-header" style={{ backgroundColor: 'var(--semi-color-bg-1)' }}>
              {phone ? (
                <div className="admin-header-phone">
                  <Button
                    theme="borderless"
                    type="tertiary"
                    icon={<IconMenu />}
                    aria-label="打开菜单"
                    onClick={() => setMenuOpen(true)}
                  />
                  <img className="admin-header-mark" src={mark} alt="" />
                  <span className="admin-header-spacer" />
                  <RealtimeIndicator compact />
                  <AccountMenu user={user} onLogout={logout} compact />
                </div>
              ) : (
                <Nav
                  mode="horizontal"
                  footer={
                    <Space spacing="loose">
                      <RealtimeIndicator />
                      <AccountMenu user={user} onLogout={logout} />
                    </Space>
                  }
                />
              )}
            </Layout.Header>
            <Layout.Content
              className="admin-content"
              style={{ padding: phone ? 12 : 24, backgroundColor: 'var(--semi-color-bg-0)', overflow: 'auto' }}
            >
              <Outlet />
            </Layout.Content>
          </Layout>
        </Layout>
        {phone ? (
          <SideSheet
            visible={menuOpen}
            placement="left"
            width={260}
            title={null}
            closable={false}
            bodyStyle={{ padding: 0 }}
            onCancel={() => setMenuOpen(false)}
          >
            <SideNav user={user} onSelect={() => setMenuOpen(false)} />
          </SideSheet>
        ) : null}
      </CallAlertsProvider>
    </RealtimeProvider>
  )
}

/** 侧栏导航：电脑、平板放在左侧；手机放在抽屉里，选中后关上抽屉。 */
function SideNav({
  user,
  collapsed,
  onCollapseChange,
  onSelect,
}: {
  user: Account
  collapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  onSelect?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const billing = useBillingEnabled()
  return (
    <Nav
      className="admin-nav"
      style={{ height: '100%' }}
      selectedKeys={[activeNavKey(location.pathname)]}
      items={visibleNavItems(user, billing).map((item) => ({ itemKey: item.to, text: item.text, icon: item.icon }))}
      onSelect={({ itemKey }) => {
        onSelect?.()
        void navigate({ to: String(itemKey) })
      }}
      isCollapsed={collapsed}
      onCollapseChange={onCollapseChange}
      header={{ logo: <img src={mark} alt="" />, text: '示例工坊后台' }}
      footer={onCollapseChange ? { collapseButton: true } : undefined}
    />
  )
}

/** 实时连接状态。手机上只留短标签和刷新图标，免得把顶栏挤折行。 */
function RealtimeIndicator({ compact = false }: { compact?: boolean }) {
  const { status, connectedAt } = useRealtime()
  const queryClient = useQueryClient()
  if (status === 'open') {
    const since = connectedAt
      ? `连上于 ${connectedAt.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
      : undefined
    return (
      <span title={since}>
        <Tag color="green">{compact ? '已连接' : '实时 · 已连接'}</Tag>
      </span>
    )
  }
  return (
    <span className="realtime-offline">
      <Tag color={status === 'connecting' ? 'grey' : 'red'}>
        {compact
          ? status === 'connecting'
            ? '连接中'
            : '重连中'
          : status === 'connecting'
            ? '实时 · 正在连接'
            : '实时 · 已断开，正在重连'}
      </Tag>
      <Button
        size="small"
        icon={<IconRefresh />}
        aria-label="立即刷新"
        onClick={() => void queryClient.invalidateQueries()}
      >
        {compact ? null : '立即刷新'}
      </Button>
    </span>
  )
}

/** 账户菜单：提醒设置（这台电脑的提示音、系统通知）和退出登录。手机上不显示昵称（放进菜单里），只留头像和角色。 */
function AccountMenu({ user, onLogout, compact = false }: { user: Account; onLogout: () => void; compact?: boolean }) {
  const roles = user.roles.filter((role): role is keyof typeof roleColors => role in roleColors)
  const alerts = useCallAlerts()
  return (
    <Dropdown
      trigger="click"
      clickToHide
      position="bottomRight"
      render={
        <Dropdown.Menu>
          {compact ? <Dropdown.Title>{user.nickname}</Dropdown.Title> : null}
          {alerts ? (
            <>
              <Dropdown.Item icon={<IconBell />} onClick={alerts.openSettings}>
                提醒设置
              </Dropdown.Item>
              <Dropdown.Divider />
            </>
          ) : null}
          <Dropdown.Item icon={<IconExit />} onClick={onLogout}>
            退出登录
          </Dropdown.Item>
        </Dropdown.Menu>
      }
    >
      <button type="button" className="account-trigger" aria-label={`账户：${user.nickname}`}>
        <Avatar size="small" src={user.avatarDataUrl}>
          {user.nickname.slice(0, 1)}
        </Avatar>
        {compact ? null : <Typography.Text className="account-name">{user.nickname}</Typography.Text>}
        {roles.map((role) => (
          <Tag key={role} color={roleColors[role]}>
            {roleNames[role]}
          </Tag>
        ))}
      </button>
    </Dropdown>
  )
}

function NoStaffRole({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="page-center">
      <Empty
        title="当前身份没有员工权限"
        description="网页后台只供员工使用。如果你是开发者，请先在小程序里切换体验身份，再重新扫码登录。"
      >
        <Button onClick={onLogout}>退出登录</Button>
      </Empty>
    </div>
  )
}
