import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import { request } from './staff'
import type { ReservationEntry, ReservationView } from './reservations'

// 顾客预约的微信订阅消息（2026-10-20 起，docs/plan-notify-and-share.md 第 3 节）：店员确认、开始前提醒、店员取消各发一条。
// 模板编号随顾客本人的预约视图下发（noticeTemplates，门店没开时为空）；订阅框要顾客点一下才弹，一次最多 5 个模板。
// 顾客允许了哪几种，带一个新的登录码告诉后端（后端换出 openid、加密存下）。

export type NoticeKind = components['schemas']['ReservationNoticeKind']
export type NoticeTemplate = { kind: NoticeKind; templateId: string }

/** 提交预约时一次订三种。 */
export const bookingNotices: readonly NoticeKind[] = ['confirmed', 'reminder', 'cancelled']

/**
 * 这条预约还缺哪几种：待确认的要确认、提醒、取消三种，已确认的只要提醒和取消，别的状态（含过了宽限期）不再开。
 * 只算门店开了的种类；门店没开时总是空。
 */
export function missingNotices(entry: ReservationEntry, templates: readonly NoticeTemplate[]): NoticeKind[] {
  const wanted: readonly NoticeKind[] =
    entry.displayStatus === 'pending'
      ? bookingNotices
      : entry.displayStatus === 'confirmed'
        ? ['reminder', 'cancelled']
        : []
  const have = new Set(entry.notices ?? [])
  return wanted.filter((kind) => !have.has(kind) && templates.some((item) => item.kind === kind))
}

/** 弹订阅框，返回顾客点了允许的种类（按模板的顺序）。门店没开或弹框出错都返回空，不打扰顾客。 */
export async function askNotices(
  templates: readonly NoticeTemplate[],
  kinds: readonly NoticeKind[],
): Promise<NoticeKind[]> {
  const chosen = templates.filter((item) => kinds.includes(item.kind))
  if (!chosen.length) return []
  try {
    // Taro 的类型要求带 entityIds（别的场景用的），这里只订模板，不传它
    // 失败（顾客关了订阅消息总开关等）走 catch；成功时每个模板编号对应 accept、reject、ban 等
    const result = (await Taro.requestSubscribeMessage({
      tmplIds: chosen.map((item) => item.templateId),
    } as Taro.requestSubscribeMessage.Option)) as Taro.requestSubscribeMessage.SuccessCallbackResult
    return chosen.filter((item) => result[item.templateId] === 'accept').map((item) => item.kind)
  } catch {
    return []
  }
}

/** 把顾客允许了的种类记到这条预约上，返回本人的预约视图。 */
export async function saveNotices(reservationId: string, kinds: readonly NoticeKind[]): Promise<ReservationView> {
  const { code } = await Taro.login()
  return request<ReservationView>(`/reservations/${encodeURIComponent(reservationId)}/notices`, 'POST', {
    wechatLoginCode: code,
    kinds,
  })
}
