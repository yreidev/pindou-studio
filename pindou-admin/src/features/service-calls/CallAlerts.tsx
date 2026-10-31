import { Banner, Button, Notification, Toast, Typography } from '@douyinfe/semi-ui'
import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { openServiceCallsQuery, type ServiceCall } from '../../api/service-calls'
import { loadSession } from '../../session'
import { CallAlertCenter } from './alert-center'
import { loadAlertPrefs, saveAlertPrefs, type AlertPrefs } from './alert-prefs'
import { AlertSettings } from './AlertSettings'
import { alertKey, callerName, callPlace, claimNote } from './calls'
import { Chime, unlockOnFirstInteraction } from './chime'
import { showCallNotification } from './system-notification'
import { TitleAlert } from './tab-title'
import './service-calls.css'

/** 兜底重读间隔：实时连接断了、事件漏了也不至于一直不知道；后台也照样读。 */
const refreshMs = 30_000

/** 页面里的呼叫提示只有一条，来了新的就更新它。 */
const inPageId = 'service-call-alert'

// 右上角提示放在顶栏下面：它可能一直留着，别挡住顶栏的实时状态和账户菜单（「提醒设置」在那里）。
// 全站只有呼叫提醒用 Notification，按 Semi 的说法在第一次弹出前全局配置一次。
Notification.config({ top: 72 })

interface CallAlertsValue {
  /** 打开「提醒设置」。 */
  openSettings: () => void
}

const CallAlertsContext = createContext<CallAlertsValue | null>(null)

/** 「提醒设置」入口用；不在全站提醒里面（单独测试面板时）返回 null。 */
export function useCallAlerts(): CallAlertsValue | null {
  return useContext(CallAlertsContext)
}

/**
 * 全站的呼叫店员提醒，挂在登录后的布局上：不论停在哪一页、标签页在不在前台，顾客一呼叫就提醒。
 *
 * - 一直订着未处理的呼叫：呼叫事件到达时后台也立刻重读（openServiceCallsQuery 的 realtimeInBackground），
 *   另外每 30 秒兜底重读一次，后台也读。
 * - 新到的呼叫（打开页面时已挂着的不算）：右上角弹提示（不在看板页时一直留着，处理掉或关掉才收；在看板页响停了几秒后自己收，
 *   看板的呼叫栏已经列着）；提示音开着就按设置的时长和音量响（持续响时提示上有「知道了」）；页面不在眼前且允许了系统通知
 *   就弹系统通知；标签页在后台时标题闪「(N) 新呼叫」。什么时候停见 alert-center.ts。
 * - 有员工点了「我去处理」（网页或手机，包括自己）的呼叫不再提醒：提示收起、铃声停；认领满 10 分钟还没处理的当作新到重新提醒。
 * - 提示音要等打开页面后第一次点击或按键才能出声（浏览器规定），在那之前页面顶部挂一条不挡操作的提示。
 * - 偏好按浏览器存（alert-prefs.ts），由「提醒设置」弹窗修改。
 */
export function CallAlertsProvider({
  children,
  onBoard,
  onOpenBoard,
  chime,
}: {
  children: ReactNode
  /** 现在是不是在「现场」看板页。 */
  onBoard: boolean
  /** 跳到「现场」看板（点提示、点系统通知时）。 */
  onOpenBoard: () => void
  /** 测试换上假的声音。 */
  chime?: Chime
}) {
  const [prefs, setPrefs] = useState(loadAlertPrefs)
  const [player] = useState(() => chime ?? new Chime())
  const [soundReady, setSoundReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const query = useQuery({
    ...openServiceCallsQuery(),
    refetchInterval: refreshMs,
    refetchIntervalInBackground: true,
  })

  // 提醒在事件回调里发，读的是当时的偏好和页面，不随每次渲染重建
  const latest = useRef({ prefs, onBoard, onOpenBoard })
  useEffect(() => {
    latest.current = { prefs, onBoard, onOpenBoard }
  })

  // 提醒中心随这个布局挂上、卸下（退出登录时关掉弹出去的通知、恢复标题）。要排在读数据的 effect 前面。
  const center = useRef<CallAlertCenter | null>(null)
  useEffect(() => {
    const title = new TitleAlert()
    const alerts: CallAlertCenter = new CallAlertCenter({
      prefs: () => latest.current.prefs,
      doc: document,
      sound: () => {
        player.play(latest.current.prefs.volume)
        // 浏览器把声音停掉了（少见）：重新挂出「点一下开启」
        if (!player.enabled) setSoundReady(false)
      },
      // 点了系统通知就算知道了：停止响铃，去「现场」
      systemNotify: (call) =>
        showCallNotification(call, () => {
          alerts.acknowledge()
          latest.current.onOpenBoard()
        }),
      showInPage: (calls, ringing) =>
        showInPageAlert(calls, {
          ringing,
          onBoard: latest.current.onBoard,
          onOpenBoard: () => latest.current.onOpenBoard(),
          onAcknowledge: () => alerts.acknowledge(),
          onDismiss: () => alerts.dismissInPage(),
          onForget: () => alerts.forgetInPage(),
        }),
      title: (count) => title.show(count),
    })
    center.current = alerts
    const onVisibility = () => alerts.visibilityChanged()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      alerts.dispose()
      center.current = null
    }
  }, [player])

  useEffect(() => {
    if (query.data) center.current?.update(query.data)
  }, [query.data])

  // 到了看板页，呼叫栏已经列着：收起页面里的提示（正在响时留着，上面有「知道了」）
  useEffect(() => {
    if (onBoard) center.current?.enteredBoard()
  }, [onBoard])

  // 打开页面后第一次点击或按键时唤醒提示音
  useEffect(() => {
    if (!prefs.sound || soundReady || !player.supported) return
    return unlockOnFirstInteraction(player, () => setSoundReady(true))
  }, [prefs.sound, soundReady, player])

  useEffect(() => () => player.disable(), [player])

  // 授权弹窗等人回答后才回来改，按当时最新的偏好合并
  const changePrefs = (patch: Partial<AlertPrefs>) => {
    const next = { ...latest.current.prefs, ...patch }
    latest.current = { ...latest.current, prefs: next }
    saveAlertPrefs(next)
    setPrefs(next)
    // 关了提示音就停；改了时长按新时长算
    center.current?.prefsChanged()
  }

  // 在点击里唤醒声音，按现在的音量响一轮（开关、试听）
  const testSound = () => {
    void player.enable().then((ok) => {
      setSoundReady(ok)
      if (ok) player.play(latest.current.prefs.volume)
      else Toast.warning('这个浏览器放不出提示音，请留意页面上的提示')
    })
  }

  return (
    <CallAlertsContext.Provider value={{ openSettings: () => setSettingsOpen(true) }}>
      {children}
      {prefs.sound && !soundReady && player.supported ? (
        <div className="call-alert-hint no-print">
          <Banner type="warning" fullMode={false} bordered closeIcon={null} description="点一下页面任意处开启提示音" />
        </div>
      ) : null}
      <AlertSettings
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        prefs={prefs}
        onPrefsChange={changePrefs}
        soundReady={soundReady}
        soundSupported={player.supported}
        onTestSound={testSound}
      />
    </CallAlertsContext.Provider>
  )
}

/**
 * 页面右上角的呼叫提示（Semi Notification，同一个 id 来了新的就更新）。
 * 不在看板页时一直留着，直到呼叫被处理（列表里没了）或人点了关闭、点了「去现场处理」；正在持续响时上面有「知道了」。
 *
 * 在看板页只写标题（哪桌、几位），谁在叫由旁边的呼叫栏列着：持续响时提示一直留着，只有一行标题和「知道了」，
 * 不会长高挡住呼叫栏里的「已处理」；响停了几秒后自己收起，也不再记着。
 */
function showInPageAlert(
  calls: ServiceCall[],
  {
    ringing,
    onBoard,
    onOpenBoard,
    onAcknowledge,
    onDismiss,
    onForget,
  }: {
    ringing: boolean
    onBoard: boolean
    onOpenBoard: () => void
    /** 「知道了」：停止响铃，提示留着。 */
    onAcknowledge: () => void
    /** 关掉提示、去「现场」：不再列着，也不再响。 */
    onDismiss: () => void
    /** 在看板上提示过了：不再记着。 */
    onForget: () => void
  },
) {
  if (calls.length === 0) {
    Notification.close(inPageId)
    return
  }
  if (onBoard && !ringing) onForget()
  const acknowledge = ringing ? (
    <Button size="small" theme="solid" onClick={onAcknowledge}>
      知道了
    </Button>
  ) : null
  Notification.warning({
    id: inPageId,
    title: calls.length === 1 ? `${callPlace(calls[0])} 呼叫店员` : `${calls.length} 位顾客呼叫店员`,
    content: onBoard ? (
      acknowledge
    ) : (
      <div className="call-alert-list">
        {calls.map((call) => {
          // 认领满 10 分钟还没处理、重新提醒的：写上是谁说去了还没处理
          const note = claimNote(call, Date.now(), loadSession()?.user.id)
          return (
            <Typography.Text key={alertKey(call)}>
              {calls.length === 1 ? `顾客：${callerName(call)}` : `${callPlace(call)} · ${callerName(call)}`}
              {note && !note.claimed ? `（${note.text}）` : ''}
            </Typography.Text>
          )
        })}
        <div className="call-alert-actions">
          {acknowledge}
          <Typography.Text
            link
            onClick={() => {
              onDismiss()
              Notification.close(inPageId)
              onOpenBoard()
            }}
          >
            去「现场」处理
          </Typography.Text>
        </div>
      </div>
    ),
    theme: 'light',
    // 在看板上、没在响：几秒后自己收起；更新同一个 id 时 Semi 按新的时长重新计时
    duration: onBoard && !ringing ? 6 : 0,
    onCloseClick: onDismiss,
  })
}
