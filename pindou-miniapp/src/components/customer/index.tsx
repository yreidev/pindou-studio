import { useEffect, useState, type CSSProperties, type PropsWithChildren } from 'react'
import { Image, Text, View } from '@tarojs/components'
import { Button } from '../button'
import Taro, { useRouter } from '@tarojs/taro'
import { useCustomer } from '../../hooks/customer'
import { beginLogin, returnToPreviousPage } from '../../services/navigation'
import { CustomerError, errorMessage, type Order } from '../../services/customer'
import { dateTime, moneyText, orderAmount, orderLabels, orderTitle } from '../../services/format'
import { assets } from './assets'
import { brandName, brandTagline } from '../../brand'
import draftStatus from '../../assets/staff/orders-active.png'
import paidStatus from '../../assets/staff/paid-active.png'
import { DeveloperStatus } from '../developer-status'
import { DesignIcon } from './design-icon'
import { MessageBadge } from './message-badge'

/** 自定义导航栏的位置：top 是状态栏高度，height 是导航内容的高度（和右上角胶囊对齐）。 */
export function navbarMetrics() {
  try {
    const info = Taro.getWindowInfo()
    const capsule = Taro.getMenuButtonBoundingClientRect()
    const status = info.statusBarHeight ?? 20
    if (!capsule.height || capsule.top < status) return { top: status, height: 48 }
    return { top: status, height: Math.max(48, (capsule.top - status) * 2 + capsule.height) }
  } catch {
    return { top: 20, height: 48 }
  }
}

/** 导航栏连状态栏一共多高；品牌头（brand）至少 60。首页按它算一屏还剩多少。 */
export function navbarHeight(brand: boolean, metrics = navbarMetrics()) {
  return metrics.top + (brand ? Math.max(60, metrics.height) : metrics.height)
}

export function Screen({
  title,
  brand = false,
  brandLogo = assets.logo,
  back = false,
  dark = false,
  className = '',
  onTitle,
  navigationHeight,
  children,
}: PropsWithChildren<{
  title?: string
  brand?: boolean
  brandLogo?: string
  back?: boolean
  /** 深色顶栏（员工页、登录页）：返回箭头换成浅色的。顶栏的底色由页面的样式给。 */
  dark?: boolean
  className?: string
  /** 标题能点（做图纸：标题是图纸名字，点了改名）。标题是顾客自己起的字，不用品牌字体，一行放不下省略。 */
  onTitle?: () => void
  /** 顾客设计稿的标题栏高，设备状态栏仍由微信提供。 */
  navigationHeight?: number
}>) {
  const [metrics, setMetrics] = useState(navbarMetrics)
  useEffect(() => {
    const resize = () => setMetrics(navbarMetrics())
    Taro.onWindowResize(resize)
    return () => Taro.offWindowResize(resize)
  }, [])
  // 状态栏的字跟着顶栏换色：深色顶栏白字，浅色顶栏黑字（同一页里会换，比如登录和创建账号）
  useEffect(() => {
    void Taro.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#22211d' : '#f7f5f0',
    })
  }, [dark])
  const contentHeight = navigationHeight ?? (brand ? Math.max(60, metrics.height) : metrics.height)
  return (
    <View
      className={`screen ${dark ? 'screen-dark' : ''} ${className}`}
      style={{ '--customer-navigation-height': `${metrics.top + contentHeight}px` } as CSSProperties}
    >
      <View className="navbar" style={{ paddingTop: `${metrics.top}px` }}>
        <View className="navbar-content" style={{ minHeight: `${contentHeight}px` }}>
          {back && (
            <Button
              className="icon-button navbar-back"
              ariaLabel="返回"
              onClick={() => {
                void returnToPreviousPage()
              }}
            >
              {navigationHeight === 44 ? (
                <DesignIcon name={dark ? 'back-light' : 'back'} className="back-image" />
              ) : (
                <Image src={dark ? assets.backLight : assets.back} className="back-image" mode="aspectFit" />
              )}
            </Button>
          )}
          {brand ? (
            <View className="brand">
              <Image src={brandLogo} className="brand-logo" mode="aspectFit" ariaLabel={brandName} />
              <Text className="brand-slogan">{brandTagline}</Text>
            </View>
          ) : onTitle ? (
            <Button className="navbar-title navbar-title-action" ariaLabel={`${title}，改名`} onClick={onTitle}>
              <Text className="navbar-title-text">{title}</Text>
              <Text className="navbar-title-mark">✎</Text>
            </Button>
          ) : (
            <Text className="navbar-title">{title}</Text>
          )}
        </View>
      </View>
      <View className="page-content">
        <DeveloperStatus />
        <MessageBadge />
        {children}
      </View>
    </View>
  )
}

export function Skeleton({
  rows = 3,
  variant = 'list',
}: {
  rows?: number
  variant?: 'list' | 'stats' | 'form' | 'profile'
}) {
  if (variant === 'stats')
    return (
      <View className="staff-grid skeleton-stats" ariaLabel="正在加载">
        {Array.from({ length: 4 }, (_, index) => (
          <View className="staff-card" key={index}>
            <View className="skeleton-line skeleton-line-medium" />
            <View className="skeleton-number" />
          </View>
        ))}
      </View>
    )
  if (variant === 'form')
    return (
      <View className="skeleton-form" ariaLabel="正在加载">
        {Array.from({ length: rows }, (_, index) => (
          <View className="field" key={index}>
            <View className="skeleton-line skeleton-line-short" />
            <View className="skeleton-input" />
          </View>
        ))}
      </View>
    )
  return (
    <View className="skeleton-list" ariaLabel="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <View className="skeleton-row" key={index}>
          {variant === 'profile' && <View className="skeleton-image skeleton-avatar" />}
          <View className="skeleton-copy">
            <View className="skeleton-line" />
            <View className="skeleton-line skeleton-line-medium" />
            <View className="skeleton-line skeleton-line-short" />
          </View>
        </View>
      ))}
      <Text className="loading-label">正在加载</Text>
    </View>
  )
}

export function Status({
  kind = 'error',
  title,
  message,
  action,
  onAction,
}: {
  kind?: 'error' | 'empty' | 'forbidden'
  title: string
  message?: string
  action?: string
  onAction?: () => void
}) {
  return (
    <View className="status-view">
      <Image className="status-image" src={assets[kind]} mode="aspectFit" />
      <Text className="status-title">{title}</Text>
      {message && <Text className="muted status-message">{message}</Text>}
      {action && (
        <Button className={`button ${kind === 'empty' ? 'button-outline' : 'button-primary'}`} onClick={onAction}>
          {action}
        </Button>
      )}
    </View>
  )
}

// 分区级空态：用在页面里的某个分区（会员权益、资产明细、近期订单等）。
// 整页空态用 Status——它带 48PX 上下留白和居中大按钮，放进分区里会压垮版式。
export function SectionEmpty({ title, message }: { title: string; message?: string }) {
  return (
    <View className="section-empty">
      <Text className="strong">{title}</Text>
      {message && <Text className="muted">{message}</Text>}
    </View>
  )
}

export function RefreshNotice({ retry }: { retry: () => void }) {
  return (
    <View className="refresh-notice">
      <Text className="field-error">刷新失败，当前显示上次读取的内容。</Text>
      <Button className="text-button" onClick={retry}>
        重新加载
      </Button>
    </View>
  )
}

export function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  const forbidden = error instanceof CustomerError && (error.status === 403 || error.status === 404)
  // 看不了的内容多半是从列表点进来的，退回列表比甩回首页少走一步；没有上一页才回首页。
  let canBack = false
  try {
    canBack = Taro.getCurrentPages().length > 1
  } catch {
    /* 非小程序环境（单测）没有页面栈 */
  }
  return (
    <Status
      kind={forbidden ? 'forbidden' : 'error'}
      title={forbidden ? '暂时无法查看' : '加载失败'}
      message={errorMessage(error)}
      action={forbidden ? (canBack ? '返回上一页' : '返回首页') : '重新加载'}
      onAction={
        forbidden
          ? () => {
              void returnToPreviousPage(true)
            }
          : retry
      }
    />
  )
}

export function AuthBoundary({ children }: PropsWithChildren) {
  const auth = useCustomer()
  const { path, params } = useRouter()
  const login = () => {
    void beginLogin(
      '/' +
        path.replace(/^\//, '') +
        '?' +
        Object.entries(params)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&'),
    )
  }
  if (auth.status === 'loading') return <Skeleton />
  if (auth.status === 'error')
    return <Status title="需要重新登录" message={auth.error} action="登录或注册" onAction={login} />
  // 预约座位可能是朋友转来的（带着时段）：说清楚登录是为了约座，登录完回到同一个时段
  const booking = path.includes('/customer/reservations/')
  if (auth.status !== 'authenticated')
    return (
      <Status
        kind="empty"
        title={
          path.includes('/staff/')
            ? '登录员工账号'
            : booking
              ? '登录后预约座位'
              : path.includes('/orders/') || path.includes('/order-detail/')
                ? '登录后查看订单'
                : '登录后管理个人资料'
        }
        message={booking ? '登录后就能看哪些座位空着、提交预约。' : '登录后可查看本人资料和门店关联的订单。'}
        action="登录或注册"
        onAction={login}
      />
    )
  return <>{children}</>
}

export function OrderBadge({ status }: { status: Order['status'] }) {
  return <Text className={`badge badge-${status}`}>{orderLabels[status]}</Text>
}

export function OrderStatusIcon({ status }: { status: Order['status'] }) {
  return (
    <Image
      src={
        status === 'draft' || status === 'partially_paid' ? draftStatus : status === 'paid' ? paidStatus : assets.record
      }
      className="order-status-icon"
      mode="aspectFit"
    />
  )
}

export function OrderCard({ order }: { order: Order }) {
  // 免单结清的单没收钱：写明免单，实付 0 照接口显示；部分付款写已付和还差多少
  const shown = orderAmount(order)
  const amountLabel = shown.label
  const amount = moneyText(shown.cents)
  return (
    <Button
      className={`order-card order-card-${order.status} enter`}
      onClick={() => {
        void Taro.navigateTo({ url: `/pages/customer/order-detail/index?id=${encodeURIComponent(order.id)}` })
      }}
      ariaLabel={`查看${orderTitle(order)}订单，${orderLabels[order.status]}，${amountLabel}${amount}元${order.createdAt ? `，${dateTime(order.createdAt)}` : ''}`}
    >
      <View className="row order-heading">
        <OrderStatusIcon status={order.status} />
        <Text className="grow strong">{orderTitle(order)}</Text>
        <OrderBadge status={order.status} />
      </View>
      {order.createdAt && <Text className="muted order-time">{dateTime(order.createdAt)}</Text>}
      <View className="order-lines">
        {(order.lines || []).slice(0, 3).map((line, index) => (
          <View className="row" key={index}>
            <Text className="grow">{line.name || '消费项目'}</Text>
            <Text className="muted">×{line.quantity}</Text>
          </View>
        ))}
      </View>
      <View className="row order-footer">
        <Text className="muted">{amountLabel}</Text>
        <Text className="money grow align-right">¥{amount}</Text>
        <Text className="chevron">›</Text>
      </View>
    </Button>
  )
}
