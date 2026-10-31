import Taro from '@tarojs/taro'

export async function prepareAvatar(filePath: string): Promise<string> {
  const compressed = await Taro.compressImage({
    src: filePath,
    quality: 80,
    compressedWidth: 256,
    compressedHeight: 256,
  })
  const data = await new Promise<string>((resolve, reject) =>
    Taro.getFileSystemManager().readFile({
      filePath: compressed.tempFilePath,
      encoding: 'base64',
      success: (result) => (typeof result.data === 'string' ? resolve(result.data) : reject(new Error('无法读取头像'))),
      fail: () => reject(new Error('无法读取头像，请重新选择')),
    }),
  )
  if (data.length > 131072) throw new Error('头像图片过大，请重新选择')
  const format = (await Taro.getImageInfo({ src: compressed.tempFilePath })).type
  const mime = format === 'png' ? 'png' : format === 'jpg' || format === 'jpeg' ? 'jpeg' : ''
  if (!mime) throw new Error('请选择 JPG 或 PNG 头像')
  return `data:image/${mime};base64,${data}`
}
