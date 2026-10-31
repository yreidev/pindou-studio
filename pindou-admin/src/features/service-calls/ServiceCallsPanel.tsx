import { IconBell } from '@douyinfe/semi-icons'
import { Badge, Banner, Button, Card, List, Space, Spin, Toast, Typography } from '@douyinfe/semi-ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type CSSProperties } from 'react'
import { ApiError } from '../../api/client'
import { openServiceCallsQuery, serviceCallsApi, type ServiceCall } from '../../api/service-calls'
import { useCallAlerts } from './CallAlerts'
import { loadSession } from '../../session'
import { callerName, callPlace, claimNote, waitedLabel } from './calls'
import './service-calls.css'

/** 「N 分钟前」每隔多久跟着走一次。 */
const tickMs = 30_000

/**
 * 「呼叫店员」面板：还没处理的呼叫（桌位编码、座号、顾客、叫了多久、谁在处理）和「我去处理」「已处理」按钮。
 * 放在现场看板侧栏的第一格（柜台电脑常开的就是那一页），卡片留白跟看板的其他侧栏卡片一致，由调用方传入。
 *
 * - 状态只以接口为准：和全站的呼叫提醒（CallAlerts.tsx）共用同一个查询，实时事件到达时重读，另外每 30 秒重读一次
 *   （过期、认领满 10 分钟失效都是后端按时间算的）；不在前端推算，也不做乐观更新（点了按钮等重读后才变）。
 * - 「我去处理」：谁先认领算谁，认领后这一条写「阿贝 正在处理 · 2 分钟前」、只留「已处理」，所有员工那里不再响；
 *   别人先认领了时提示后端的「XX 已在处理」。认领满 10 分钟还没处理的写「阿贝 12 分钟前说去处理，还没处理」，重新给「我去处理」。
 * - 新呼叫的提示、提示音、系统通知都由全站提醒发，这里不再另外提醒，免得看板页上响两次；头部的「提醒设置」打开同一个设置。
 */
export function ServiceCallsPanel({
  className,
  style,
  headerStyle,
  bodyStyle,
}: {
  className?: string
  style?: CSSProperties
  headerStyle?: CSSProperties
  bodyStyle?: CSSProperties
}) {
  const queryClient = useQueryClient()
  const query = useQuery(openServiceCallsQuery())
  const alerts = useCallAlerts()
  const now = useNow(tickMs)

  const handle = useMutation({
    mutationFn: (call: ServiceCall) => serviceCallsApi.handle(call.id),
    onSuccess: (call) => {
      Toast.success(`${callPlace(call)} 的呼叫已处理`)
      void queryClient.invalidateQueries()
    },
    onError: (error) => Toast.error(error.message),
  })
  const claim = useMutation({
    mutationFn: (call: ServiceCall) => serviceCallsApi.claim(call.id),
    onSuccess: (call) => {
      Toast.success(`${callPlace(call)} 的呼叫已认领`)
      void queryClient.invalidateQueries()
    },
    onError: (error) => {
      // 别人先认领了、已经处理了：不算出错，说清楚是谁，列表随后重读
      if (error instanceof ApiError && (error.code === 'service_call_claimed' || error.code === 'service_call_closed'))
        Toast.warning(error.message)
      else Toast.error(error.message)
      void queryClient.invalidateQueries()
    },
  })
  const busy = handle.isPending || claim.isPending

  const calls = query.data ?? []
  const at = Math.max(now, query.dataUpdatedAt)
  return (
    <Card
      className={className ? `service-calls-panel ${className}` : 'service-calls-panel'}
      style={style}
      headerStyle={headerStyle}
      bodyStyle={bodyStyle}
      // 标题带了个数：自己包 6 级标题（传节点时 Semi 不再套标题），个数用徽标（同看板其他侧栏）
      title={
        <Space>
          <Typography.Title heading={6} style={{ margin: 0 }}>
            呼叫店员
          </Typography.Title>
          {calls.length > 0 ? <Badge count={calls.length} type="danger" /> : null}
        </Space>
      }
      headerExtraContent={
        alerts ? (
          <Button
            size="small"
            theme="borderless"
            type="tertiary"
            icon={<IconBell />}
            aria-label="提醒设置"
            onClick={alerts.openSettings}
          >
            提醒设置
          </Button>
        ) : null
      }
    >
      {query.isPending ? (
        <div className="service-calls-loading">
          <Spin />
        </div>
      ) : query.isError && query.data === undefined ? (
        <Banner
          type="danger"
          closeIcon={null}
          description={
            <span>
              {query.error.message}{' '}
              <Button size="small" theme="borderless" onClick={() => void query.refetch()}>
                重试
              </Button>
            </span>
          }
        />
      ) : (
        <>
          {query.isError ? (
            <Banner
              type="warning"
              closeIcon={null}
              description="刚才重新读取失败，下面是上一次读到的呼叫。"
              style={{ marginBottom: 8 }}
            />
          ) : null}
          <List
            size="small"
            dataSource={calls}
            emptyContent={<Typography.Text type="tertiary">暂时没有顾客呼叫</Typography.Text>}
            renderItem={(call) => {
              const place = callPlace(call)
              const note = claimNote(call, at, loadSession()?.user.id)
              // 有人认领着：不再给「我去处理」（谁先认领算谁），「已处理」照旧谁都能点
              const claimed = call.claimStatus === 'claimed'
              return (
                <List.Item
                  key={call.id}
                  data-service-call={call.id}
                  main={
                    <div className="service-call-main">
                      <Typography.Text strong>{place}</Typography.Text>
                      <Typography.Text type="tertiary" size="small">
                        {callerName(call)} · {waitedLabel(call.createdAt, at)}
                      </Typography.Text>
                      {note ? (
                        <Typography.Text type={note.claimed ? 'success' : 'warning'} size="small">
                          {note.text}
                        </Typography.Text>
                      ) : null}
                      <div className="service-call-actions">
                        {claimed ? null : (
                          <Button
                            size="small"
                            aria-label={`${place} 我去处理`}
                            disabled={busy}
                            loading={claim.isPending && claim.variables?.id === call.id}
                            onClick={() => claim.mutate(call)}
                          >
                            我去处理
                          </Button>
                        )}
                        <Button
                          theme="solid"
                          size="small"
                          aria-label={`${place} 已处理`}
                          disabled={busy}
                          loading={handle.isPending && handle.variables?.id === call.id}
                          onClick={() => handle.mutate(call)}
                        >
                          已处理
                        </Button>
                      </div>
                    </div>
                  }
                />
              )
            }}
          />
        </>
      )}
    </Card>
  )
}

/** 现在的时间，每隔 intervalMs 更新一次（「N 分钟前」用）。 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
