import { Image, Text, View } from '@tarojs/components'
import { Button } from '../../components/button'
import Taro from '@tarojs/taro'
import { AuthBoundary, RefreshNotice, Screen, Skeleton } from '../../components/customer'
import { AccountAvatar } from '../../components/customer/avatar'
import { chooseStoreContact } from '../../components/customer/store-contact'
import { useBillingEnabled, useOrdersTabText } from '../../hooks/billing'
import { useCustomerQuery, usePublicQuery } from '../../hooks/query'
import { customer, openPrivacy } from '../../services/platform'
import { errorMessage } from '../../services/customer'
import { DesignIcon } from '../../components/customer/design-icon'
import { memberDay } from '../../services/member-entry'
import { clockTime } from '../../services/format'
import { LedgerIcon } from '../../components/customer/ledger-icon'
import { messages, messagePreview } from '../../services/messages'
import { moneyText } from '../../services/format'
import { loyalty } from '../../services/membership'
import { reservations } from '../../services/reservations'
import { nextReservation, storefront } from '../../services/storefront'
import businessIcon from '../../assets/staff/business-active.png'
import './index.scss'
import { nativeColors } from '../../theme'
import { brandName, membershipName } from '../../brand'
import { appVersion } from '../../version'

const roles = { clerk: '店员', manager: '店长', owner: '老板' }

/**
 * 我的（2026-10-20 重做，画稿 CProfile）：深色头部（头像、昵称、等级，点进编辑资料）；「示例工坊社」「我的预约」两格，
 * 我的预约写下一场；员工多一行工作台；手机号、联系门店（电话、微信、导航，用首页那份门店信息）、隐私协议；退出登录放最下。
 * 「本次手作」「预约座位」首页就有，这里不再重复。
 */
export default function Profile() {
  const resource = useCustomerQuery(['account'], customer.refreshAccount)
  const account = resource.data
  // 会员等级、积分和下一场预约：和示例工坊社、我的预约同一个查询，读不到时这两格只是少写一句
  const member = useCustomerQuery(['loyalty'], loyalty.me)
  const feed = useCustomerQuery(['messages-preview'], messages.preview, { live: true })
  const mine = useCustomerQuery(['reservations'], reservations.me)
  const home = usePublicQuery(['storefront'], storefront.home)
  // 系统内收费关着时底部第三格就是我的预约：「我的预约」格切过去；开着时第三格是订单，这一格进我的预约页
  const billing = useBillingEnabled()
  useOrdersTabText()
  const editProfile = () => {
    void Taro.navigateTo({ url: '/pages/customer/profile-edit/index' })
  }
  const openReservations = () => {
    if (billing) void Taro.navigateTo({ url: '/pages/customer/my-reservations/index' })
    else void Taro.switchTab({ url: '/pages/orders/index' })
  }
  const retry = () => {
    void resource.refresh()
  }
  const next = mine.data ? nextReservation(mine.data.reservations) : null
  const contact = home.data?.contact
  const reachable = !!contact && (!!contact.phone || !!contact.wechat || contact.latitude !== null)
  const tier = member.data?.balance.tierName || '普通会员'
  return (
    <Screen navigationHeight={44} title="我的" dark className="profile-screen">
      <AuthBoundary>
        {!!resource.error && resource.data !== null && <RefreshNotice retry={retry} />}
        {/*
          ★ 只有**依赖 account 的区块**降级，页面骨架永远在。不要退回成整屏 Failure。
            原来的结构是「加载中 / 整屏 Failure / account && 全部内容」三选一，有个死锁：
            账户接口一挂，**「退出登录」也一起消失** —— 而账户数据出问题时重新登录恰恰是
            用户唯一的自救手段。同时消失的还有隐私协议（微信要求可达的合规入口）和
            纯导航入口，它们根本不需要 account。
            而且 account 为 null 又没有 error 时（三个分支全不命中），整页是**空白**的。
            另外这是 tab 页，底部 tab 栏就在那儿，整屏 Failure 却给一个「返回首页」按钮，
            信息架构上矛盾。现在与首页的分区降级策略一致。
        */}
        <View className="profile-top">
          {resource.loading ? (
            <Skeleton rows={2} variant="profile" />
          ) : !account ? (
            <View className="profile-header-failed">
              <Text className="profile-header-failed-text">{errorMessage(resource.error)}</Text>
              <Button className="profile-retry" onClick={retry}>
                重试
              </Button>
            </View>
          ) : (
            <Button className="profile-header" ariaLabel={`${account.nickname}，编辑资料`} onClick={editProfile}>
              <AccountAvatar value={account.avatarDataUrl} className="profile-avatar" />
              <View className="profile-identity">
                <Text className="profile-name">{account.nickname}</Text>
                <View className="profile-role">
                  <Text className="profile-tier">{tier}</Text>
                  <Text className="profile-edit-link">编辑资料</Text>
                </View>
              </View>
              <DesignIcon name="right" className="profile-chevron" />
            </Button>
          )}
        </View>
        {/* ★ 以下都是纯导航与合规入口，不依赖 account，任何情况下都要在。 */}
        <View className="profile-service-grid">
          <Button
            className="profile-service"
            onClick={() => {
              void Taro.navigateTo({ url: '/pages/customer/membership/index' })
            }}
          >
            <DesignIcon name="member" className="profile-service-icon" />
            <Text className="profile-service-title">{membershipName}</Text>

            {member.data ? (
              <View className="profile-service-note profile-member-note">
                <Text className="profile-member-balance">
                  余额{' '}
                  <Text className="strong">
                    ¥{moneyText(member.data.balance.principalCents + member.data.balance.giftCents)}
                  </Text>
                </Text>
                <Text>
                  豆板 {member.data.balance.boardUses} 次 · 积分 {member.data.balance.points}
                </Text>
              </View>
            ) : (
              <Text className="profile-service-note">余额 · 豆板 · 积分</Text>
            )}
          </Button>
          <Button className="profile-service" onClick={openReservations}>
            <DesignIcon name="calendar" className="profile-service-icon" />
            <Text className="profile-service-title">我的预约</Text>
            <View className="profile-service-note profile-reservation-note">
              {next ? (
                <>
                  <Text>
                    {memberDay(next.reservation.startAt, false)} {clockTime(next.reservation.startAt).slice(0, 5)}
                  </Text>
                  <Text>
                    {mine.data?.tables.find((t) => t.id === next.reservation.serviceTableId)?.code || next.tableNumber}{' '}
                    号桌
                  </Text>
                </>
              ) : (
                <Text>还没有要来的预约</Text>
              )}
            </View>
          </Button>
        </View>
        {!!account?.roles.length && (
          <Button
            className="profile-workbench"
            onClick={() => {
              void Taro.redirectTo({ url: '/pages/staff/workbench/index' })
            }}
          >
            <Image className="profile-row-icon" src={businessIcon} />
            <View className="profile-workbench-copy">
              <Text className="profile-workbench-title">
                {account.roles.map((role) => roles[role]).join(' · ')}工作台
              </Text>
              <Text className="profile-workbench-note">只有员工看得到这一行</Text>
            </View>
            <DesignIcon name="right" className="profile-chevron" />
          </Button>
        )}
        <View className="profile-list">
          <Button
            className="profile-link profile-message-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/customer/messages/index' })}
          >
            <LedgerIcon kind="bell-muted" />
            <Text className="profile-row-label">消息</Text>
            <View className="profile-message-summary">
              <Text className="profile-message-preview">
                {feed.error && !feed.data ? '暂时无法读取' : messagePreview(feed.data?.items[0])}
              </Text>
              {!!feed.data?.unreadCount && (
                <View className="profile-message-count" ariaLabel={`${feed.data.unreadCount} 条未读`}>
                  {feed.data.unreadCount > 99 ? '99+' : feed.data.unreadCount}
                </View>
              )}
            </View>
            <DesignIcon name="right" className="profile-chevron" />
          </Button>
          <View className="profile-link">
            <DesignIcon name="phone" className="profile-row-icon" />
            <Text className="profile-row-label">手机号</Text>
            {/* ★ account 缺失时给占位，不要整行消失。★ 只渲染 phoneMasked，完整号码永远不进 UI。 */}
            {account ? (
              <View className="profile-phone-value">
                <Text className="profile-phone-number">{account.phoneMasked || '未填写'}</Text>
                {/* 「未验证」点它就去编辑资料，那边有微信一键取号。已验证的没什么可做，保持纯文字。 */}
                {account.phoneVerificationStatus === 'verified' ? (
                  <Text className="profile-phone-status profile-phone-verified">已验证</Text>
                ) : (
                  <Button
                    className="profile-phone-status profile-phone-unverified"
                    ariaLabel="手机号未验证，去验证"
                    onClick={editProfile}
                  >
                    未验证 · 去验证
                  </Button>
                )}
              </View>
            ) : (
              <Text className="profile-phone-placeholder">暂时无法读取</Text>
            )}
          </View>
          {reachable && contact && (
            <Button className="profile-link" onClick={() => chooseStoreContact(contact)}>
              <DesignIcon name="location" className="profile-row-icon" />
              <Text className="profile-row-label">联系门店</Text>
              <Text className="profile-row-value">
                {[contact.phone && '电话', contact.wechat && '微信', contact.latitude !== null && '导航']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <DesignIcon name="right" className="profile-chevron" />
            </Button>
          )}
          <Button className="profile-link" onClick={openPrivacy}>
            <DesignIcon name="privacy" className="profile-row-icon" />
            <Text className="profile-row-label">隐私协议</Text>
            <DesignIcon name="right" className="profile-chevron" />
          </Button>
        </View>
        <View className="profile-actions">
          <Button
            className="profile-signout"
            onClick={() => {
              void Taro.showModal({
                title: '退出登录',
                content: '退出后将清除本机登录信息，再次查看预约和会员需要重新登录。',
                confirmText: '退出登录',
                confirmColor: nativeColors.danger,
              })
                .then((result) => {
                  if (result.confirm) customer.logOut()
                })
                .catch(() => {
                  /* 弹窗未能显示时保持登录状态 */
                })
            }}
          >
            退出登录
          </Button>
          {/* 版本号：排查「我这是不是新版」应当是一眼的事，不该靠猜 */}
          <Text className="profile-version">
            {brandName} · 版本 {appVersion}
          </Text>
        </View>
      </AuthBoundary>
    </Screen>
  )
}
