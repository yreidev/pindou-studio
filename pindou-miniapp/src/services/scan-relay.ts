import Taro from '@tarojs/taro'
import type { operations } from '../api/schema'
import { isMemberCode } from './member-code'
import { request, StaffError } from './staff'
import { parseWebLoginQr } from './web-login'

// 手机当扫码枪（2026-10-06 业主决定）：员工在「扫码给电脑」扫商品条码或顾客的会员码，扫到的内容经后端
// 马上转给本人此刻开着的电脑网页后台（网页用这位员工的手机扫码登录）。只到本人的网页，不给别人；
// 码不落库，电脑那一刻没开着就收不到，手机上说「电脑没在线」（docs/api.yaml /scan-relays）。

type Relayed = operations['relayScan']['responses'][200]['content']['application/json']

/** 内容上限，和后端一致。 */
export const maxRelayedCode = 256

export const scanRelay = {
  send: (code: string) => request<Relayed>('/scan-relays', 'POST', { code } satisfies { code: string }),
}

export type RelayKind = 'member' | 'barcode' | 'other'

/** 扫到的是什么：会员码、商品条码（1–64 个可打印 ASCII），其余（网址、中文……）照样转，电脑上只提示。 */
export function relayKind(code: string): RelayKind {
  if (isMemberCode(code)) return 'member'
  return code.length <= 64 && /^[!-~]+$/.test(code) ? 'barcode' : 'other'
}

export type RelayOutcome =
  | { kind: 'cancelled' }
  /** 已经转给电脑（computers 是收到的网页个数）。 */
  | { kind: 'sent'; code: string; computers: number }
  /** 本人没有开着的网页后台：什么也没发。 */
  | { kind: 'offline'; code: string; message: string }
  | { kind: 'error'; code: string; message: string }

type ScanResult = { result?: string; path?: string }

/** 换行、制表符这类控制字符（后端同样拒收）。 */
const hasControl = (text: string) =>
  [...text].some((ch) => {
    const point = ch.codePointAt(0) ?? 0
    return point < 0x20 || (point >= 0x7f && point <= 0x9f)
  })

/** 扫一个码（一维条码、二维码都收，只用相机）并转给本人的电脑。取消扫码不提示，其余结果都有要显示的话。 */
export async function scanAndRelay(
  scan: () => Promise<ScanResult> = () => Taro.scanCode({ onlyFromCamera: true, scanType: ['barCode', 'qrCode'] }),
  send: (code: string) => Promise<Relayed> = scanRelay.send,
): Promise<RelayOutcome> {
  let scanned: ScanResult
  try {
    scanned = await scan()
  } catch (error) {
    if (/cancel/.test((error as { errMsg?: string } | undefined)?.errMsg || '')) return { kind: 'cancelled' }
    return { kind: 'error', code: '', message: '没有扫到，请对准条码或二维码再试一次' }
  }
  const code = (scanned.result || '').trim()
  if (parseWebLoginQr(code) || /web-login/.test(scanned.path || ''))
    return { kind: 'error', code: '', message: '这是电脑后台的登录码：请回工作台点「扫码登录电脑」扫它' }
  if (!code) return { kind: 'error', code: '', message: '扫到的是小程序码或空内容，不能转给电脑' }
  if ([...code].length > maxRelayedCode || hasControl(code))
    return { kind: 'error', code: code.slice(0, 64), message: '扫到的内容太长或带换行，不能转给电脑' }
  try {
    const { computers } = await send(code)
    return { kind: 'sent', code, computers }
  } catch (error) {
    if (error instanceof StaffError && error.code === 'computer_offline')
      return {
        kind: 'offline',
        code,
        message: '电脑没在线：先在电脑上打开网页后台（用你这个账号扫码登录），再扫一次',
      }
    return { kind: 'error', code, message: error instanceof Error ? error.message : '没能发给电脑，请稍后重试' }
  }
}
