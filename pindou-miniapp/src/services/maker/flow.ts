import Taro from '@tarojs/taro'
import { navigateApp } from '../navigation'
import { choosePhoto, DeviceError, readPixels } from './device'
import { session, startPhoto } from './session'

// 做图纸的几个入口共用的步骤：选照片、读像素，再进调整照片页。

export const makerPages = {
  photo: '/pages/maker/photo/index',
  /** 从主包（底部「图纸」）进来：主包不引做图纸的代码，到了照片页再选照片 */
  photoPick: '/pages/maker/photo/index?pick=1',
  pattern: (id: string) => `/pages/maker/pattern/index?id=${encodeURIComponent(id)}`,
  mine: '/pages/maker/mine/index',
  import: '/pages/maker/import/index',
}

/** 选一张照片、读好像素放进 session.photo。选好了回 true；取消、读不出来回 false（读不出来已经提示过）。 */
export async function pickPhoto(): Promise<boolean> {
  let path: string | undefined
  try {
    path = await choosePhoto()
  } catch (error) {
    void Taro.showToast({ title: error instanceof DeviceError ? error.message : '照片读不出来', icon: 'none' })
    return false
  }
  if (!path) return false
  void Taro.showLoading({ title: '正在读照片' })
  try {
    startPhoto(path, await readPixels(path))
  } catch (error) {
    void Taro.hideLoading()
    void Taro.showToast({ title: error instanceof DeviceError ? error.message : '照片读不出来', icon: 'none' })
    return false
  }
  void Taro.hideLoading()
  session.draft = undefined
  return true
}

/** 「用照片做图纸」（我的图纸里）：选好照片再进调整照片页。顾客取消时什么都不做。 */
export async function startFromPhoto() {
  if (await pickPhoto()) void navigateApp(makerPages.photo)
}
