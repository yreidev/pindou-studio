import { useEffect, useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { Button } from '../button'
import { openPrivacy } from '../../services/platform'

/** 登录、注册和认领共用微信隐私授权；返回页面时重新接管授权回调。 */
export function WechatPrivacy() {
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const privacyResolve = useRef<((option: Taro.onNeedPrivacyAuthorization.ResolveOption) => void) | null>(null)
  const active = useRef(false)
  const register = () => {
    if (Taro.onNeedPrivacyAuthorization)
      Taro.onNeedPrivacyAuthorization((resolve) => {
        if (!active.current) {
          resolve({ event: 'disagree' })
          return
        }
        privacyResolve.current = resolve
        setPrivacyOpen(true)
      })
  }
  useEffect(() => {
    active.current = true
    register()
    return () => {
      active.current = false
      privacyResolve.current?.({ event: 'disagree' })
      privacyResolve.current = null
    }
  }, [])
  useDidShow(register)
  return (
    <>
      {privacyOpen && (
        <View className="privacy-backdrop">
          <View className="privacy-dialog" role="dialog" ariaLabel="隐私授权">
            <Text className="section-title">隐私授权</Text>
            <Text>登录、注册和手机号授权需要你同意小程序隐私协议。</Text>
            <Button className="text-button" onClick={openPrivacy}>
              查看隐私协议
            </Button>
            <Button
              id="privacy-agree"
              className="button button-primary"
              openType="agreePrivacyAuthorization"
              onAgreePrivacyAuthorization={() => {
                privacyResolve.current?.({ event: 'agree', buttonId: 'privacy-agree' })
                privacyResolve.current = null
                setPrivacyOpen(false)
              }}
            >
              同意并继续
            </Button>
            <Button
              className="button button-outline"
              onClick={() => {
                privacyResolve.current?.({ event: 'disagree' })
                privacyResolve.current = null
                setPrivacyOpen(false)
              }}
            >
              暂不同意
            </Button>
          </View>
        </View>
      )}
    </>
  )
}
