// 上传图纸前在浏览器里把图缩小（2026-10-20 业主定）：员工选 JPG 或 PNG（不超过 5 MB），长边缩到 1600 像素再传。
// 接口请求体上限 2 MB，后端收的图片原始字节最多 1.4 MB（见 docs/api.yaml 的 POST /patterns），这里留些余量压到 1.3 MB 以内。
// 后端还会重新编码一遍（去掉拍摄地点等元数据、生成缩略图），这里不必管元数据。
// PNG（格子图纸多是 PNG）尽量保持 PNG，太大才转 JPEG；透明处垫白，不然转 JPEG 会变黑。

export const acceptedTypes = ['image/jpeg', 'image/png'] as const
export const maxSourceBytes = 5 * 1024 * 1024
export const maxSide = 1600
export const maxUploadBytes = 1300 * 1024

/** 选的文件能不能用：不能用时返回给人看的原因。 */
export function fileProblem(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(acceptedTypes as readonly string[]).includes(file.type)) return '只能上传 JPG 或 PNG 图片'
  if (file.size > maxSourceBytes) return '图片不能超过 5 MB，请先压缩一下'
  if (file.size === 0) return '这个文件是空的'
  return null
}

/** 长边不超过 max 的尺寸（等比缩放，不放大）。 */
export function fitSize(width: number, height: number, max = maxSide): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** data URL 里图片本身的字节数（base64 解码后）。 */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** 文件名去掉扩展名，当图纸名字的默认值（最多 20 个字）。 */
export function nameFromFile(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').trim()
  return Array.from(base).slice(0, 20).join('')
}

export interface PreparedImage {
  dataUrl: string
  width: number
  height: number
}

/** JPEG 依次试的质量：先清楚，太大再降。 */
const jpegQualities = [0.9, 0.82, 0.72, 0.6]

/**
 * 读文件、缩到长边 1600、编成 data URL。PNG 编出来不超过上限就保留 PNG，否则和 JPEG 一样按质量从高到低试到装得下。
 * 照片的拍摄方向按 EXIF 摆正（createImageBitmap 的 imageOrientation）。
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持处理图片，请换 Chrome 或 Edge')
    if (file.type === 'image/png') {
      context.drawImage(bitmap, 0, 0, width, height)
      const png = canvas.toDataURL('image/png')
      if (dataUrlBytes(png) <= maxUploadBytes) return { dataUrl: png, width, height }
      context.clearRect(0, 0, width, height)
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    for (const quality of jpegQualities) {
      const jpeg = canvas.toDataURL('image/jpeg', quality)
      if (dataUrlBytes(jpeg) <= maxUploadBytes) return { dataUrl: jpeg, width, height }
    }
    throw new Error('这张图压缩后还是太大，请换一张或先裁小')
  } finally {
    bitmap.close()
  }
}
