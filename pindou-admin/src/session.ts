import { z } from 'zod'

// 网页会话存在浏览器本地：同一台电脑上开多个标签页共用一次登录（网页会话 12 小时，见 docs/api.yaml）。
// 只存令牌和展示用的账户信息，不存任何业务数据——金额、库存、状态一律从接口读。

const accountSchema = z
  .object({
    id: z.string(),
    nickname: z.string(),
    roles: z.array(z.string()),
    avatarDataUrl: z.string().optional(),
    developerMode: z.string().optional(),
  })
  .passthrough()

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string(),
  user: accountSchema,
})

export type Account = z.infer<typeof accountSchema>
export type Session = z.infer<typeof sessionSchema>

const key = 'pindou-admin.session'

export function parseSession(value: unknown): Session | null {
  const parsed = sessionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function loadSession(now: Date = new Date()): Session | null {
  const session = parseSession(readStored())
  if (!session || !(new Date(session.expiresAt).getTime() > now.getTime())) {
    clearSession()
    return null
  }
  return session
}

function readStored(): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    // 读不到（隐私模式）或内容损坏，都当没登录
    return null
  }
}

export function saveSession(session: Session): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(session))
  } catch {
    // 隐私模式等存不进去时，本标签页仍可用到刷新为止
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 忽略：读不到就等于没有
  }
}

/** 其他标签页登录或退出时通知本页（浏览器的 storage 事件只在别的标签页改动时触发）。 */
export function onSessionChange(listener: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener()
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export const roleNames: Record<string, string> = { clerk: '店员', manager: '店长', owner: '老板' }

export function isStaff(account: Account | undefined): boolean {
  return Boolean(account?.roles.some((role) => role in roleNames))
}
