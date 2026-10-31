import { useRef, useState, type PropsWithChildren } from 'react'
import { Image, Input, Picker, Text, View } from '@tarojs/components'
import { Button } from './button'
import { clockTime } from '../services/format'
import Taro, { useRouter } from '@tarojs/taro'
import homeIcon from '../assets/staff/home.png'
import homeActive from '../assets/staff/home-active.png'
import ordersIcon from '../assets/staff/orders.png'
import ordersActive from '../assets/staff/orders-active.png'
import reserveIcon from '../assets/staff/reserve.png'
import reserveActive from '../assets/staff/reserve-active.png'
import tableIcon from '../assets/staff/tables.png'
import tableActive from '../assets/staff/tables-active.png'
import inventoryIcon from '../assets/staff/inventory.png'
import inventoryActive from '../assets/staff/inventory-active.png'
import operationsIcon from '../assets/staff/operations.png'
import operationsActive from '../assets/staff/operations-active.png'
import profileIcon from '../assets/staff/profile.png'
import profileActive from '../assets/staff/profile-active.png'
import navLive from '../assets/staff/nav-live.png'
import navLiveActive from '../assets/staff/nav-live-active.png'
import navTables from '../assets/staff/nav-tables.png'
import navTablesActive from '../assets/staff/nav-tables-active.png'
import navReservations from '../assets/staff/nav-reservations.png'
import navReservationsActive from '../assets/staff/nav-reservations-active.png'
import navMembers from '../assets/staff/nav-members.png'
import navMembersActive from '../assets/staff/nav-members-active.png'
import brandIcon from '../assets/brand/examplebrand-black.png'
import { brandName, brandTagline } from '../brand'
import { activeStaffPage, staffDestinations, staffTabs } from '../services/staff-navigation'
import { AuthBoundary, Screen, Skeleton, Status } from './customer'
import { useBillingEnabled } from '../hooks/billing'
import { useCustomer } from '../hooks/customer'
import { staffMessage } from '../services/staff'
import { useStaffQuery } from '../hooks/query'
import { confirmLeave, navigateApp } from '../services/navigation'
import { staffBadges, useOpenServiceCalls, useStaffOverview } from '../hooks/staff-overview'
import { useNow } from '../hooks/clock'
import '../styles/staff.scss'

export function StaffBoundary({ children }: PropsWithChildren) {
  const auth = useCustomer()
  if (auth.status === 'loading') return <Skeleton />
  if (auth.status !== 'authenticated') return <AuthBoundary />
  if (!auth.account?.roles?.length)
    return (
      <Status
        kind="forbidden"
        title="暂无员工权限"
        message="请联系老板为你的账号分配店员、店长或老板角色。"
        action="返回首页"
        onAction={() => {
          void Taro.switchTab({ url: '/pages/index/index' })
        }}
      />
    )
  return <>{children}</>
}

export function StaffScreen({
  title,
  children,
  loading = false,
  error,
  onRetry,
  stale = false,
  live,
  updatedAt,
}: PropsWithChildren<{
  live?: { connection: string; polling: boolean }
  updatedAt?: number
  title: string
  stale?: boolean
  loading?: boolean
  error?: unknown
  onRetry?: () => void
}>) {
  const { path } = useRouter()
  const auth = useCustomer()
  const authorized = auth.status === 'authenticated' && !!auth.account?.roles.length
  const page = path.split('/staff/')[1]?.split('/')[0] || ''
  const root = staffTabs.includes(page)
  const skeleton = /\/(workbench|tables)\//.test(path) ? 'stats' : /\/(checkout|booking)\//.test(path) ? 'form' : 'list'
  return (
    <Screen
      title={title}
      back
      dark
      className={`staff-screen staff-page-${page} ${authorized ? 'staff-authorized' : ''} ${root ? '' : 'staff-task-screen'}`}
    >
      <StaffBoundary>
        <StaffNav />
        <View className="staff-body">
          {/*
            连接正常时这条只是背景信息：一个圆点加时间就够，不值一整行。
            连接断了才是要读的话——那时才把状态写全。
          */}
          {live && (
            <View className={`resource-freshness ${live.connection === 'connected' ? 'resource-freshness-quiet' : ''}`}>
              <View className="resource-freshness-copy">
                {/* Text 不支持 ariaLabel，所以正常态也要留下能念的字，不能只画个点 */}
                <Text
                  className={`resource-connection ${live.connection === 'connected' ? 'resource-connected' : 'resource-reconnecting'}`}
                >
                  {live.connection === 'connected'
                    ? '实时'
                    : live.polling
                      ? '连接恢复中 · 定时刷新'
                      : '连接恢复中 · 请刷新'}
                </Text>
                {updatedAt && <Text className="resource-updated">{clockTime(updatedAt)}</Text>}
              </View>
              <Button className="text-button" ariaLabel="刷新当前页面数据" onClick={onRetry}>
                刷新
              </Button>
            </View>
          )}
          {loading ? (
            <Skeleton rows={3} variant={skeleton} />
          ) : error && !stale ? (
            <Status kind="error" title="加载失败" message={staffMessage(error)} action="重新加载" onAction={onRetry} />
          ) : (
            <>
              {error && (
                <View className="refresh-notice">
                  <Text className="field-error">刷新失败，当前显示上次读取的内容。操作前请重新加载。</Text>
                  <Button className="text-button" onClick={onRetry}>
                    重新加载
                  </Button>
                </View>
              )}
              {children}
            </>
          )}
        </View>
      </StaffBoundary>
    </Screen>
  )
}

// 员工页读数据与实时连接见 hooks/query.ts；页面从这里一并引入。
export { useStaffEvents, useStaffQuery } from '../hooks/query'

// 电脑侧栏（浅底）用原来的深色线条图标；手机底部四格是深色底，用浅色的一套（nav-*）。
const sidebarIcons: Record<string, [string, string]> = {
  live: [homeIcon, homeActive],
  tables: [tableIcon, tableActive],
  reservations: [reserveIcon, reserveActive],
  members: [profileIcon, profileActive],
  orders: [ordersIcon, ordersActive],
  inventory: [inventoryIcon, inventoryActive],
  operations: [operationsIcon, operationsActive],
}
const tabIcons: Record<string, [string, string]> = {
  live: [navLive, navLiveActive],
  tables: [navTables, navTablesActive],
  reservations: [navReservations, navReservationsActive],
  members: [navMembers, navMembersActive],
}

/**
 * 员工导航（2026-10-20 重做）：手机底部深色四格「现场 / 桌位 / 预约 / 会员」，现场和预约上标待办数；
 * 电脑宽屏是左侧栏，列出全部去处（待结账、收货入库、连电脑也在）。不是微信 tabBar，是员工分包自己画的。
 */
export function StaffNav() {
  const auth = useCustomer()
  const { path } = useRouter()
  const billing = useBillingEnabled()
  const destinations = staffDestinations(auth.account?.roles || [], billing)
  const tabs = destinations.filter((link) => staffTabs.includes(link.page))
  // 待办数和现场页读同一份（同一个查询键），切页不多发请求；实时事件到了一起重读
  const overview = useStaffOverview(billing)
  const calls = useOpenServiceCalls()
  const now = useNow(30000)
  const badges = staffBadges(overview.data, calls.data, now)
  const isCurrent = (page: string) => activeStaffPage(path) === page
  const go = (page: string) => {
    const target = `/pages/staff/${page}/index`
    if (path.replace(/^\//, '') !== target.slice(1))
      void confirmLeave().then((ok) => {
        if (ok) void navigateApp(target, true)
      })
  }
  const badge = (page: string) =>
    badges[page] ? <Text className="staff-nav-badge">{badges[page] > 99 ? '99+' : badges[page]}</Text> : null
  return (
    <>
      <View className="staff-sidebar">
        <View className="staff-sidebar-brand">
          <Image className="staff-sidebar-logo" src={brandIcon} mode="aspectFit" ariaLabel={brandName} />
          <Text className="staff-sidebar-title">{brandTagline}</Text>
          <Text className="staff-sidebar-caption">门店现场</Text>
        </View>
        <View className="staff-sidebar-links">
          {destinations.map((link) => (
            <Button
              key={link.page}
              ariaLabel={`${link.label}${badges[link.page] ? `，${badges[link.page]} 件待办` : ''}${isCurrent(link.page) ? '，当前页面' : ''}`}
              className={`staff-sidebar-item ${isCurrent(link.page) ? 'staff-sidebar-current' : ''}`}
              onClick={() => go(link.page)}
            >
              <Image
                className="staff-nav-icon"
                src={sidebarIcons[link.icon][isCurrent(link.page) ? 1 : 0]}
                mode="aspectFit"
              />
              <Text className="staff-sidebar-label">{link.label}</Text>
              {badge(link.page)}
            </Button>
          ))}
        </View>
        <View className="staff-sidebar-footer">
          <Text className="staff-sidebar-user">{auth.account?.nickname}</Text>
          <Text className="staff-sidebar-caption">
            {auth.account?.roles.map((role) => roleNames[role]).join(' · ')}
          </Text>
          <Button
            className="staff-sidebar-return"
            onClick={() => {
              void navigateApp('/pages/index/index')
            }}
          >
            返回顾客首页
          </Button>
        </View>
      </View>
      <View className="staff-mobile-navigation">
        <View className="staff-nav">
          {tabs.map((link) => (
            <Button
              key={link.page}
              ariaLabel={`${link.label}${badges[link.page] ? `，${badges[link.page]} 件待办` : ''}${isCurrent(link.page) ? '，当前页面' : ''}`}
              className={`staff-nav-item ${isCurrent(link.page) ? 'staff-nav-current' : ''}`}
              onClick={() => go(link.page)}
            >
              <Image
                className="staff-nav-icon"
                mode="aspectFit"
                src={tabIcons[link.icon][isCurrent(link.page) ? 1 : 0]}
              />
              <Text>{link.label}</Text>
              {badge(link.page)}
            </Button>
          ))}
        </View>
      </View>
    </>
  )
}

export const roleNames: Record<string, string> = { clerk: '店员', manager: '店长', owner: '老板' }

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder = '',
  disabled = false,
  className = '',
  error = '',
  help = '',
  required = false,
  focus = false,
  onBlur,
}: {
  className?: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'number' | 'digit'
  placeholder?: string
  disabled?: boolean
  error?: string
  help?: string
  required?: boolean
  focus?: boolean
  onBlur?: () => void
}) {
  const [localError, setLocalError] = useState('')
  const visibleError = error || localError
  const check = () => {
    const input = value.trim()
    setLocalError(
      required && !input
        ? `请填写${label}`
        : input && type === 'digit' && !/^\d+(\.\d{1,2})?$/.test(input)
          ? '请输入非负数，最多两位小数'
          : input && type === 'number' && !/^\d+$/.test(input)
            ? '请输入非负整数'
            : '',
    )
    onBlur?.()
  }
  return (
    <View className={`staff-field ${className}`}>
      <Text className="field-label">
        {label}
        {required ? '（必填）' : ''}
      </Text>
      <Input
        className={`input ${visibleError ? 'input-invalid' : ''}`}
        ariaLabel={`${label}${required ? '，必填' : ''}${visibleError ? `，${visibleError}` : help ? `，${help}` : ''}`}
        cursorSpacing={96}
        focus={focus}
        disabled={disabled}
        type={type}
        value={value}
        placeholder={placeholder}
        onBlur={check}
        onInput={(event) => {
          setLocalError('')
          onChange(event.detail.value)
        }}
      />
      {help && <Text className="field-help">{help}</Text>}
      {visibleError && (
        <View className="field-error" role="alert">
          {visibleError}
        </View>
      )}
    </View>
  )
}

/**
 * 按日期筛的选择框：值是「YYYY-MM-DD」，空串就是不限日期；选了日期时标题旁有「清除日期」回到不限。
 * presets 是选择框下面的快捷日期（如今天、昨天），点一下就选上。
 */
export function DateField({
  label,
  value,
  onChange,
  disabled = false,
  text,
  openAt,
  presets = [],
  start,
  end,
  clearable = true,
  inlinePresets = false,
  help,
  className = '',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** 选了日期时框里写的字（如「10-05 周一 · 昨天」）；不给就写日期本身。 */
  text?: string
  /** 没选日期时选择器打开停在哪天：传门店的今天，不然微信按手机的日期。 */
  openAt?: string
  presets?: { text: string; value: string }[]
  start?: string
  end?: string
  clearable?: boolean
  inlinePresets?: boolean
  help?: string
  className?: string
}) {
  const shown = value ? text || value : '不限日期'
  return (
    <View className={`staff-field ${className}`}>
      <View className="staff-field-heading">
        <Text className="field-label">{label}</Text>
        {value && clearable && (
          <Button disabled={disabled} className="text-button" onClick={() => onChange('')}>
            清除日期
          </Button>
        )}
        {help && <Text className="field-help">{help}</Text>}
      </View>
      <View className={inlinePresets ? 'staff-date-row' : ''}>
        <Picker
          className="staff-date-picker"
          disabled={disabled}
          mode="date"
          value={value || openAt || ''}
          start={start}
          end={end}
          onChange={(event) => onChange(event.detail.value)}
        >
          <View className="staff-picker" ariaLabel={`${label}，${shown}`}>
            {shown}
          </View>
        </Picker>
        {presets.length > 0 && (
          <View className="staff-tabs">
            {presets.map((preset) => (
              <Button
                key={preset.value}
                disabled={disabled}
                className={`staff-tab ${value === preset.value ? 'staff-tab-selected' : ''}`}
                onClick={() => onChange(preset.value)}
              >
                {preset.text}
              </Button>
            ))}
          </View>
        )}
      </View>
    </View>
  )
}

export function Stepper({
  label,
  value,
  onChange,
  disabled = false,
  error = '',
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  unit = '',
  displayOnly = false,
  help,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  error?: string
  min?: number
  max?: number
  unit?: string
  displayOnly?: boolean
  help?: string
}) {
  return (
    <View className="staff-field">
      <View className="staff-stepper-heading">
        <Text className="field-label">{label}</Text>
        {help && <Text className="field-help">{help}</Text>}
      </View>
      <View className="staff-stepper">
        <Button
          className="staff-stepper-button"
          disabled={disabled || Number(value) <= min}
          ariaLabel={`减少${label}`}
          onClick={() => onChange(String(Math.max(min, Number(value) - 1)))}
        >
          {displayOnly ? '−' : '-'}
        </Button>
        {displayOnly ? (
          <Text className="staff-stepper-value">
            {value} {unit}
          </Text>
        ) : (
          <Input
            className={`input ${error ? 'input-invalid' : ''}`}
            ariaLabel={`${label}${error ? `，${error}` : ''}`}
            cursorSpacing={96}
            type="number"
            value={value}
            disabled={disabled}
            onInput={(e) => onChange(e.detail.value)}
          />
        )}
        <Button
          className="staff-stepper-button"
          disabled={disabled || Number(value) >= max}
          ariaLabel={`增加${label}`}
          onClick={() => onChange(String(Math.min(max, (Number(value) || 0) + 1)))}
        >
          +
        </Button>
      </View>
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </View>
  )
}

export function ActionButton({
  children,
  onClick,
  disabled = false,
  loading = false,
  loadingText = '正在处理',
  variant = 'primary',
}: PropsWithChildren<{
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  loadingText?: string
  variant?: 'primary' | 'outline' | 'danger'
}>) {
  return (
    <Button
      loading={loading}
      disabled={disabled || loading || undefined}
      className={`button button-${variant === 'primary' ? 'teal' : variant}${disabled || loading ? ' button-disabled' : ''}`}
      onClick={disabled || loading ? undefined : onClick}
    >
      {loading ? loadingText : children}
    </Button>
  )
}

let closureQueries = 0

/**
 * 按闭包读取、没有资源键的旧写法：每个调用处一个独立的查询，`refresh()` 按当时的闭包重读。
 * 只留给电脑登录页（扫到哪个编号就读哪个，编号在页面状态里）；新代码用带资源键的 useStaffQuery。
 * 其余行为与 useStaffQuery 相同：页面显示时读、身份变了旧内容立即不显示、无权时不留内容。
 */
export function useStaffData<T>(load: () => Promise<T>) {
  const [instance] = useState(() => ++closureQueries)
  const latest = useRef(load)
  latest.current = load
  return useStaffQuery(['closure', instance], () => latest.current())
}
