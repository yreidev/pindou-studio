import { QRCodeSVG } from 'qrcode.react'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

// 网页桌码：普通二维码，内容是 <地址>/t?tableId=…。微信「扫一扫」或长按识别时，公众平台已发布的「扫普通链接二维码打开小程序」
// 规则按 <地址>/t 这个前缀直接打开小程序入座页；用手机相机、浏览器扫，打开的是后端给的一页「请用微信扫码」
// （顾客网页 2026-10-31 已下线，见 docs/plan-split-release.md）。生成不调微信，在浏览器里就能画。
//
// 地址（website，如 https://pindou.example.invalid）不写在这里：后端按部署配置给（/system/code-settings 的
// customerWebsite），页面读到后传进来。它印在桌码里，印出去就不能再改。

export const webCodeUrl = (website: string, tableId: string) =>
  `${website.replace(/\/+$/, '')}/t?tableId=${encodeURIComponent(tableId)}`

/**
 * 在浏览器里画一张网页桌码，得到 SVG 的 data URL（预览、打印、下载和小程序码走同一套）。
 * 纠错等级 M、四格留白，打印后贴在桌上用手机扫没问题。
 */
export async function webTableCode(website: string, tableId: string): Promise<string> {
  const host = document.createElement('div')
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      createElement(QRCodeSVG, {
        value: webCodeUrl(website, tableId),
        size: 512,
        marginSize: 4,
        level: 'M',
        xmlns: 'http://www.w3.org/2000/svg',
      }),
    ),
  )
  const svg = host.innerHTML
  root.unmount()
  if (!svg.startsWith('<svg')) throw new Error('网页桌码生成失败，请重试')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
