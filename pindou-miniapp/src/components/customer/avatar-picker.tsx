import { useEffect, useRef, useState } from 'react'
import { Text } from '@tarojs/components'
import { Button } from '../button'
import { AccountAvatar } from './avatar'
import { prepareAvatar } from '../../services/avatar'
import './avatar-picker.scss'

type Props = {
  value?: string
  disabled: boolean
  onChange: (value: string) => void
  onBusyChange: (busy: boolean) => void
  onError: (message: string) => void
  /** large：编辑资料页正中的大头像，下面一行字；row（默认）：注册页卡片里的一行。 */
  variant?: 'row' | 'large'
}

export function AvatarPicker({ value, disabled, onChange, onBusyChange, onError, variant = 'row' }: Props) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  async function choose(path: string) {
    if (disabled || pending.current || !path) return
    pending.current = true
    setBusy(true)
    onBusyChange(true)
    onError('')
    try {
      if (!active.current) return
      const prepared = await prepareAvatar(path)
      if (active.current) onChange(prepared)
    } catch (error) {
      const message = error instanceof Error ? error.message : (error as { errMsg?: string })?.errMsg || ''
      if (active.current && !/cancel/i.test(message)) onError('无法处理头像，请重新选择 JPG 或 PNG 图片')
    } finally {
      pending.current = false
      if (active.current) {
        setBusy(false)
        onBusyChange(false)
      }
    }
  }

  return (
    <Button
      className={`avatar-picker avatar-picker-${variant}`}
      openType="chooseAvatar"
      disabled={disabled || busy}
      ariaLabel={value ? '更换头像' : '选择头像'}
      onChooseAvatar={(event) => {
        void choose(event.detail.avatarUrl)
      }}
    >
      <AccountAvatar value={value} className="avatar-picker-image" />
      <Text className="avatar-picker-action">{busy ? '正在处理' : value ? '更换头像' : '选择头像'}</Text>
    </Button>
  )
}
