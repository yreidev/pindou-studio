import { useEffect } from 'react'
import { useCustomer } from '../../hooks/customer'
import { useCustomerQuery, usePageVisible } from '../../hooks/query'
import { messages } from '../../services/messages'
import { messageRedDot } from '../../services/message-indicator'

/** 顾客页面显示时同步「我的」红点，查询和身份隔离沿用现有缓存。 */
export function MessageBadge() {
  const auth = useCustomer()
  const visible = usePageVisible()
  const feed = useCustomerQuery(['messages-preview'], messages.preview)
  useEffect(() => {
    if (!visible) return
    if (auth.status !== 'authenticated') void messageRedDot(false)
    else void messageRedDot((feed.data?.unreadCount || 0) > 0)
  }, [visible, auth.status, auth.account?.id, feed.data])
  return null
}
