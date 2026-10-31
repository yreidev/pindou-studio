import { useCallback, useEffect, useRef, useState } from 'react'
import { useCustomer } from './customer'
import { usePageVisible } from './query'
import { customerMessage } from '../services/customer'
import { memberCodeRefreshMs, memberCodes, type MemberCode } from '../services/member-code'

export type MemberCodeView = {
  /** 正在显示的码；还没签发到为 null。过期了仍给出（页面盖上「已过期」），换到新码再替掉。 */
  code: string | null
  /** 码已过了有效期（按收到时起算的 validSeconds，不看手机时钟和 expiresAt 比）。 */
  expired: boolean
  /** 第一个码还没回来。 */
  loading: boolean
  /** 最近一次签发失败的说明；有码时表示换码失败、显示的还是上一个码。 */
  error: string
  /** 马上换一个码（「刷新会员码」、过期后重试）。 */
  refresh: () => void
}

/** 签发失败后多久再试一次（比正常换码勤一些：码可能快过期了）。 */
const retryMs = 15_000
// 默认参数放在模块里：每次渲染都是同一个函数，不然下面的 effect 每次渲染都会重来一轮
const clock = () => Date.now()

/**
 * 会员中心的会员码：页面显示期间每分钟换一个，离开页面、退到后台就停（不在后台白签发），回来立即换新的。
 * 换了登录身份，旧码立刻不显示。码只在内存里，不存本机。
 */
export function useMemberCode(
  issue: () => Promise<MemberCode> = memberCodes.issue,
  now: () => number = clock,
): MemberCodeView {
  const auth = useCustomer()
  const visible = usePageVisible()
  const account = auth.status === 'authenticated' ? auth.account?.id || '' : ''
  const active = visible && !!account
  const [shown, setShown] = useState<{ account: string; code: string; until: number } | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [, setTick] = useState(0)
  // 每次（重新）开始一轮都换一个编号：离开页面、换了人之后迟到的响应作废
  const round = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef(false)

  const stop = useCallback(() => {
    round.current++
    pending.current = false
    if (timer.current) clearTimeout(timer.current)
    if (expiry.current) clearTimeout(expiry.current)
    timer.current = expiry.current = null
  }, [])

  const run = useCallback(async () => {
    if (pending.current) return
    const mine = round.current
    pending.current = true
    if (timer.current) clearTimeout(timer.current)
    setLoading(true)
    try {
      const issued = await issue()
      if (mine !== round.current) return
      const until = now() + issued.validSeconds * 1000
      setShown({ account, code: issued.code, until })
      setError('')
      if (expiry.current) clearTimeout(expiry.current)
      // 到点重新渲染一次，盖上「已过期」（正常情况下这之前早已换了新码）
      expiry.current = setTimeout(() => setTick((value) => value + 1), Math.max(0, until - now()))
      timer.current = setTimeout(() => void run(), memberCodeRefreshMs)
    } catch (e) {
      if (mine !== round.current) return
      setError(customerMessage(e, '会员码暂时出不来，请检查网络后重试'))
      timer.current = setTimeout(() => void run(), retryMs)
    } finally {
      if (mine === round.current) {
        pending.current = false
        setLoading(false)
      }
    }
  }, [issue, now, account])

  useEffect(() => {
    if (!active) return
    void run()
    return stop
  }, [active, run, stop])

  const current = shown && shown.account === account ? shown : null
  return {
    code: current?.code ?? null,
    expired: !!current && now() >= current.until,
    loading: loading && !current,
    error,
    refresh: () => {
      if (!active) return
      void run()
    },
  }
}
