import { useRef, useState } from 'react'
import { Text, View } from '@tarojs/components'
import { Button } from '../button'
import { useRefreshAll } from '../../hooks/query'
import type { Table } from '../../services/membership'
import { reservations, storeClock, type ReservationEntry } from '../../services/reservations'
import { staffMessage } from '../../services/staff'

/**
 * 现场页「等你处理」里的一条「顾客取消」（2026-10-27 业主定）：今天的预约被顾客自己在小程序里取消了，
 * 写清哪张桌、几点、谁、为什么，店员不用干等。点「知道了」消掉，全店一起消（谁点都算），以后几天的不在这里提醒，
 * 预约页里照样看得到。列哪些、消没消掉都以接口为准（预约视图的 customerCancellations），点完等重读。
 */
export function CancelledRow({ entry, tables }: { entry: ReservationEntry; tables: Table[] }) {
  const refreshAll = useRefreshAll()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const x = entry.reservation
  const table = tables.find((value) => value.id === x.serviceTableId)
  const place = table
    ? `${table.code || `${table.number} 号桌`}${table.seatCount > 1 ? `-${x.seatNumber}` : ''}`
    : '桌位待核对'
  const done = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await reservations.action({ action: 'acknowledge', targetId: x.id })
      void refreshAll()
    } catch (failure) {
      setError(staffMessage(failure))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <View className="workbench-row workbench-cancelled">
      <View className="workbench-dot workbench-dot-warning" />
      <View className="workbench-row-copy">
        <Text className="workbench-row-title">
          顾客取消 {place} · 今天 {storeClock(x.startAt)}–{storeClock(entry.endAt)}
        </Text>
        <Text className="workbench-row-meta">
          {entry.customerName || '顾客'} · {x.reason ? `原因：${x.reason}` : '没选原因'}
        </Text>
        {error && (
          <View className="field-error" role="alert">
            {error}
          </View>
        )}
      </View>
      <Button
        className="workbench-button workbench-cancelled-ok"
        ariaLabel={`${place} 今天 ${storeClock(x.startAt)} 的预约顾客取消了，知道了`}
        disabled={busy}
        loading={busy}
        onClick={() => void done()}
      >
        知道了
      </Button>
    </View>
  )
}
