import { useMemo } from 'react'
import { Image, Text, View } from '@tarojs/components'
import { Button } from '../button'
import { useBillingEnabled } from '../../hooks/billing'
import { useMemberCode } from '../../hooks/member-code'
import { memberCodeIntro } from '../../services/member-code'
import { qrDataUrl } from '../../services/qr'

/**
 * 会员码弹层：到店充值、兑换（收费开着时还有结账）时亮给店员扫，店员一扫就调出这位顾客，不用报手机号。
 * 码每分钟自动换一个（90 秒有效），截图转给别人很快就失效；码里没有手机号、微信标识或账户编号。
 */
export function MemberCodeCard({ sheet = false }: { sheet?: boolean } = {}) {
  const view = useMemberCode()
  const billing = useBillingEnabled()
  const image = useMemo(() => (view.code ? qrDataUrl(view.code) : ''), [view.code])
  const note = view.error
    ? view.code
      ? `换码没成功：${view.error}`
      : view.error
    : '每分钟自动换一个码，截图很快就失效'
  return (
    <View className="loyalty-card member-code-card">
      {!sheet && <Text className="member-code-title">到店亮码</Text>}
      <Text className="field-help member-code-intro">
        {sheet ? '到店充值、兑换积分、领生日礼物时给店员扫' : memberCodeIntro(billing)}
      </Text>
      <View className="member-code-frame">
        {image ? (
          <Image
            className={`member-code-image ${view.expired ? 'member-code-image-expired' : ''}`}
            src={image}
            mode="aspectFit"
            ariaLabel={view.expired ? '会员码已过期' : '会员码，出示给店员扫'}
          />
        ) : (
          <View className="member-code-placeholder">
            <Text className="muted">{view.loading ? '正在生成会员码…' : '会员码暂时出不来'}</Text>
          </View>
        )}
        {view.expired && (
          <View className="member-code-overlay" role="alert">
            <Text>会员码已过期，请刷新</Text>
          </View>
        )}
      </View>
      {view.error ? (
        <View className="field-error" role="alert">
          {note}
        </View>
      ) : null}
      {sheet && !view.error ? (
        <Text className="member-code-sheet-note">每分钟自动换一个，截图很快就失效 · 打开时屏幕调亮</Text>
      ) : (
        <View className="member-code-foot">
          {!view.error && <Text className="field-help">{note} · </Text>}
          <Button className="text-button member-code-refresh" disabled={view.loading} onClick={view.refresh}>
            刷新会员码
          </Button>
        </View>
      )}
    </View>
  )
}
