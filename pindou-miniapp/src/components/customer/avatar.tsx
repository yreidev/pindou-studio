import { useEffect, useState } from 'react'
import { Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { assets } from './assets'

let sequence = 0

export function AccountAvatar({ value, className = '' }: { value?: string; className?: string }) {
  const [source, setSource] = useState(assets.avatar)
  useEffect(() => {
    setSource(assets.avatar)
    if (!value || !/^data:image\/(jpeg|png);base64,/.test(value)) return
    // 小程序的 Image 不认 data: 地址，要先写成本地文件
    const [header, data] = value.split(',')
    const path = `${Taro.env.USER_DATA_PATH}/pindou-avatar-${Date.now()}-${++sequence}.${header.includes('png') ? 'png' : 'jpg'}`
    const files = Taro.getFileSystemManager()
    let cancelled = false
    // Keep only this mounted view's image file; the API remains the source of truth.
    const remove = () => files.unlink({ filePath: path, fail: () => {} })
    files.writeFile({
      filePath: path,
      data,
      encoding: 'base64',
      success: () => {
        if (cancelled) remove()
        else setSource(path)
      },
      fail: () => {},
    })
    return () => {
      cancelled = true
      remove()
    }
  }, [value])
  return (
    <Image
      src={source}
      className={`account-avatar ${className}`}
      mode="aspectFill"
      onError={() => setSource(assets.avatar)}
    />
  )
}
