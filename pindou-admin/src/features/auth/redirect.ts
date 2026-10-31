/**
 * 只跳站内路径，防止登录页被拿来跳到别的网站。按浏览器的规则解析后核对同源：
 * 浏览器把 `/\evil.example` 当成 `//evil.example`，只看前缀挡不住。
 */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/')) return '/'
  const base = 'https://admin.invalid'
  let url: URL
  try {
    url = new URL(target, base)
  } catch {
    return '/'
  }
  if (url.origin !== base || url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/'
  return url.pathname + url.search + url.hash
}
