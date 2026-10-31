import Taro from '@tarojs/taro'

/** 关闭发生在读取或调亮途中时，也等本次操作完成后恢复。 */
export function brightenScreen() {
  let closed = false
  let restored = false
  let original: number | undefined
  const raised = Taro.getScreenBrightness()
    .then(async (result) => {
      if (closed) return
      original = result.value
      await Taro.setScreenBrightness({ value: 1 })
    })
    .catch(() => undefined)
  return () => {
    if (closed) return
    closed = true
    void raised.then(() => {
      if (original !== undefined && !restored) {
        restored = true
        void Taro.setScreenBrightness({ value: original }).catch(() => undefined)
      }
    })
  }
}
