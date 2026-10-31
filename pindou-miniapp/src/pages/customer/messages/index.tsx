import { useEffect, useRef, useState } from 'react'
import { useDidHide, useUnload } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { Button } from '../../../components/button'
import { AuthBoundary, Failure, RefreshNotice, Screen, Skeleton } from '../../../components/customer'
import { LedgerIcon } from '../../../components/customer/ledger-icon'
import { useCustomer } from '../../../hooks/customer'
import { useCustomerQuery, usePageVisible, useRefreshAll } from '../../../hooks/query'
import { customerMessage } from '../../../services/customer'
import { reservations } from '../../../services/reservations'
import { messageDays, messages, messageText } from '../../../services/messages'
import { navigateApp } from '../../../services/navigation'
import { messagesTitle } from '../../../brand'
import './index.scss'

export default function Messages() {
  const auth = useCustomer()
  const visible = usePageVisible()
  const resource = useCustomerQuery(['messages'], messages.me, { live: true })
  const bookings = useCustomerQuery(['reservations'], reservations.me, {
    enabled: !!resource.data?.items.some((item) => item.reservation),
  })
  const refreshAll = useRefreshAll()
  const [unread, setUnread] = useState<Set<string>>(new Set())
  const [count, setCount] = useState(0)
  const [readError, setReadError] = useState('')
  const visit = useRef({ account: '', started: false, pending: false, marked: false, generation: 0 })
  const markRead = async () => {
    if (visit.current.pending) return
    const generation = visit.current.generation
    visit.current.pending = true
    setReadError('')
    try {
      await messages.markRead()
      if (generation === visit.current.generation) {
        visit.current.marked = true
        setUnread(new Set())
        setCount(0)
      }
      await refreshAll()
    } catch (error) {
      if (generation === visit.current.generation) setReadError(customerMessage(error, '未能标记已读，请重试'))
    } finally {
      if (generation === visit.current.generation) visit.current.pending = false
    }
  }
  useEffect(() => {
    const id = auth.account?.id || ''
    if (!visible || visit.current.account !== id) {
      visit.current = {
        account: id,
        started: false,
        pending: false,
        marked: false,
        generation: visit.current.generation + 1,
      }
      setUnread(new Set())
      setCount(0)
    }
    if (!visible || !resource.data || auth.status !== 'authenticated') return
    visit.current.started = true
    if (resource.data.unreadCount > 0) visit.current.marked = false
    setUnread(new Set(resource.data.items.filter((item) => item.unread).map((item) => item.id)))
    setCount(resource.data.unreadCount)
    // 手动标记成功后立即清红点；未点击则在隐藏或卸载时提交。
  }, [visible, auth.account?.id, auth.status, resource.data])
  const leave = () => {
    if (visit.current.started && !visit.current.marked) void markRead()
  }
  useDidHide(leave)
  useUnload(leave)
  const feed = resource.data
  return (
    <Screen navigationHeight={44} title={messagesTitle} back className="messages-screen">
      <AuthBoundary>
        <View className="messages-content">
          {resource.loading ? (
            <Skeleton />
          ) : !feed ? (
            <Failure error={resource.error} retry={() => void resource.refresh()} />
          ) : (
            <>
              {!!resource.error && <RefreshNotice retry={() => void resource.refresh()} />}
              {!!readError && (
                <View className="inline-error" role="alert">
                  {readError}
                  <Button className="text-button" onClick={() => void markRead()}>
                    重试标记已读
                  </Button>
                </View>
              )}
              {feed.items.length ? (
                <>
                  <View className="messages-read-row">
                    <Text>{count} 条未读</Text>
                    <Button className="text-button" onClick={() => void markRead()}>
                      全部标为已读
                    </Button>
                  </View>
                  {messageDays(feed.items).map((group) => (
                    <View className="messages-day" key={group.key}>
                      <Text className="messages-day-title">{group.title}</Text>
                      <View className="messages-list">
                        {group.items.map((item) => {
                          const text = messageText(
                            item,
                            bookings.data?.tables || [],
                            bookings.data?.settings.graceMinutes,
                          )
                          return (
                            <Button
                              key={item.id}
                              className="message-row"
                              disabled={!text.target}
                              onClick={() => void navigateApp(text.target)}
                            >
                              <LedgerIcon kind={text.icon} />
                              <View className="message-copy">
                                <View className="message-heading">
                                  <Text className="message-title">{text.title}</Text>
                                  {unread.has(item.id) && <View className="message-unread" ariaLabel="未读" />}
                                  <Text className="message-time">{text.time}</Text>
                                </View>
                                {text.lines.map((line, i) => (
                                  <Text className={`message-line ${i ? 'message-line-secondary' : ''}`} key={i}>
                                    {line}
                                  </Text>
                                ))}
                              </View>
                            </Button>
                          )
                        })}
                      </View>
                    </View>
                  ))}
                  <Text className="messages-foot">只留最近 90 天；完整的账在「示例工坊社 › 明细」</Text>
                </>
              ) : (
                <View className="messages-empty">
                  <LedgerIcon kind="bell-empty" />
                  <Text className="messages-empty-title">还没有消息</Text>
                  <Text className="messages-empty-note">
                    预约成功或取消、到店充值、消费登记以后，都会在这里留一条。
                  </Text>
                  <Button
                    className="messages-book"
                    onClick={() => void navigateApp('/pages/customer/reservations/index')}
                  >
                    预约座位
                  </Button>
                </View>
              )}
            </>
          )}
        </View>
      </AuthBoundary>
    </Screen>
  )
}
