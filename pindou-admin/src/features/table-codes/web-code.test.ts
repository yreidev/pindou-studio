import { describe, expect, it } from 'vitest'
import { webCodeUrl, webTableCode } from './web-code'

const site = 'https://pindou.example.invalid'

describe('网页桌码', () => {
  it('内容是后端给的地址加上入座路径', () => {
    expect(webCodeUrl('https://pindou.example.invalid', 'e5e94125-43e3-4088-93cc-b2ea9ea01102')).toBe(
      'https://pindou.example.invalid/t?tableId=e5e94125-43e3-4088-93cc-b2ea9ea01102',
    )
    // 本机开发是 http 加端口；结尾多一个斜杠也不会变成 //t
    expect(webCodeUrl('http://localhost:8080/', 'e5e94125-43e3-4088-93cc-b2ea9ea01102')).toBe(
      'http://localhost:8080/t?tableId=e5e94125-43e3-4088-93cc-b2ea9ea01102',
    )
  })

  it('在浏览器里画成能单独打开的 SVG 图片', async () => {
    const dataUrl = await webTableCode(site, 'e5e94125-43e3-4088-93cc-b2ea9ea01102')
    expect(dataUrl.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    const svg = decodeURIComponent(dataUrl.slice('data:image/svg+xml;charset=utf-8,'.length))
    // 当作 <img> 的图片单独打开，必须带 SVG 的命名空间
    expect(svg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(svg).toContain('<path')
    // 同一张桌每次画出来一样（重新生成不会变）
    expect(await webTableCode(site, 'e5e94125-43e3-4088-93cc-b2ea9ea01102')).toBe(dataUrl)
  })
})
