import Taro from '@tarojs/taro'
import { CustomerClient, CustomerError } from './customer'
import { clearLoginTarget, completeLogin } from './navigation'
import { apiBase } from './api-base'

const storageKey = 'pindou.customer.credential.v1'
const manualLoginKey = 'pindou.customer.manual-login-required.v1'
/** 注册时记下的隐私协议版本：微信后台登记的那一份。 */
export const privacyVersion = process.env.TARO_APP_PRIVACY_VERSION || 'wechat-privacy-v1'

export const customer = new CustomerClient({
  request: async (path, options) => {
    const result = await Taro.request({
      url: `${apiBase.replace(/\/$/, '')}${path}`,
      method: options.method,
      data: options.data,
      timeout: 15000,
      header: {
        'Content-Type': 'application/json',
        ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      },
    })
    return { statusCode: result.statusCode, data: result.data }
  },
  login: async () => (await Taro.login()).code,
  readCredential: () => Taro.getStorageSync(storageKey),
  saveCredential: (credential) => Taro.setStorageSync(storageKey, credential),
  clearCredential: () => Taro.removeStorageSync(storageKey),
  readManualLoginRequired: () => Taro.getStorageSync(manualLoginKey) === true,
  setManualLoginRequired: (required) => {
    if (required) {
      clearLoginTarget()
      Taro.setStorageSync(manualLoginKey, true)
    } else Taro.removeStorageSync(manualLoginKey)
  },
  now: () => Date.now(),
  onSessionCreated: () => {
    void completeLogin()
  },
})

export const authorizePrivacy = () =>
  new Promise<void>((resolve, reject) => {
    // 这两句显示在登录、创建账号和认领页上，不写「微信」（2026-10-28 提审被驳回，见 pages/register/index.tsx）
    if (!Taro.requirePrivacyAuthorize) {
      reject(new CustomerError('privacy', '当前版本太旧，请升级后再完成隐私授权'))
      return
    }
    Taro.requirePrivacyAuthorize({
      success: () => resolve(),
      fail: () => reject(new CustomerError('privacy', '请先同意隐私授权')),
    })
  })

export function openPrivacy() {
  Taro.openPrivacyContract({
    fail: () => {
      void Taro.showToast({ title: '暂时无法打开隐私协议，请稍后重试', icon: 'none' })
    },
  })
}
