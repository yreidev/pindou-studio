import { useRef, useState } from 'react'
import { Checkbox, CheckboxGroup, Input, Label, Text, View } from '@tarojs/components'
import { useRouter, useUnload } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { Failure, Screen, Skeleton } from '../../../components/customer'
import { DesignIcon } from '../../../components/customer/design-icon'
import { WechatPrivacy } from '../../../components/customer/wechat-privacy'
import { useCustomer } from '../../../hooks/customer'
import { useCustomerQuery } from '../../../hooks/query'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { CustomerError, errorMessage, isCancelled, loginPhoneIsValid } from '../../../services/customer'
import { clearLoginTarget, navigateApp } from '../../../services/navigation'
import { authorizePrivacy, customer, openPrivacy, privacyVersion } from '../../../services/platform'
import { loyalty } from '../../../services/membership'
import { moneyText } from '../../../services/format'
import { memberClaimTitle, memberWelcome, membershipName } from '../../../brand'
import { nativeColors } from '../../../theme'
import './index.scss'

/** 店员代开或以前在顾客网页（2026-10-31 已下线）注册的账户，用密码核对后绑定当前微信，成功留在欢迎页。 */
export default function MemberClaim() {
  const { params } = useRouter()
  const { account } = useCustomer()
  const [phone, setPhone] = useState(params.phone || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [claimed, setClaimed] = useState(false)
  const [error, setError] = useState('')
  const resource = useCustomerQuery(['loyalty'], loyalty.me, { enabled: claimed })
  const member = resource.data
  const history = member?.entries.filter((entry) => entry.kind !== 'consume_reverse').length ?? 0
  const pending = useRef(false)
  useLeaveGuard(!claimed && !!password, busy)
  useUnload(() => {
    clearLoginTarget()
    customer.cancelAuthentication()
  })
  async function submit() {
    if (pending.current) return
    setError('')
    if (!loginPhoneIsValid(phone)) {
      setError('请填写正确的手机号')
      return
    }
    if (!password) {
      setError('请输入员工给的临时密码或网页密码')
      return
    }
    if (!agreed) {
      setError('请先阅读并同意隐私协议')
      return
    }
    pending.current = true
    setBusy(true)
    try {
      await authorizePrivacy()
      await customer.claimMember({ phone, password, privacyContractVersion: privacyVersion }, false)
      clearLoginTarget()
      setPassword('')
      setClaimed(true)
    } catch (failure) {
      if (!isCancelled(failure))
        setError(
          failure instanceof CustomerError && failure.code === 'already_registered'
            ? '你已经有账号了，请直接登录'
            : errorMessage(failure),
        )
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Screen
      navigationHeight={44}
      title={claimed ? membershipName : memberClaimTitle}
      back={!claimed}
      className={`member-claim-screen ${claimed ? 'member-claimed-screen' : ''}`}
    >
      {claimed ? (
        <View className="claim-success">
          <View className="claim-check">
            <DesignIcon name="check" />
          </View>
          <View className="claim-welcome">
            <Text className="claim-welcome-title">
              {memberWelcome}
              {account?.nickname}
            </Text>
            <Text className="claim-welcome-note">会员已经领到手机上了，以后点「我的 › 示例工坊社」就能看</Text>
          </View>
          {resource.loading ? (
            <Skeleton />
          ) : !member ? (
            <Failure error={resource.error} retry={() => void resource.refresh()} />
          ) : (
            <View className="claim-balance-card">
              <View className="claim-asset">
                <Text className="claim-asset-label">余额</Text>
                <Text className="claim-asset-value">
                  ¥{moneyText(member.balance.principalCents + member.balance.giftCents)}
                </Text>
                {member.balance.giftCents > 0 && (
                  <Text className="claim-gift">其中赠送 ¥{moneyText(member.balance.giftCents)}</Text>
                )}
              </View>
              <View className="claim-asset">
                <Text className="claim-asset-label">智能豆板</Text>
                <Text className="claim-asset-value">{member.balance.boardUses} 次</Text>
              </View>
              {history > 0 && <Text className="claim-history">以前的 {history} 笔记录已在「明细」里</Text>}
            </View>
          )}
          <Button
            className="claim-view-member"
            onClick={() => void navigateApp('/pages/customer/membership/index', true)}
          >
            去看会员
          </Button>
        </View>
      ) : (
        <View className="claim-content">
          <View className="claim-intro">
            {/* 认领页也算登录页，不写「微信」（2026-10-28 提审被驳回，见 pages/register/index.tsx） */}
            <Text className="claim-title">把店里开的会员领到手机上</Text>
            <Text className="claim-description">
              店员帮你开过会员的，填当时报的手机号和店员给你的临时密码。绑好后，以前的充值、消费都能在这里看到。
            </Text>
          </View>
          <View className="claim-fields">
            <View className="claim-field">
              <Text className="claim-label">手机号</Text>
              <Input
                className="claim-input"
                ariaLabel="手机号"
                placeholder="登记时的手机号"
                value={phone}
                maxlength={30}
                disabled={busy}
                onInput={(e) => setPhone(e.detail.value)}
              />
            </View>
            <View className="claim-field">
              <Text className="claim-label">临时密码</Text>
              <View className="claim-password">
                <Input
                  className="claim-password-input"
                  ariaLabel="临时密码或网页密码"
                  placeholder="店员给的 8 位"
                  password={!showPassword}
                  value={password}
                  maxlength={128}
                  disabled={busy}
                  onInput={(e) => setPassword(e.detail.value)}
                />
                <Button
                  className="claim-show-password"
                  ariaLabel={showPassword ? '隐藏密码' : '显示密码'}
                  disabled={busy}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <DesignIcon name="eye" />
                </Button>
              </View>
              <Text className="claim-password-help">24 小时内有效，绑好就作废。用过网页版的，填网页密码也行。</Text>
            </View>
          </View>
          <View className="claim-agreement">
            <CheckboxGroup onChange={(e) => setAgreed(e.detail.value.includes('privacy'))}>
              <Label className="claim-consent">
                <Checkbox
                  value="privacy"
                  checked={agreed}
                  disabled={busy}
                  color={nativeColors.action}
                  ariaLabel="同意隐私协议"
                />
                <Text>我已阅读并同意</Text>
              </Label>
            </CheckboxGroup>
            <Button className="claim-privacy" onClick={openPrivacy}>
              《隐私协议》
            </Button>
          </View>
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          <Button className="claim-submit" disabled={busy} loading={busy} onClick={() => void submit()}>
            {busy ? '正在绑定' : '绑定并登录'}
          </Button>
          <Text className="claim-foot">没有临时密码？到店找店员，在会员页点「发临时密码」</Text>
        </View>
      )}
      <WechatPrivacy />
    </Screen>
  )
}
