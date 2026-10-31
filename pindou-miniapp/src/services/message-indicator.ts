import Taro from '@tarojs/taro'

/** 「我的」那格的红点；不在底部栏页面上时会失败，不影响页面。 */
export async function messageRedDot(unread: boolean) {
  try {
    if (unread) await Taro.showTabBarRedDot({ index: 3 })
    else await Taro.hideTabBarRedDot({ index: 3 })
  } catch {
    /* 标签栏还未挂载时，下次显示页面会再同步。 */
  }
}
