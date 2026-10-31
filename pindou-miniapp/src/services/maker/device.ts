import Taro from '@tarojs/taro'
import type { Pixels } from './image'

// 做图纸用到的手机能力（docs/plan-bead-maker.md 第 3 节 7、8）：选照片、读像素、存相册、发文件和选文件、屏幕常亮。
// 这里只有小程序的接口；算法只认 Pixels，不碰这里。
// 按微信文档（2026-10-21 核对）：离屏画布 createOffscreenCanvas({ type: '2d' }) 能 createImage、getImageData，
// 但没有导出图片的方法，存相册要画在页面上的 <Canvas type="2d"> 上再 canvasToTempFilePath；
// shareFileMessage 只能在点击时调用；chooseMessageFile 的 extension 只在 type 为 file 时有效。

/**
 * 公众平台的「用户隐私保护指引」里有没有「选中的文件」：没声明时微信直接拦下 chooseMessageFile，导入图纸文件、表格必然失败。
 * 2026-10-24 那版没选上这一项（也没通过审核），重交的那版带上了，2026-10-27 确认已审核通过，打开「导入图纸文件」。
 * 以后指引里去掉这一项时改回 false。
 */
export const fileImportDeclared = true

/** 照片缩到长边不超过这么多再处理：300 格 × 4 像素 = 1200，留点裁剪的余量。 */
export const PHOTO_SIDE = 1600

export class DeviceError extends Error {}

const cancelled = (error: unknown) => /cancel/i.test(String((error as { errMsg?: string })?.errMsg ?? error))

/** 选一张照片（相册或拍照），返回临时路径；顾客取消时是 undefined。 */
export async function choosePhoto(): Promise<string | undefined> {
  try {
    const result = await Taro.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['original'],
    })
    return result.tempFiles[0]?.tempFilePath
  } catch (error) {
    if (cancelled(error)) return undefined
    throw new DeviceError('照片读不出来，换一张试试')
  }
}

type Drawable = { width: number; height: number }
type Context2D = {
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
}

function fit(width: number, height: number, side: number) {
  const k = Math.min(1, side / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** 读出照片的像素，长边缩到 side 以内。 */
export async function readPixels(path: string, side = PHOTO_SIDE): Promise<Pixels> {
  try {
    const info = await Taro.getImageInfo({ src: path })
    const size = fit(info.width, info.height, side)
    const canvas = Taro.createOffscreenCanvas({ type: '2d', width: size.width, height: size.height })
    const ctx = canvas.getContext('2d') as unknown as Context2D
    const image = canvas.createImage() as unknown as Drawable & { onload: () => void; onerror: () => void; src: string }
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('load'))
      image.src = path
    })
    ctx.drawImage(image, 0, 0, size.width, size.height)
    return { ...size, data: ctx.getImageData(0, 0, size.width, size.height).data }
  } catch {
    throw new DeviceError('照片读不出来，换一张试试')
  }
}

/** 页面上一块 <Canvas type="2d" id=…> 的节点。 */
export type CanvasNode = {
  width: number
  height: number
  getContext(type: '2d'): unknown
  requestAnimationFrame?: (callback: () => void) => number
  /** 小程序的 <Canvas type="2d"> 才有：建一张能 drawImage 的图片 */
  createImage?: () => { onload: () => void; onerror: () => void; src: string }
}

/** 按 id 取页面上的画布节点和它在页面上的大小（CSS 像素）。 */
export function canvasNode(id: string): Promise<{ node: CanvasNode; width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    Taro.createSelectorQuery()
      .select(`#${id}`)
      .fields({ node: true, size: true })
      .exec((result) => {
        const hit = result?.[0] as { node?: CanvasNode; width?: number; height?: number } | undefined
        resolve(hit?.node ? { node: hit.node, width: hit.width ?? 0, height: hit.height ?? 0 } : undefined)
      })
  })
}

/** 屏幕像素比：画布按它放大，线和字才清楚。 */
export function pixelRatio() {
  try {
    return Taro.getWindowInfo().pixelRatio || 2
  } catch {
    return 2
  }
}

/** 把画好的画布存进相册。 */
export async function saveCanvas(node: CanvasNode): Promise<void> {
  let filePath: string
  try {
    filePath = (
      await Taro.canvasToTempFilePath({
        canvas: node as unknown as Taro.canvasToTempFilePath.Option['canvas'],
        fileType: 'png',
        destWidth: node.width,
        destHeight: node.height,
      })
    ).tempFilePath
  } catch {
    throw new DeviceError('图片生成不了，图纸太大时换小一点的格数再试')
  }
  try {
    await Taro.saveImageToPhotosAlbum({ filePath })
  } catch (error) {
    if (cancelled(error)) return
    if (/auth|deny|denied/i.test(String((error as { errMsg?: string })?.errMsg ?? ''))) {
      throw new DeviceError('没有存相册的权限：点右上角「···」›「设置」打开「添加到相册」后再存')
    }
    throw new DeviceError('没存进相册，请稍后再试')
  }
}

/** 发一个文本文件到聊天（要在点击里调用）。 */
export async function shareText(fileName: string, text: string): Promise<void> {
  const fs = Taro.getFileSystemManager()
  const filePath = `${Taro.env.USER_DATA_PATH ?? ''}/${fileName}`
  try {
    fs.writeFileSync(filePath, text, 'utf8')
  } catch {
    throw new DeviceError('文件写不进手机，请稍后再试')
  }
  try {
    await Taro.shareFileMessage({ filePath, fileName })
  } catch (error) {
    if (cancelled(error)) return
    throw new DeviceError('没发出去，请稍后再试')
  }
}

/** 从聊天里选一个图纸文件或表格。取消时是 undefined。 */
export async function pickText(extensions: string[]): Promise<{ name: string; text: string } | undefined> {
  let picked: { path: string; name: string; size: number } | undefined
  try {
    picked = (await Taro.chooseMessageFile({ count: 1, type: 'file', extension: extensions })).tempFiles[0]
  } catch (error) {
    if (cancelled(error)) return undefined
    throw new DeviceError('文件选不了，请稍后再试')
  }
  if (!picked) return undefined
  if (picked.size > 2 * 1024 * 1024) throw new DeviceError('文件太大了，不像是图纸文件')
  try {
    return { name: picked.name, text: Taro.getFileSystemManager().readFileSync(picked.path, 'utf8') as string }
  } catch {
    throw new DeviceError('文件读不出来')
  }
}

/** 边拼边看时屏幕常亮（只在本小程序前台时有效）。 */
export async function keepScreenOn(on: boolean) {
  try {
    await Taro.setKeepScreenOn({ keepScreenOn: on })
  } catch {
    // 常亮只是方便，开不了不打扰顾客
  }
}
