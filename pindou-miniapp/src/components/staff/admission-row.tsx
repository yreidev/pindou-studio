import { useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../button'
import { CouponFields } from '../coupon-fields'
import { useRefreshAll } from '../../hooks/query'
import { loyalty, type Admission, type Table } from '../../services/membership'
import {
  couponDraftOf,
  couponInput,
  couponProblem,
  couponReminder,
  couponText,
  sameCoupon,
  type CouponDraft,
} from '../../services/coupon'
import { packageDuration } from '../../services/packages'
import { money } from '../../services/format'
import { staffMessage } from '../../services/staff'
import { storeClock } from '../../services/reservations'

/**
 * 「13:18 申请，再过 18 分钟失效」：失效时刻用后端给的 expiresAt（申请时刻加确认时限），这里不记时限。
 * 读不到申请时间时只写「等你确认」，读不到失效时刻时只写几点申请。
 */
export function admissionDeadline(createdAt: string | undefined, expiresAt: string | undefined, now: number): string {
  if (!createdAt) return '等你确认'
  if (!expiresAt) return `${storeClock(createdAt)} 申请`
  const left = Math.ceil((Date.parse(expiresAt) - now) / 60000)
  return `${storeClock(createdAt)} 申请，${left > 0 ? `再过 ${left} 分钟失效` : '马上失效'}`
}

/**
 * 现场页「等你处理」里的一条扫码入座申请：直接「确认开始计时 / 改团购 / 拒绝」（2026-10-20，原先在「会员与计时 › 计时」）。
 * 顾客申请时填的团购写在这一条上，确认前可以改：没改不带（保留顾客填的），清空时带空平台。
 * ★ 看 displayStatus：过期的申请 status 仍是 pending，这里只给 displayStatus 为 pending 的。
 */
export function AdmissionRow({
  entry,
  tables,
  billing,
  now,
}: {
  entry: Admission
  tables: Table[]
  billing: boolean
  now: number
}) {
  const refreshAll = useRefreshAll()
  const [coupon, setCoupon] = useState<CouponDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const a = entry.admission
  const table = tables.find((value) => value.id === a.serviceTableId)
  const place = table
    ? `${table.code || `${table.number} 号桌`}${table.seatCount > 1 ? ` ${a.seatNumber} 号座` : ''}`
    : '桌位待核对'
  const act = async (run: () => Promise<boolean>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      if (await run()) {
        setCoupon(null)
        void refreshAll()
      }
    } catch (failure) {
      setError(staffMessage(failure))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const confirm = () =>
    act(async () => {
      if (coupon && couponProblem(coupon)) return false
      const changed = !!coupon && !sameCoupon(couponInput(coupon), a.coupon)
      const what = billing
        ? `${packageDuration(a.package)}，¥${money(a.package.amountCents)}`
        : packageDuration(a.package)
      const answer = await Taro.showModal({
        title: '确认开台',
        content: `${place} 开始计时：${what}？`,
        confirmText: '开始计时',
      })
      if (!answer.confirm) return false
      await loyalty.action({
        action: 'confirm',
        targetId: a.id,
        ...(changed ? { coupon: couponInput(coupon!) ?? { platform: '', code: '' } } : {}),
      })
      void Taro.showToast({ title: '已开始计时', icon: 'success' })
      return true
    })
  const reject = () =>
    act(async () => {
      const answer = await Taro.showModal({
        title: '拒绝申请',
        content: `拒绝 ${entry.customer?.nickname || '顾客'} 在 ${place} 的入座申请？顾客要重新扫码申请。`,
        confirmText: '拒绝',
      })
      if (!answer.confirm) return false
      await loyalty.action({ action: 'reject', targetId: a.id })
      return true
    })
  const reminder = couponReminder(a.coupon)
  return (
    <View className="workbench-admission">
      <View className="workbench-admission-head">
        <Text className="workbench-tag">扫码入座</Text>
        <View className="workbench-admission-copy">
          <Text className="workbench-row-title">
            {place} · {entry.customer?.nickname || '顾客'} · {packageDuration(a.package)}
          </Text>
          <Text className="workbench-row-meta">
            {a.coupon ? `${couponText(a.coupon)}${reminder ? `（${reminder}）` : ''} · ` : ''}
            {admissionDeadline(a.createdAt, entry.expiresAt, now)}
          </Text>
        </View>
      </View>
      {coupon && <CouponFields value={coupon} onChange={setCoupon} disabled={busy} />}
      <View className="workbench-admission-actions">
        <Button
          className="workbench-button workbench-button-dark"
          disabled={busy || (!!coupon && !!couponProblem(coupon))}
          loading={busy}
          onClick={() => void confirm()}
        >
          确认开始计时
        </Button>
        {!coupon && (
          <Button className="workbench-button" disabled={busy} onClick={() => setCoupon(couponDraftOf(a.coupon))}>
            {a.coupon ? '改团购' : '填团购'}
          </Button>
        )}
        <Button className="workbench-button workbench-button-quiet" disabled={busy} onClick={() => void reject()}>
          拒绝
        </Button>
      </View>
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </View>
  )
}
