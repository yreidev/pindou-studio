/** 把内容存成文件：浏览器直接下载，不再像小程序那样只能「分享/打开」。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 给浏览器一点时间开始下载再回收
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
