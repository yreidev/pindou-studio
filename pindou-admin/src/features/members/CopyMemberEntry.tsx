import { Banner, Button, Toast } from '@douyinfe/semi-ui'
import { useState } from 'react'
import type { LoyaltyEntry } from '../../api/members'
import { memberCopy } from './copy'

export function CopyMemberEntry({
  entry,
  entries,
  success = false,
}: {
  entry: LoyaltyEntry
  entries: LoyaltyEntry[]
  success?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const text = memberCopy(entry, entries)
  if (!text) return null
  const button = (
    <Button
      size="small"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await navigator.clipboard.writeText(text)
          Toast.success('已复制，去微信粘贴给顾客')
        } catch {
          Toast.error('复制失败，请允许浏览器使用剪贴板后重试')
        } finally {
          setBusy(false)
        }
      }}
    >
      复制给顾客
    </Button>
  )
  return success ? (
    <Banner
      type="success"
      closeIcon={null}
      style={{ marginBottom: 12 }}
      title="已登记"
      description={
        <div>
          <div style={{ whiteSpace: 'pre-line', marginBottom: 8 }}>{text}</div>
          {button}
        </div>
      }
    />
  ) : (
    button
  )
}
