import { Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/button'
import { StaffScreen, useStaffData } from '../../../components/staff'
import { clockTime } from '../../../services/format'
import { staffMessage } from '../../../services/staff'
import { relayKind, scanAndRelay, type RelayKind, type RelayOutcome } from '../../../services/scan-relay'
import {
  describeDevice,
  scanWebLogin,
  webLogin,
  webLoginIdFromScene,
  webLoginStatusLabels,
} from '../../../services/web-login'
import './index.scss'

/**
 * 连电脑（2026-10-20 把「扫码登录电脑」「扫码给电脑」合成一页）：扫登录码、手机当扫码枪、全部退出。
 *
 * 电脑登录：扫电脑屏幕上的二维码，看清是哪台电脑后允许或拒绝。
 *
 * ★ 二维码只是一串编号，谁拍到都能扫；真正的门是这里的「允许登录」——所以先把设备、
 *   网络地址和发起时间摆出来让人核对，再给按钮。不是自己刚打开的登录页就拒绝。
 * ★ 店里电脑丢了、或者忘了退出时，用最下面的「全部退出」把本人在电脑上的登录
 *   一次全部踢下线；只退本人、只退电脑，别人的登录和小程序登录都不受影响。
 *
 * 手机当扫码枪：扫商品条码、顾客的会员码，扫到的内容马上出现在你本人登录的电脑后台——
 * 收货入库按条码加商品，结账页、会员资产页按会员码选顾客；电脑上别的页面只提示「手机扫到：…」。
 * 只到本人的电脑，不给别人；码不保存，电脑那一刻没开着就收不到。这一页只显示上一次发没发出去。
 */
type Relayed = Exclude<RelayOutcome, { kind: 'cancelled' }> & { at: number }

const kindNames: Record<RelayKind, string> = { member: '会员码', barcode: '条码', other: '其他内容' }
const relayStatus: Record<Relayed['kind'], string> = { sent: '已发给电脑', offline: '电脑没在线', error: '没有发出' }

export default function StaffWebLogin() {
  const { params } = useRouter()
  // 微信扫一扫电脑上的登录码（小程序码）会直接打开这一页，挑战编号在 scene 里
  const [id, setId] = useState(params.id || webLoginIdFromScene(params.scene))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [latest, setLatest] = useState<Relayed | null>(null)
  const pending = useRef(false)
  const data = useStaffData(() => (id ? webLogin.view(id) : Promise.resolve(null)))
  const { refresh } = data

  useEffect(() => {
    refresh()
  }, [id, refresh])

  const run = async (work: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      setError(staffMessage(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const scan = () =>
    run(async () => {
      const next = await scanWebLogin()
      if (next) setId(next)
    })

  const relay = () =>
    run(async () => {
      const outcome = await scanAndRelay()
      if (outcome.kind === 'cancelled') return
      setLatest({ ...outcome, at: Date.now() })
      if (outcome.kind === 'sent') void Taro.showToast({ title: '已发给电脑', icon: 'success' })
      else if (outcome.kind === 'offline') void Taro.showToast({ title: '电脑没在线', icon: 'none' })
    })

  const decide = (approve: boolean) =>
    run(async () => {
      await webLogin.decide(id, approve)
      setNotice(approve ? '已允许，电脑上会自动进入后台。' : '已拒绝，这个二维码不能再用。')
      refresh()
    })

  const revokeAll = () =>
    run(async () => {
      const confirmed = (
        await Taro.showModal({
          title: '全部退出',
          content: '你本人在所有电脑上的员工后台登录都会立即退出，需要重新扫码。别人的登录和小程序登录不受影响。',
          confirmText: '全部退出',
          confirmColor: '#a82929',
        })
      ).confirm
      if (!confirmed) return
      const { revoked } = await webLogin.revokeAll()
      setNotice(revoked ? `已退出 ${revoked} 个电脑登录。` : '你当前没有在电脑上登录。')
    })

  const request = data.data
  const expired = request?.status === 'pending' && new Date(request.expiresAt).getTime() <= Date.now()
  const status = expired ? 'expired' : request?.status

  return (
    <StaffScreen
      title="连电脑"
      loading={!!id && data.loading}
      error={data.error}
      stale={data.data !== null}
      onRetry={refresh}
    >
      <Text className="computer-intro">
        电脑浏览器打开 <Text className="strong">{process.env.TARO_APP_ADMIN_URL || '员工网页后台'}</Text>
        ，下面两件事都要电脑开着员工后台。
      </Text>
      {error && (
        <View className="inline-error" role="alert">
          {error}
        </View>
      )}
      {notice && (
        <View className="staff-notice" role="status">
          {notice}
        </View>
      )}

      {request && status && (
        <View className="computer-card computer-card-request">
          <Text className="computer-title">要登录员工后台的电脑</Text>
          <View className="web-login-facts">
            <Text className="field-label">设备</Text>
            <Text className="strong">{describeDevice(request.userAgent)}</Text>
            <Text className="field-label">网络地址</Text>
            <Text>{request.ip || '未知'}</Text>
            <Text className="field-label">发起时间</Text>
            <Text>{clockTime(request.createdAt)}</Text>
            <Text className="field-label">状态</Text>
            <Text className={status === 'pending' ? 'strong' : ''}>{webLoginStatusLabels[status]}</Text>
          </View>
          {status === 'pending' && (
            <>
              <Text className="computer-note">
                确认是你面前这台电脑、而且是你刚打开的登录页，再点「允许登录」。不是的话请拒绝。
              </Text>
              <View className="computer-pair">
                <Button
                  className="computer-button computer-button-dark"
                  disabled={busy}
                  onClick={() => void decide(true)}
                >
                  允许登录
                </Button>
                <Button className="computer-button" disabled={busy} onClick={() => void decide(false)}>
                  拒绝
                </Button>
              </View>
            </>
          )}
        </View>
      )}

      <View className="computer-card">
        <View className="computer-head">
          <Text className="computer-title">登录电脑上的后台</Text>
          <Text className="computer-note">电脑上出现登录码，用手机扫一下，再点「允许」</Text>
        </View>
        <Button className="computer-button computer-button-dark" disabled={busy} onClick={() => void scan()}>
          {request && status && status !== 'pending' ? '再扫一个' : '扫登录码'}
        </Button>
      </View>

      <View className="computer-card">
        <View className="computer-head">
          <Text className="computer-title">手机当扫码枪</Text>
          <Text className="computer-note">
            扫到的商品条码、会员码，直接填进你电脑上开着的那一页：收货入库按条码加商品，结账、会员资产按会员码选顾客
          </Text>
        </View>
        <Button className="computer-button computer-button-gold" disabled={busy} onClick={() => void relay()}>
          {busy ? '正在处理' : '开始扫'}
        </Button>
        {latest && (
          <View
            className={`computer-latest computer-latest-${latest.kind}`}
            role={latest.kind === 'sent' ? 'status' : 'alert'}
          >
            <Text className="computer-latest-text">
              上一次：{latest.code ? kindNames[relayKind(latest.code)] : '没有内容'}
              {latest.code && relayKind(latest.code) !== 'member' ? ` ${latest.code}` : ''} · {relayStatus[latest.kind]}
            </Text>
            <Text className="computer-latest-time">{clockTime(latest.at)}</Text>
            {latest.kind !== 'sent' && <Text className="computer-latest-message">{latest.message}</Text>}
          </View>
        )}
      </View>

      <View className="computer-card computer-card-out">
        <View className="computer-head">
          <Text className="computer-title">电脑丢了，或忘了退出？</Text>
          <Text className="computer-note">把你在所有电脑上的登录一次退掉，别人的登录和小程序登录不受影响</Text>
        </View>
        <Button className="computer-button computer-button-danger" disabled={busy} onClick={() => void revokeAll()}>
          全部退出
        </Button>
      </View>
      <Text className="computer-footnote">退款、商品资料、盘点、经营规则、员工权限、报表备份、桌码都在电脑后台</Text>
    </StaffScreen>
  )
}
