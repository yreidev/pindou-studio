import { Banner, Button, Modal, Radio, RadioGroup, Slider, Switch, Tag, Toast, Typography } from '@douyinfe/semi-ui'
import { useEffect, useState } from 'react'
import { ringOptions, type AlertPrefs, type RingFor } from './alert-prefs'
import { ringIntervalMs } from './ringer'
import { dialogButtons } from '../../components/confirm'
import {
  notificationState,
  requestNotificationPermission,
  showTestNotification,
  type NotificationState,
} from './system-notification'

export interface AlertSettingsProps {
  visible: boolean
  onClose: () => void
  prefs: AlertPrefs
  onPrefsChange: (patch: Partial<AlertPrefs>) => void
  /** 提示音现在能不能出声（这次打开页面后被点过一下）。 */
  soundReady: boolean
  /** 这个浏览器有没有 WebAudio。 */
  soundSupported: boolean
  /** 打开提示音开关、点试听：都在点击里唤醒声音，按现在的音量响一轮。 */
  onTestSound: () => void
}

/** 持续响时隔几秒响一轮，写在说明里。 */
const intervalSeconds = ringIntervalMs / 1000

/**
 * 「提醒设置」弹窗：提示音开关、响铃时长、音量与试听，系统通知开关与授权状态。从账户菜单和看板呼叫栏的头部打开。
 * 设置存在这台电脑的这个浏览器里（alert-prefs.ts），不进后端。
 */
export function AlertSettings({
  visible,
  onClose,
  prefs,
  onPrefsChange,
  soundReady,
  soundSupported,
  onTestSound,
}: AlertSettingsProps) {
  return (
    <Modal
      title="提醒设置"
      visible={visible}
      onCancel={onClose}
      onOk={onClose}
      okText="完成"
      // 底部按钮的读屏名用按钮上的字（Semi 默认写死英文 confirm）
      okButtonProps={dialogButtons.okButtonProps}
      hasCancel={false}
    >
      {/* 弹窗关着时不挂载内容：每次打开重新读授权状态 */}
      <div className="alert-settings">
        <section className="alert-settings-section">
          <div className="alert-settings-row">
            <Typography.Text strong>提示音</Typography.Text>
            <Switch
              aria-label="提示音"
              checked={prefs.sound}
              onChange={(checked) => {
                onPrefsChange({ sound: checked })
                // 打开时就在这一下点击里唤醒声音，响一次让人听到
                if (checked) onTestSound()
              }}
            />
          </div>
          <Typography.Paragraph type="tertiary" size="small">
            新呼叫到达时响「叮咚」两声为一轮，页面在后台、窗口最小化时也会响。浏览器规定页面被点过一下才肯出声，所以每次打开或刷新页面后，点一下页面任意处就会自动开启。
          </Typography.Paragraph>
          <Typography.Text strong>响铃时长</Typography.Text>
          <RadioGroup
            // 同一页上 Semi 的单选组不设 name 时都叫 default，会互相取消勾选
            name="call-alert-ring-for"
            direction="vertical"
            aria-label="响铃时长"
            value={prefs.ringFor}
            disabled={!prefs.sound}
            onChange={(event) => onPrefsChange({ ringFor: event.target.value as RingFor })}
          >
            {ringOptions.map((option) => (
              <Radio key={option.value} value={option.value}>
                {option.label}
              </Radio>
            ))}
          </RadioGroup>
          <Typography.Paragraph type="tertiary" size="small">
            持续响时每 {intervalSeconds}{' '}
            秒响一轮；呼叫被处理（网页或店员手机上点「已处理」都算）、点了提示里的「知道了」或关掉提示、响满时长、关掉提示音，就停。响着时又来新呼叫，从新呼叫起重新计时。
          </Typography.Paragraph>
          <div className="alert-settings-volume">
            <Typography.Text strong id="alert-settings-volume">
              音量
            </Typography.Text>
            <div className="alert-settings-volume-slider">
              <Slider
                aria-labelledby="alert-settings-volume"
                min={0}
                max={100}
                step={5}
                value={prefs.volume}
                disabled={!prefs.sound}
                onChange={(value) => {
                  if (typeof value === 'number') onPrefsChange({ volume: value })
                }}
              />
            </div>
            <Typography.Text className="alert-settings-volume-value">{prefs.volume}</Typography.Text>
          </div>
          <div className="alert-settings-row">
            <SoundStatus prefs={prefs} soundReady={soundReady} soundSupported={soundSupported} />
            <Button size="small" disabled={!soundSupported} onClick={onTestSound}>
              试听
            </Button>
          </div>
        </section>
        <NotificationSection prefs={prefs} onPrefsChange={onPrefsChange} />
        <Typography.Paragraph type="tertiary" size="small">
          这些设置只对这台电脑的这个浏览器有效，换电脑或换浏览器要重新设置。页面要开着才能提醒（可以放在后台标签页或最小化）。
        </Typography.Paragraph>
      </div>
    </Modal>
  )
}

function SoundStatus({
  prefs,
  soundReady,
  soundSupported,
}: Pick<AlertSettingsProps, 'prefs' | 'soundReady' | 'soundSupported'>) {
  if (!soundSupported) return <Tag color="grey">这个浏览器放不出声音</Tag>
  if (!prefs.sound) return <Tag color="grey">已关闭</Tag>
  if (prefs.volume === 0) return <Tag color="orange">音量为 0，响了也听不见</Tag>
  return soundReady ? <Tag color="green">已开启，能出声</Tag> : <Tag color="orange">点一下页面后才能出声</Tag>
}

function NotificationSection({ prefs, onPrefsChange }: Pick<AlertSettingsProps, 'prefs' | 'onPrefsChange'>) {
  const [permission, setPermission] = useNotificationPermission()
  const unsupported = permission === 'unsupported'

  // 必须在点击回调里请求授权：浏览器只认人的这一下
  const request = async () => {
    const result = await requestNotificationPermission()
    setPermission(result)
    if (result === 'granted') {
      onPrefsChange({ notify: true })
      Toast.success('已允许系统通知')
    }
  }

  return (
    <section className="alert-settings-section">
      <div className="alert-settings-row">
        <Typography.Text strong>系统通知</Typography.Text>
        <Switch
          aria-label="系统通知"
          checked={prefs.notify && !unsupported}
          disabled={unsupported}
          onChange={(checked) => {
            onPrefsChange({ notify: checked })
            if (checked && permission === 'default') void request()
          }}
        />
      </div>
      <Typography.Paragraph type="tertiary" size="small">
        浏览器在后台、窗口最小化或不在最前面时，新呼叫在电脑屏幕角上弹出通知，点通知回到「现场」看板。
      </Typography.Paragraph>
      <div className="alert-settings-row">
        {permission === 'granted' ? (
          <>
            <Tag color="green">浏览器已允许</Tag>
            <Button
              size="small"
              onClick={() => {
                if (!showTestNotification()) Toast.warning('没能弹出通知，请检查浏览器和电脑系统的通知设置')
              }}
            >
              发一条试试
            </Button>
          </>
        ) : permission === 'default' ? (
          <>
            <Tag color="orange">浏览器还没允许</Tag>
            <Button size="small" theme="solid" onClick={() => void request()}>
              开启系统通知
            </Button>
          </>
        ) : permission === 'denied' ? (
          <Tag color="red">浏览器已拒绝通知</Tag>
        ) : (
          <Tag color="grey">这个浏览器不支持系统通知</Tag>
        )}
      </div>
      {permission === 'denied' ? (
        <Banner
          type="warning"
          fullMode={false}
          bordered
          closeIcon={null}
          title="在浏览器里重新允许"
          description="点地址栏左侧的站点图标（Chrome 是「查看网站信息」，Firefox 是锁形或权限图标），把「通知」改成「允许」，然后刷新页面。"
        />
      ) : null}
      {permission === 'granted' ? (
        <Typography.Paragraph type="tertiary" size="small">
          允许了仍看不到通知时，检查电脑系统的通知设置（Windows「通知」、macOS「通知」里要允许这个浏览器，并关掉勿扰模式）。
        </Typography.Paragraph>
      ) : null}
      {unsupported ? (
        <Typography.Paragraph type="tertiary" size="small">
          请在柜台电脑上用 Chrome 或 Firefox 打开后台；手机、平板的浏览器一般不支持网页直接弹系统通知。
        </Typography.Paragraph>
      ) : null}
    </section>
  )
}

/**
 * 浏览器的通知授权。没有事件告诉页面授权变了，所以打开时读一次，切回窗口时再读；
 * 浏览器支持权限查询的（Chrome、Firefox）在站点设置里改了也能即时跟上。
 */
function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationState>(() => notificationState())
  useEffect(() => {
    const sync = () => setPermission(notificationState())
    window.addEventListener('focus', sync)
    let status: PermissionStatus | null = null
    let cancelled = false
    try {
      void navigator.permissions
        ?.query({ name: 'notifications' })
        .then((result) => {
          if (cancelled) return
          status = result
          result.onchange = sync
        })
        .catch(() => undefined)
    } catch {
      // 不支持权限查询：靠切回窗口时重读
    }
    return () => {
      cancelled = true
      window.removeEventListener('focus', sync)
      if (status) status.onchange = null
    }
  }, [])
  return [permission, setPermission] as const
}
