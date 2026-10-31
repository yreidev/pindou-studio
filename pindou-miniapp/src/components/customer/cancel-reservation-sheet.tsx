import { Text, Textarea, View } from '@tarojs/components'
import { useState } from 'react'
import { Button } from '../button'
import { SheetCloseButton, SheetFrame } from '../sheet'

// 顾客取消预约（2026-10-27 业主定）：不再点一下就取消，先从底下弹出来，必须选一个原因，选「其他」要写一句。
// 原因记进这条预约，员工在现场页的「顾客取消」提醒和预约记录里看得到。后端不强制原因（旧版小程序取消时不带）。

/** 常用的取消原因，顾客点选；「其他」要自己写一句。 */
export const cancelReasons = ['临时有事来不了', '想换个时间', '约错了', '其他'] as const
type CancelReason = (typeof cancelReasons)[number]

/** 选「其他」时写的那一句最多几个字 */
const otherMaxLength = 60

/** 要提交的原因：选了常用的就是它；选「其他」是写的那一句（去掉首尾空白），没写是空串。 */
export function cancelReasonText(choice: CancelReason | '', other: string) {
  return choice === '其他' ? other.trim() : choice
}

export function CancelReservationSheet({
  when,
  what,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  /** 哪天几点：「今天 · 10 月 28 日 周三 14:00–16:00」 */
  when: string
  /** 座位和时长：「B3 · 2 小时」 */
  what: string
  busy: boolean
  error: string
  onConfirm: (reason: string) => void
  onClose: () => void
}) {
  const [choice, setChoice] = useState<CancelReason | ''>('')
  const [other, setOther] = useState('')
  const reason = cancelReasonText(choice, other)
  return (
    <SheetFrame
      mask="cancel-sheet-mask"
      panel="cancel-sheet"
      label="取消这次预约"
      locked={busy}
      dirty={!!other.trim()}
      onClose={onClose}
      head={<Text className="cancel-sheet-title">取消这次预约？</Text>}
    >
      <View className="cancel-sheet-summary">
        <Text className="cancel-sheet-when">{when}</Text>
        <Text className="cancel-sheet-what">{what}</Text>
      </View>
      <Text className="cancel-sheet-question">为什么取消（必选）</Text>
      <View className="cancel-sheet-reasons">
        {cancelReasons.map((item) => (
          <Button
            key={item}
            className={`cancel-sheet-reason ${choice === item ? 'cancel-sheet-reason-on' : ''}`}
            disabled={busy}
            ariaLabel={`${item}${choice === item ? '，已选中' : ''}`}
            onClick={() => setChoice(item)}
          >
            {item}
          </Button>
        ))}
      </View>
      {choice === '其他' && (
        <Textarea
          className="input cancel-sheet-other"
          maxlength={otherMaxLength}
          disabled={busy}
          value={other}
          placeholder="选「其他」时写一句（必填）"
          cursorSpacing={96}
          onInput={(event) => setOther(event.detail.value)}
        />
      )}
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
      <View className="cancel-sheet-actions">
        <SheetCloseButton className="cancel-sheet-keep" ariaLabel="再想想，不取消" disabled={busy}>
          再想想
        </SheetCloseButton>
        <Button
          className="cancel-sheet-confirm"
          ariaLabel={reason ? '确认取消这次预约' : '确认取消，先选一个原因'}
          disabled={!reason || busy}
          loading={busy}
          onClick={() => onConfirm(reason)}
        >
          确认取消
        </Button>
      </View>
    </SheetFrame>
  )
}
