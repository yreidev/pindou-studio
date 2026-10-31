import Taro from '@tarojs/taro'
import type { components } from '../api/schema'
import { membershipName } from '../brand'
import { request } from './staff'

// 会员码（2026-10-06 业主决定）：顾客在会员中心亮出二维码，店员扫一下调出这位顾客，不用报手机号。
// 码里只有一个 90 秒有效的随机令牌（20 位数字），由后端签发、只有员工能凭它查人（docs/api.yaml /member-codes）。
// 顾客页每分钟换一个码；二维码在小程序里自己画（services/qr.ts），不调微信接口。

type Schemas = components['schemas']
export type MemberCode = Schemas['MemberCode']
/** 凭会员码查到的顾客：称呼、打码手机号、会员资产摘要。 */
export type MemberCodeAccount = Schemas['MemberCodeAccount']

/** 会员码的样子：首位 9 的 20 位数字。扫到的内容先按它挑一遍，不像的不必去问后端。 */
export const isMemberCode = (text: string) => /^9[0-9]{19}$/.test((text || '').trim())

/** 会员码卡片上的一句说明：系统内收费关着时（2026-10-10 起钱在美团、大众点评收）不提结账。 */
export const memberCodeIntro = (billing: boolean) =>
  billing
    ? '到店结账、充值或兑换时，出示给店员扫一扫，不用报手机号。'
    : '到店充值、兑换积分或领生日礼物时，出示给店员扫一扫，不用报手机号。'

/** 顾客页多久换一个新码。码 90 秒有效，留 30 秒给网络慢和店员扫的那一下。 */
export const memberCodeRefreshMs = 60_000

export const memberCodes = {
  /** 给自己签发一个会员码（顾客、员工都可以；按账户限流，每分钟 20 次）。 */
  issue: () => request<MemberCode>('/member-codes', 'POST'),
  /** 员工凭会员码查人：过期回 410 member_code_expired，不是本店的码回 404 member_code_not_found（说明是后端给的中文）。 */
  lookup: (code: string) =>
    request<MemberCodeAccount>('/member-codes/lookups', 'POST', { code: code.trim() } satisfies { code: string }),
}

export type MemberScan =
  { kind: 'cancelled' } | { kind: 'error'; message: string } | { kind: 'found'; account: MemberCodeAccount }

type ScanResult = { result?: string }

/**
 * 员工扫顾客的会员码（只用相机、只认二维码），查出是哪位顾客。取消扫码不提示；
 * 扫到的不是会员码、码过期了、查询失败都给出要显示的话。
 */
export async function scanMemberCode(
  scan: () => Promise<ScanResult> = () => Taro.scanCode({ onlyFromCamera: true, scanType: ['qrCode'] }),
  lookup: (code: string) => Promise<MemberCodeAccount> = memberCodes.lookup,
): Promise<MemberScan> {
  let scanned: ScanResult
  try {
    scanned = await scan()
  } catch (error) {
    if (/cancel/.test((error as { errMsg?: string } | undefined)?.errMsg || '')) return { kind: 'cancelled' }
    return { kind: 'error', message: '没有扫到会员码，请对准顾客手机上的二维码再试一次' }
  }
  const code = (scanned.result || '').trim()
  if (!isMemberCode(code))
    return { kind: 'error', message: `这不是会员码：请让顾客打开小程序「我的 › ${membershipName}」，扫页面上的会员码` }
  try {
    return { kind: 'found', account: await lookup(code) }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : '查找顾客失败，请稍后重试' }
  }
}
