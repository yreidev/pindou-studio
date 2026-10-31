import { useEffect, useRef, useState } from 'react'
import { Input, Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import Taro from '@tarojs/taro'
import { AuthBoundary, Screen } from '../../../components/customer'
import { useCustomer } from '../../../hooks/customer'
import { AvatarPicker } from '../../../components/customer/avatar-picker'
import { customer } from '../../../services/platform'
import { returnToPreviousPage } from '../../../services/navigation'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { errorMessage, isCancelled, phoneIsValid } from '../../../services/customer'
import { phoneAuthorizationResult } from '../../../services/phone-authorization'
import './index.scss'

export default function ProfileEdit() {
  const { account } = useCustomer()
  const [nickname, setNickname] = useState(account?.nickname || '')
  const [phone, setPhone] = useState('')
  // 手输的号写进去一律「未验证」，这个标签就再也摘不掉了。给一条和注册页一样的
  // 微信授权路径：换出来的号是微信核过的，状态转 verified。
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneAuthError, setPhoneAuthError] = useState('')
  const [manualPhone, setManualPhone] = useState(false)
  const [avatar, setAvatar] = useState<string | undefined>()
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState({ nickname: '', phone: '' })
  const [focusField, setFocusField] = useState('')
  const [internationalPhone, setInternationalPhone] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  useLeaveGuard(
    !!account && (nickname !== account.nickname || !!phone || !!phoneCode || avatar !== undefined),
    saving || choosing,
  )
  function handlePhoneAuthorization(detail: unknown) {
    const result = phoneAuthorizationResult(detail)
    setPhoneCode(result.code)
    setPhoneAuthError(result.message)
    setManualPhone(!result.code)
    if (result.code) {
      setPhone('')
      setInvalid((value) => ({ ...value, phone: '' }))
    }
  }
  useEffect(() => {
    setNickname(account?.nickname || '')
    setAvatar(undefined)
    // 只在换了账号时重置表单：昵称随资料刷新变化时不能覆盖正在输入的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id])
  async function submit() {
    if (pending.current || choosing) return
    if (!nickname.trim()) {
      setInvalid((value) => ({ ...value, nickname: '请输入昵称' }))
      setFocusField('nickname')
      return
    }
    if (phone && !phoneIsValid(phone)) {
      setInvalid((value) => ({ ...value, phone: '请输入有效手机号' }))
      setFocusField('phone')
      return
    }
    pending.current = true
    setSaving(true)
    setError('')
    try {
      await customer.updateProfile({
        nickname,
        ...(phoneCode ? { phoneCode } : phone ? { phone } : {}),
        ...(avatar !== undefined ? { avatarDataUrl: avatar } : {}),
      })
      setPhone('')
      setPhoneCode('')
      await Taro.showToast({ title: '资料已保存', icon: 'success' })
      await returnToPreviousPage(true)
    } catch (error) {
      if (!isCancelled(error)) setError(errorMessage(error))
    } finally {
      pending.current = false
      setSaving(false)
    }
  }
  const verified = account?.phoneVerificationStatus === 'verified'
  return (
    <Screen title="编辑资料" back className="profile-edit-screen">
      <AuthBoundary>
        {/* 画稿 CProfileEdit（2026-10-20）：大头像、昵称一张卡（旁边「快速填写」）、手机号一张卡（快捷填写 / 手动填写）。
            画稿上写的是「用微信昵称」「用微信手机号」：这页调手机号快速验证组件，2026-10-28 提审要求不写「微信」，见 pages/register/index.tsx */}
        <View className="profile-edit-avatar">
          <AvatarPicker
            variant="large"
            value={avatar ?? account?.avatarDataUrl}
            disabled={saving}
            onChange={setAvatar}
            onBusyChange={setChoosing}
            onError={setError}
          />
          <Text className="profile-edit-hint">点头像换一张</Text>
        </View>
        <View className="profile-edit-card">
          <View className="profile-edit-label-row">
            <Text className="field-label">昵称</Text>
            {/* 昵称输入框是 type="nickname"：一聚焦，微信就在键盘上方给出微信昵称，点一下填进来 */}
            <Button className="profile-edit-inline" disabled={saving} onClick={() => setFocusField('nickname')}>
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
            disabled={saving}
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
          <Text className="field-help">店员确认预约、帮你入座时会看到这个名字</Text>
        </View>
        <View className="profile-edit-card">
          <Text className="field-label">手机号</Text>
          <View className="profile-edit-phone">
            <Text className="profile-edit-phone-number">{account?.phoneMasked || '未填写'}</Text>
            <Text className={`profile-edit-phone-status ${verified ? 'profile-edit-phone-verified' : ''}`}>
              {verified ? '已验证' : '未验证'}
            </Text>
          </View>
          <Text className="field-help">换了号码？快捷填写最快，自动验证；也可以手动填。留空保留原号码与验证状态。</Text>
          <View className="profile-edit-phone-actions">
            <Button
              className={`profile-edit-choice ${phoneCode ? '' : 'profile-edit-choice-dark'}`}
              openType="getPhoneNumber"
              disabled={saving}
              onGetPhoneNumber={(event) => handlePhoneAuthorization(event.detail)}
              onError={(event) => handlePhoneAuthorization(event.detail)}
            >
              {phoneCode ? '重新获取' : '快捷填写'}
            </Button>
            <Button
              className={`profile-edit-choice ${manualPhone ? 'profile-edit-choice-on' : ''}`}
              disabled={saving}
              onClick={() => setManualPhone((value) => !value)}
            >
              {manualPhone ? '收起手动填写' : '手动填写'}
            </Button>
          </View>
          {phoneCode && <Text className="field-help">已获取授权，保存后号码将标为「已验证」</Text>}
          {/* 主体没有手机号快速验证能力时，微信会在这里回一句「请手动填写」，并自动展开下面的输入框 */}
          {phoneAuthError && (
            <View className="field-error" role="alert">
              {phoneAuthError}
            </View>
          )}
          {/* 手输的号后端一律标未验证，所以收在「手动填写」后面，不和授权按钮抢 */}
          {manualPhone && (
            <>
              <Input
                className={`input ${invalid.phone ? 'input-invalid' : ''}`}
                ariaLabel={`手机号${invalid.phone ? `，${invalid.phone}` : ''}`}
                cursorSpacing={96}
                focus={focusField === 'phone'}
                onBlur={() => {
                  setFocusField('')
                  setInvalid((value) => ({ ...value, phone: phone && !phoneIsValid(phone) ? '请输入有效手机号' : '' }))
                }}
                type={internationalPhone || phone.startsWith('+') ? 'text' : 'number'}
                value={phone}
                maxlength={16}
                placeholder="需要更换时填写新手机号"
                disabled={saving}
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
                disabled={saving}
                onClick={() => setInternationalPhone((value) => !value)}
              >
                {internationalPhone ? '切换数字键盘' : '输入国际区号（+）'}
              </Button>
            </>
          )}
          {phone && <View className="hint">手动修改后的手机号将标为“未验证”</View>}
        </View>
        {error && (
          <View className="inline-error" role="alert">
            {error}
          </View>
        )}
        <View className="submit-area">
          <Button
            className={`button button-primary ${saving || choosing ? 'button-disabled' : ''}`}
            loading={saving}
            disabled={saving || choosing}
            onClick={() => {
              void submit()
            }}
          >
            {saving ? '正在保存' : '保存'}
          </Button>
        </View>
      </AuthBoundary>
    </Screen>
  )
}
