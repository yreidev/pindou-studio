import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import { request } from './staff'

/** 只报告微信给出的正式版运行版本，不能拿构建版本冒充线上版本。 */
export async function reportMiniappVersion(): Promise<void> {
  const { miniProgram } = Taro.getAccountInfoSync()
  if (miniProgram.envVersion !== 'release') return
  if (!miniProgram.version) throw new Error('正式版未提供运行版本号')
  const report: components['schemas']['MiniappVersionReport'] = {
    envVersion: 'release',
    version: miniProgram.version,
  }
  await request('/system/miniapp-version', 'POST', report)
}
