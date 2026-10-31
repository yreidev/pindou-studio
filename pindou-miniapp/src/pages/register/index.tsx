import { useRef, useState } from 'react'
import { Checkbox, CheckboxGroup, Input, Label, Text, View } from '@tarojs/components'
import { Button } from '../../components/button'
import { useDidShow, useUnload } from '@tarojs/taro'
import { Screen } from '../../components/customer'
import { AvatarPicker } from '../../components/customer/avatar-picker'
import { brandTagline, firstVisitTitle, membershipName } from '../../brand'
import { useCustomer } from '../../hooks/customer'
import { authorizePrivacy, customer, openPrivacy, privacyVersion } from '../../services/platform'
import { CustomerError, errorMessage, isCancelled, loginPhone, phoneIsValid } from '../../services/customer'
import { phoneAuthorizationResult } from '../../services/phone-authorization'
import {
  clearLoginTarget,
  completeLogin,
  confirmLeave,
  navigateApp,
  pendingLoginTarget,
} from '../../services/navigation'
import { loginHint } from '../../services/login-hint'
import { DesignIcon } from '../../components/customer/design-icon'
import { BeadHeart } from '../../components/customer/bead-heart'
import { useLeaveGuard } from '../../hooks/leave-guard'
import './index.scss'
import { nativeColors } from '../../theme'
import { WechatPrivacy } from '../../components/customer/wechat-privacy'

export default function Register() {
  const auth = useCustomer()
  const [creating, setCreating] = useState(false)
  const [nickname, setNickname] = useState('')
  const [avatar, setAvatar] = useState<string | undefined>()
  const [choosingAvatar, setChoosingAvatar] = useState(false)
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  // 默认走微信授权；主体没这个能力时，第一次点击会失败并自动切到手输。
  const [manual, setManual] = useState(false)
  const [agreed, setAgreed] = useState(false)
  // 没勾就点了「一键登录」：在勾选框下面提示，勾上就消失
  const [consentMissing, setConsentMissing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState({ nickname: '', phone: '' })
  const [focusField, setFocusField] = useState('')
  const [internationalPhone, setInternationalPhone] = useState(false)
  const [phoneError, setPhoneError] = useState('')
  const [claimRequired, setClaimRequired] = useState(false)
  const pending = useRef(false)
  const openingClaim = useRef(false)
  const busy = submitting || auth.status === 'loading' || choosingAvatar
  useLeaveGuard(!!(nickname || phone || avatar), busy)
  useUnload(() => {
    if (!openingClaim.current) {
      clearLoginTarget()
      customer.cancelAuthentication()
    }
  })

  useDidShow(() => {
    if (customer.getSnapshot().status === 'authenticated') void completeLogin()
  })

  async function openClaim(withPhone = false) {
    openingClaim.current = true
    const query = withPhone && manual && phone ? `?phone=${encodeURIComponent(loginPhone(phone))}` : ''
    // 用认领替换登录页，成功后页面栈里不会再留一个未登录页面；登录前的目标继续保留。
    if (!(await navigateApp(`/pages/customer/member-claim/index${query}`, true))) openingClaim.current = false
  }

  async function submit() {
    if (pending.current || busy) return
    setError('')
    setClaimRequired(false)
    if (!agreed) {
      setError('请先阅读并同意隐私协议')
      return
    }
    if (!nickname.trim()) {
      setInvalid((value) => ({ ...value, nickname: '请输入昵称' }))
      setFocusField('nickname')
      return
    }
    if (manual ? !phoneIsValid(phone) : !phoneCode) {
      setInvalid((value) => ({ ...value, phone: manual ? '请填写有效的手机号' : '请快捷填写手机号，或改为手动填写' }))
      setFocusField('phone')
      return
    }
    pending.current = true
    setSubmitting(true)
    try {
      await authorizePrivacy()
      await customer.register({
        nickname,
        privacyContractVersion: privacyVersion,
        ...(manual ? { phone: phone.trim() } : { phoneCode }),
        ...(avatar ? { avatarDataUrl: avatar } : {}),
      })
      setPhone('')
      setPhoneCode('')
    } catch (error) {
      if (!isCancelled(error)) setError(errorMessage(error))
      setClaimRequired(error instanceof CustomerError && error.code === 'claim_required')
      setPhoneCode('')
      if (!manual) setPhoneError('请重新获取手机号后重试，或改为手动填写')
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  // 登录也要先勾同意（2026-10-24 提审被驳回：原来点「微信一键登录」就算默认同意了隐私协议）
  async function signIn() {
    if (busy) return
    setError('')
    if (!agreed) {
      setConsentMissing(true)
      return
    }
    try {
      await authorizePrivacy()
    } catch (error) {
      if (!isCancelled(error)) setError(errorMessage(error))
      return
    }
    await customer.signIn()
    if (customer.getSnapshot().status === 'anonymous') setCreating(true)
  }

  function handlePhoneAuthorization(detail: unknown) {
    const result = phoneAuthorizationResult(detail)
    setPhoneCode(result.code)
    setPhoneError(result.message)
    setManual(!result.code)
    if (result.code) setPhone('')
  }

  const hint = loginHint(pendingLoginTarget())
  const resetForm = () => {
    setCreating(false)
    setNickname('')
    setPhone('')
    setAvatar(undefined)
    setPhoneCode('')
    setAgreed(false)
    setError('')
  }
  return (
    <Screen
      navigationHeight={creating ? undefined : 44}
      title={creating ? '创建账号' : '登录'}
      back
      dark={!creating}
      className={`register-screen ${creating ? '' : 'register-login'}`}
    >
      {/* 画稿 CLogin / CRegister（2026-10-20）：登录是深色品牌页，创建账号是浅色的两张卡 */}
      {/* ★ 这一页（登录、创建账号）和认领、编辑资料页不写「微信」、不放微信图标：2026-10-28 0.0.37 提审被驳回，
            调手机号快速验证组件的页面和它前面的登录页不能有混淆腾讯官方的元素。画稿上的「微信一键登录」和图标因此改掉了。 */}
      {!creating && (
        <>
          <View className="register-hero">
            <BeadHeart />
            <Text className="register-title">{brandTagline}</Text>
            <Text className="register-subtitle">加入{membershipName} · 保存你的预约和手作记录</Text>
          </View>
          <Button
            className="register-signin"
            disabled={busy}
            loading={auth.status === 'loading'}
            onClick={() => void signIn()}
          >
            <Text>{auth.status === 'loading' ? '正在登录' : '一键登录'}</Text>
          </Button>
          {auth.status === 'error' && <View className="inline-error">{auth.error}</View>}
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          <Button className="register-create" disabled={busy} onClick={() => setCreating(true)}>
            第一次来？创建账号
          </Button>
          <Button className="register-claim" disabled={busy} onClick={() => void openClaim()}>
            店员帮我开过会员，去认领
            <DesignIcon name="right-login" />
          </Button>
          {/* 默认不勾，顾客自己勾了才能登录；勾过再去创建账号不用再勾 */}
          <View className="agreement register-agreement register-login-agreement">
            <CheckboxGroup
              onChange={(event) => {
                const checked = event.detail.value.includes('privacy')
                setAgreed(checked)
                if (checked) setConsentMissing(false)
              }}
            >
              <Label className="register-consent-choice">
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
            <Button className="text-button register-privacy-link" hoverClass="pressed" onClick={openPrivacy}>
              《隐私协议》
            </Button>
          </View>
          {consentMissing && !agreed && (
            <View className="inline-error register-consent-error" role="alert">
              请先阅读并勾选同意隐私协议
            </View>
          )}
          <Text className="register-footnote register-footnote-tight">登录只用来认出你、保存你的预约</Text>
        </>
      )}
      {creating && (
        <>
          <View className="register-intro">
            <Text className="register-intro-title">{firstVisitTitle}</Text>
            <Text className="register-intro-note">填个名字、留个手机号就好{hint ? `，${hint}` : ''}</Text>
          </View>
          <View className="register-card">
            <View className="register-card-row">
              <AvatarPicker
                value={avatar}
                disabled={submitting || auth.status === 'loading'}
                onChange={setAvatar}
                onBusyChange={setChoosingAvatar}
                onError={setError}
              />
              {avatar ? (
                <Button
                  className="text-button register-avatar-remove"
                  disabled={busy}
                  onClick={() => {
                    setAvatar(undefined)
                    setError('')
                  }}
                >
                  移除
                </Button>
              ) : (
                <Text className="register-optional">选填</Text>
              )}
            </View>
            <View className="register-label-row">
              <Text className="field-label">昵称</Text>
              {/* 昵称输入框是 type="nickname"：一聚焦，微信就在键盘上方给出微信昵称 */}
              <Button className="register-inline" disabled={busy} onClick={() => setFocusField('nickname')}>
                快速填写
              </Button>
            </View>
            <Input
              className={`input ${invalid.nickname ? 'input-invalid' : ''}`}
              ariaLabel={`昵称${invalid.nickname ? `，${invalid.nickname}` : ''}`}
              cursorSpacing={96}
              focus={focusField === 'nickname'}
              onBlur={() => {
                setFocusField('')
                setInvalid((value) => ({ ...value, nickname: nickname.trim() ? '' : '请输入昵称' }))
              }}
              type="nickname"
              value={nickname}
              maxlength={50}
              placeholder="请输入昵称"
              disabled={busy}
              onInput={(event) => {
                setNickname(event.detail.value)
                setInvalid((value) => ({ ...value, nickname: '' }))
              }}
            />
            {invalid.nickname && (
              <View className="field-error" role="alert">
                {invalid.nickname}
              </View>
            )}
          </View>
          {/* 先勾隐私协议，再拿微信手机号（微信要求授权前已同意） */}
          <View className="agreement register-agreement">
            <CheckboxGroup onChange={(event) => setAgreed(event.detail.value.includes('privacy'))}>
              <Label className="register-consent-choice">
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
            <Button className="text-button register-privacy-link" hoverClass="pressed" onClick={openPrivacy}>
              《隐私协议》
            </Button>
            {!agreed && <Text className="register-agreement-note">同意后才能快捷填写手机号</Text>}
          </View>
          <View className="register-card">
            <Text className="field-label">手机号</Text>
            {!manual && (
              <>
                <Button
                  className={`register-phone-button ${!agreed || busy ? 'register-phone-disabled' : ''}`}
                  openType="getPhoneNumber"
                  disabled={!agreed || busy}
                  onGetPhoneNumber={(event) => handlePhoneAuthorization(event.detail)}
                  onError={(event) => handlePhoneAuthorization(event.detail)}
                >
                  <Text className="register-phone-title">
                    {phoneCode ? '已获取，点这里重新获取' : '手机号快捷填写'}
                  </Text>
                  <Text className="register-phone-note">{phoneCode ? '注册后显示核验结果' : '一键填好，自动验证'}</Text>
                </Button>
              </>
            )}
            {manual && (
              <>
                <Input
                  className={`input ${invalid.phone ? 'input-invalid' : ''}`}
                  ariaLabel={`手机号${invalid.phone ? `，${invalid.phone}` : ''}`}
                  cursorSpacing={96}
                  focus={focusField === 'phone'}
                  onBlur={() => {
                    setFocusField('')
                    setInvalid((value) => ({
                      ...value,
                      phone: phone && !phoneIsValid(phone) ? '请输入有效手机号' : '',
                    }))
                  }}
                  type={internationalPhone || phone.startsWith('+') ? 'text' : 'number'}
                  value={phone}
                  maxlength={16}
                  placeholder="请输入手机号"
                  disabled={busy}
                  onInput={(event) => {
                    setPhone(event.detail.value)
                    setInvalid((value) => ({ ...value, phone: '' }))
                  }}
                />
                {invalid.phone && (
                  <View className="field-error" role="alert">
                    {invalid.phone}
                  </View>
                )}
                <Button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setInternationalPhone((value) => !value)}
                >
                  {internationalPhone ? '切换数字键盘' : '输入国际区号（+）'}
                </Button>
              </>
            )}
            {phoneError && <Text className="field-error">{phoneError}</Text>}
            <Button
              className="manual-phone text-button"
              hoverClass="pressed"
              disabled={busy}
              onClick={() => {
                setManual((value) => !value)
                setPhoneCode('')
                setPhoneError('')
              }}
            >
              {manual ? '改用快捷填写' : '换个号码，手动填写'}
            </Button>
            <Text className="field-help">
              手动填的号码会显示<Text className="badge badge-unverified">未验证</Text>，也可以正常预约
            </Text>
          </View>
          {error && (
            <View className="inline-error" role="alert">
              {error}
            </View>
          )}
          {claimRequired && (
            <Button className="button button-outline" disabled={busy} onClick={() => void openClaim(true)}>
              去认领会员
            </Button>
          )}
          <View className="register-submit">
            <Button
              className={`button button-primary ${busy ? 'button-disabled' : ''}`}
              loading={submitting}
              disabled={busy}
              onClick={() => {
                void submit()
              }}
            >
              {submitting ? '正在注册' : '完成注册'}
            </Button>
          </View>
          <Button
            className="text-button register-back"
            disabled={busy}
            onClick={() => {
              void confirmLeave().then((ok) => {
                if (ok) resetForm()
              })
            }}
          >
            已有账号，返回登录
          </Button>
        </>
      )}
      <WechatPrivacy />
    </Screen>
  )
}
