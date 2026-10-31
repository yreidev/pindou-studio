import { Text, View } from '@tarojs/components'
import { useRouter } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { AuthBoundary, Failure, RefreshNotice, Screen, SectionEmpty, Skeleton } from '../../../components/customer'
import { chooseStoreContact } from '../../../components/customer/store-contact'
import { useCustomerQuery, usePublicQuery } from '../../../hooks/query'
import { loyalty, type Entry } from '../../../services/membership'
import {
  consumptionContent,
  entryAmount,
  entryDate,
  memberDay,
  memberEntry,
  rechargeName,
  signedAmount,
} from '../../../services/member-entry'
import { entryNames } from '../../../services/membership'
import { dateTime, moneyText } from '../../../services/format'
import { navigateApp } from '../../../services/navigation'
import { storefront } from '../../../services/storefront'
import { brandName, consumptionDetailTitle, entryDetailTitle } from '../../../brand'
import './index.scss'

export function ConsumptionReceipt({ entry, reversal }: { entry: Entry; reversal?: Entry }) {
  const recharge = entry.kind === 'recharge'
  const balance = entry.balanceAfter
  const amount = entryAmount(entry)
  const row = (label: string, value: string, strong = false) => (
    <View className="receipt-row">
      <Text>{label}</Text>
      <Text className={`receipt-value ${strong ? 'strong' : ''}`}>{value}</Text>
    </View>
  )
  return (
    <View className="receipt-card">
      <Text className="receipt-brand">
        {brandName} · {recharge ? '充值记录' : '消费记录'}
      </Text>
      <View className="receipt-heading">
        <Text className={`receipt-amount ${reversal ? 'receipt-reversed' : ''}`}>
          {signedAmount(recharge ? amount : -Math.abs(entry.consumption?.amountCents ?? amount))}
        </Text>
        <Text className="receipt-status">
          {reversal ? '已撤销 · 已退回' : recharge ? '已到账余额' : '已从余额扣除'}
        </Text>
      </View>
      {!!entry.consumption?.extraCents && (
        <Text className="receipt-extra">余额不够，另付 ¥{moneyText(entry.consumption.extraCents)}</Text>
      )}
      {reversal && <Text className="receipt-extra">门店撤销：{reversal.reason}</Text>}
      <View className="receipt-section">
        {row(recharge ? '充值日期' : '消费日期', memberDay(entryDate(entry)))}
        {row('内容', recharge ? `充值 ${rechargeName(entry)}` : consumptionContent(entry) || '门店消费')}
        {recharge ? (
          <>
            {row('实付', `¥${moneyText(entry.principalCents)}`)}
            {row('赠送余额', `¥${moneyText(entry.giftCents)}`)}
          </>
        ) : (
          row('余额扣', `¥${moneyText(Math.abs(amount))}`)
        )}
        {row('智能豆板', `${recharge ? '送' : '用'} ${Math.abs(entry.boardUses || 0)} 次`)}
      </View>
      {balance && (
        <View className="receipt-section">
          {row(recharge ? '到账后余额' : '扣完余额', `¥${moneyText(balance.principalCents + balance.giftCents)}`, true)}
          {balance.giftCents > 0 && <Text className="receipt-gift">其中赠送 ¥{moneyText(balance.giftCents)}</Text>}
          {row('智能豆板剩', `${balance.boardUses} 次`, true)}
          {reversal && <Text className="receipt-note">以上为原登记后的余额；撤销后的最新余额请看会员中心。</Text>}
        </View>
      )}
      <Text className="receipt-recorded">
        店里 {memberDay(entry.createdAt, false)} {dateTime(entry.createdAt).slice(11)} 登记
      </Text>
    </View>
  )
}

/**
 * 消费、充值以外的流水（结账扣款、消费积分、手动加减、兑换、生日福利、退款……）：同一张小票的版式，
 * 只写这一笔改了什么；记完的余额只有 0.0.33 以后的流水存了，旧流水不补算。
 */
export function EntryReceipt({ entry }: { entry: Entry }) {
  const amount = entryAmount(entry)
  const points = entry.points.reduce((sum, point) => sum + point.delta, 0)
  const balance = entry.balanceAfter
  const name = entryNames[entry.kind] || '会员记录'
  const row = (label: string, value: string, strong = false) => (
    <View className="receipt-row">
      <Text>{label}</Text>
      <Text className={`receipt-value ${strong ? 'strong' : ''}`}>{value}</Text>
    </View>
  )
  const headline = amount
    ? signedAmount(amount)
    : points
      ? `积分 ${points > 0 ? '+' : ''}${points}`
      : entry.boardUses
        ? `智能豆板 ${entry.boardUses > 0 ? '+' : ''}${entry.boardUses} 次`
        : name
  return (
    <View className="receipt-card">
      <Text className="receipt-brand">
        {brandName} · {name}
      </Text>
      <View className="receipt-heading">
        <Text className="receipt-amount">{headline}</Text>
        {amount !== 0 && <Text className="receipt-status">{amount > 0 ? '已加到余额' : '已从余额扣除'}</Text>}
      </View>
      <View className="receipt-section">
        {row('日期', memberDay(entryDate(entry)))}
        {row('内容', memberEntry(entry, []).title)}
        {amount !== 0 && row('余额', signedAmount(amount))}
        {!!entry.boardUses && row('智能豆板', `${entry.boardUses > 0 ? '+' : ''}${entry.boardUses} 次`)}
        {entry.points.map((point, i) => (
          <View className="receipt-row" key={i}>
            <Text>积分</Text>
            <Text className="receipt-value">
              {point.delta > 0 ? '+' : ''}
              {point.delta}
              {point.expiresAt ? `（${memberDay(point.expiresAt, false)}到期）` : ''}
            </Text>
          </View>
        ))}
        {!!entry.reason && row('原因', entry.reason)}
      </View>
      {balance && (
        <View className="receipt-section">
          {row('记完余额', `¥${moneyText(balance.principalCents + balance.giftCents)}`, true)}
          {balance.giftCents > 0 && <Text className="receipt-gift">其中赠送 ¥{moneyText(balance.giftCents)}</Text>}
          {row('智能豆板剩', `${balance.boardUses} 次`, true)}
        </View>
      )}
      <Text className="receipt-recorded">
        店里 {memberDay(entry.createdAt, false)} {dateTime(entry.createdAt).slice(11)} 登记
      </Text>
    </View>
  )
}

export default function ConsumptionDetail() {
  const { params } = useRouter()
  const resource = useCustomerQuery(['loyalty'], loyalty.me, { live: true })
  const home = usePublicQuery(['storefront'], storefront.home)
  const entries = resource.data?.entries || []
  const found = entries.find((e) => e.id === params.id)
  // 撤销那一笔打开被撤销的消费，小票上标「已撤销 · 已退回」
  const entry =
    found?.kind === 'consume_reverse'
      ? entries.find((e) => e.id === found.sourceId && e.kind === 'consume') || found
      : found
  const receipt = entry?.kind === 'consume' || entry?.kind === 'recharge'
  const reversal = entry && entries.find((e) => e.kind === 'consume_reverse' && e.sourceId === entry.id)
  const contact = home.data?.contact
  const reachable = !!contact && (!!contact.phone || !!contact.wechat || contact.latitude !== null)
  return (
    <Screen
      navigationHeight={44}
      title={!entry || receipt ? consumptionDetailTitle : entryDetailTitle}
      back
      className="consumption-detail-screen"
    >
      <AuthBoundary>
        <View className="receipt-content">
          {resource.loading ? (
            <Skeleton />
          ) : !resource.data ? (
            <Failure error={resource.error} retry={() => void resource.refresh()} />
          ) : (
            <>
              {!!resource.error && <RefreshNotice retry={() => void resource.refresh()} />}
              {entry && receipt ? (
                <ConsumptionReceipt entry={entry} reversal={reversal} />
              ) : entry ? (
                <EntryReceipt entry={entry} />
              ) : (
                <SectionEmpty title="没有找到这笔记录" message="请回会员明细重新打开。" />
              )}
              <Button
                className="receipt-all"
                onClick={() => void navigateApp('/pages/customer/membership/index', true)}
              >
                看全部明细
              </Button>
              {reachable && contact && (
                <Button className="receipt-contact" onClick={() => chooseStoreContact(contact)}>
                  <Text>金额对不上？</Text>
                  <Text>联系门店</Text>
                </Button>
              )}
            </>
          )}
        </View>
      </AuthBoundary>
    </Screen>
  )
}
