import type { Account } from '../session'
import { ApiError, client, read } from './client'
import type { paths } from './schema'

/** 发起扫码登录拿到的挑战；pollToken 只交给发起的网页，凭它领会话、换小程序码。 */
export type WebLoginChallenge =
  paths['/auth/web-login-challenges']['post']['responses'][201]['content']['application/json']

export type ClaimResult =
  | { kind: 'pending'; expiresAt: string }
  | { kind: 'issued'; accessToken: string; expiresAt: string; user: Account }
  | { kind: 'closed' }

const challengeClosed = (error: unknown) => error instanceof ApiError && (error.status === 410 || error.status === 404)

export async function createWebLoginChallenge(): Promise<WebLoginChallenge> {
  return read(client.POST('/auth/web-login-challenges'))
}

/** 网页轮询：202 等待中、201 领到会话、410/404 这次扫码已失效（刷新二维码重来）。 */
export async function claimWebSession(challenge: WebLoginChallenge): Promise<ClaimResult> {
  try {
    const { data, response } = await client.POST('/auth/web-login-challenges/{challengeId}/session', {
      params: { path: { challengeId: challenge.id } },
      body: { pollToken: challenge.pollToken },
    })
    if (!data) throw new ApiError(response.status, 'http_error', '登录状态读取失败，请刷新二维码')
    if ('accessToken' in data) {
      return { kind: 'issued', accessToken: data.accessToken, expiresAt: data.expiresAt, user: data.user }
    }
    return { kind: 'pending', expiresAt: data.expiresAt }
  } catch (error) {
    if (challengeClosed(error)) return { kind: 'closed' }
    throw error
  }
}

export type WebLoginCode =
  { kind: 'image'; dataUrl: string } | { kind: 'fallback'; reason: string } | { kind: 'closed' }

/**
 * 用 pollToken 换一张小程序码：员工用微信扫一扫直接打开小程序的批准页。
 * 生成不了（没配微信、微信出错、太频繁）时退回普通二维码；挑战已失效（410/404）就该换一个挑战。
 */
export async function getWebLoginCode(challenge: WebLoginChallenge): Promise<WebLoginCode> {
  try {
    const data = await read(
      client.POST('/auth/web-login-challenges/{challengeId}/code', {
        params: { path: { challengeId: challenge.id } },
        body: { pollToken: challenge.pollToken },
      }),
    )
    return { kind: 'image', dataUrl: data.imageDataUrl }
  } catch (error) {
    if (challengeClosed(error)) return { kind: 'closed' }
    return { kind: 'fallback', reason: error instanceof Error ? error.message : '小程序码暂时生成不了' }
  }
}

export async function logoutCurrentSession(): Promise<void> {
  await client.DELETE('/auth/sessions/current')
}

export type Health = paths['/healthz']['get']['responses'][200]['content']['application/json']

/** 后端在跑的构建。读不带 /api/v2 前缀的 /healthz（后端两处都提供），和发布后核对版本用的是同一个地址。 */
export async function getHealth(): Promise<Health> {
  return read(client.GET('/healthz', { baseUrl: window.location.origin }))
}

export async function getMiniappVersion() {
  return read(client.GET('/system/miniapp-version'))
}
