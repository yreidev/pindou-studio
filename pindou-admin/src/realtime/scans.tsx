import { Notification, Typography } from '@douyinfe/semi-ui'
import { useEffect, useRef } from 'react'

// 手机当扫码枪（2026-10-06）：员工在小程序「扫码给电脑」扫到的码，经事件流只推给本人的网页
// （{"type":"scan.relayed","code":"…"}，见 docs/api.yaml /scan-relays），由这里交给当前页面里认得它的地方：
// 收货入库按条码加商品，结账页、会员资产页、选顾客的下拉框按会员码选人。都不认的，右下角提示「手机扫到：…」可复制，
// 不打断正在做的事。码只在内存里过一下，不存。

/** 认领一个码：认得就处理（可以是异步的）并返回 true；不认得返回 false，交给下一个。 */
export type ScanClaim = (code: string) => boolean

const claims: { claim: ScanClaim }[] = []

/** 会员码的样子：首位 9 的 20 位数字（docs/api.yaml MemberCode）。扫码枪带进来的首尾空白不算。 */
export const isMemberCode = (text: string) => /^9[0-9]{19}$/.test(text.trim())

/**
 * 搜索框里扫进来的会员码：整串就是，或者扫码枪接在框里原有文字后面打进来的（紧挨着的前一个字不是数字）。
 * 没有返回空串。
 */
export function memberCodeIn(text: string): string {
  return text.trim().match(/(?:^|\D)(9[0-9]{19})$/)?.[1] ?? ''
}

/** 商品条码的样子（同后端）：1–64 个可打印 ASCII，不含空格。 */
export const isBarcode = (text: string) => /^[!-~]{1,64}$/.test(text.trim()) && !isMemberCode(text)

/** 把手机转来的码交给页面：后挂上的先看（弹窗里的选顾客框比页面本身更具体），有人认领返回 true。 */
export function dispatchScan(code: string): boolean {
  for (let i = claims.length - 1; i >= 0; i--) if (claims[i].claim(code)) return true
  return false
}

/**
 * 页面或组件挂上时登记认领手机转来的码，卸下时撤掉。claim 为 null 时不认领（例如这张单不能换顾客、下拉框禁用）。
 * claim 每次渲染都可以是新的函数，总是调用最新的那个，不用重新登记。
 */
export function useScanRelay(claim: ScanClaim | null): void {
  const latest = useRef(claim)
  useEffect(() => {
    latest.current = claim
  })
  const enabled = claim !== null
  useEffect(() => {
    if (!enabled) return
    const entry = { claim: (code: string) => latest.current?.(code) ?? false }
    claims.push(entry)
    return () => {
      const index = claims.indexOf(entry)
      if (index >= 0) claims.splice(index, 1)
    }
  }, [enabled])
}

/** 当前页面用不上的码：右下角提示（不挡右上角的呼叫店员提醒），8 秒后自己收起，码可以复制。 */
export function showUnclaimedScan(code: string): void {
  const member = isMemberCode(code)
  Notification.info({
    title: '手机扫到',
    position: 'bottomRight',
    duration: 8,
    content: (
      <div>
        <Typography.Text copyable={{ content: code, copyTip: '复制' }} style={{ wordBreak: 'break-all' }}>
          {member ? `会员码 ${code}` : code}
        </Typography.Text>
        <div>
          <Typography.Text type="tertiary" size="small">
            {member
              ? '这一页用不上会员码：在结账页、会员资产页或选顾客的框里会直接选中这位顾客。'
              : '这一页用不上这个码：收货入库会按条码加商品。'}
          </Typography.Text>
        </div>
      </div>
    ),
  })
}

/** 事件流转来一个码：交给页面，没人认领就提示。 */
export function receiveScan(code: string): void {
  if (!dispatchScan(code)) showUnclaimedScan(code)
}
