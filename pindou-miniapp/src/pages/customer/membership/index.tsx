import { useRef, useState } from 'react'
import { Picker, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../../../components/button'
import { AuthBoundary, Failure, RefreshNotice, Screen, SectionEmpty, Skeleton } from '../../../components/customer'
import { useCustomerQuery } from '../../../hooks/query'
import { loyalty, type Rule } from '../../../services/membership'
import { moneyText, storeOffsetMinutes } from '../../../services/format'
import { customerEntries, entryDate, memberDay, signedAmount, entryAmount } from '../../../services/member-entry'
import { navigateApp } from '../../../services/navigation'
import { useCustomer } from '../../../hooks/customer'
import { MemberCodeSheet } from '../../../components/customer/member-code-sheet'
import { DesignIcon } from '../../../components/customer/design-icon'
import { MemberHistory } from '../../../components/customer/member-history'
import './index.scss'
import { membershipName } from '../../../brand'

// 后端只保存 MM-DD（docs/api.yaml LoyaltyProfile.birthday），所以只让用户选月和日。
// 2 月给到 29 日：生日当天福利在闰年可领，见 DESIGN.md。
const monthNames = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`)
const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const dayNames = (month: number) => Array.from({ length: monthDays[month] }, (_, i) => `${i + 1} 日`)
const pad = (value: number) => String(value).padStart(2, '0')
const monthDayOf = (value: string): [number, number] =>
  /^\d{2}-\d{2}$/.test(value) ? [Number(value.slice(0, 2)) - 1, Number(value.slice(3)) - 1] : [0, 0]
const sections: [string, string][] = [
  ['history', '明细'],
  ['benefits', '会员权益'],
  ['birthday', '生日福利'],
]

// 与网页后台的规则说明同一口径（pindou-admin/src/features/rules/display.ts），这里换成对顾客的说法
const validity = (days: number) => (days > 0 ? ` ${days} 天内有效` : '永久有效')
/** 「03-08」→「3 月 8 日」 */
const birthdayText = (value: string) => `${Number(value.slice(0, 2))} 月 ${Number(value.slice(3))} 日`

/** 领生日福利前问的那句：领了就开始算有效期，过期作废，要先让顾客知道（2026-10-27 业主定）。 */
function claimNotice(rule: Rule) {
  const days = rule.validDays > 0 ? `领取后${validity(rule.validDays)}` : '领取后一直有效'
  const what =
    rule.scope === 'points'
      ? `${rule.points} 积分马上到账，${days}，过期作废。`
      : rule.scope === 'gift'
        ? `${days}：到店找店员拿礼物，店员当面核销。`
        : `${days}：到店消费按 ${rule.rateBasisPoints / 100}% 计价，过期作废。`
  return `${rule.name}：${what}不打算这几天来店里的话，可以先不领。`
}
const earnScopes: Record<string, string> = { all: '全部实付消费', goods: '购买商品的实付', service: '计时服务的实付' }

/**
 * 示例工坊社（2026-10-20 重做，画稿 CMembership）：会员卡、会员码弹层，
 * 下面「明细 / 会员权益 / 生日福利」三栏切换；没填生日给一张提醒卡。
 * 余额和积分不受系统内收费开关影响，照常显示（docs/plan-timing-without-billing.md 第 5 节）。
 */
export default function Membership() {
  const resource = useCustomerQuery(['loyalty'], loyalty.me, { live: true })
  const member = resource.data
  const { account } = useCustomer()
  const [birthday, setBirthday] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [selectedSection, setSection] = useState('')
  const [codeOpen, setCodeOpen] = useState(false)
  const section = selectedSection || (member?.entries.length ? 'history' : 'benefits')
  const latest = member ? customerEntries(member.entries)[0] : undefined
  const benefits = member?.rules.filter((r) => r.kind !== 'package' && r.kind !== 'birthday') || []
  const birthdayRules = member?.rules.filter((r) => r.kind === 'birthday') || []
  // 生日每个自然年（门店时区）只能设一次：今年设过的不再给选，免得选好、确认了才被拒
  const birthdaySetThisYear =
    !!member?.profile.birthdayYear &&
    member.profile.birthdayYear === new Date(Date.now() + storeOffsetMinutes * 60000).getUTCFullYear()
  const pending = useRef(false)
  const showHistory = () => {
    setSection('history')
    Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select('.membership-screen .navbar')
        .boundingClientRect()
        .exec(([navbar]) => {
          if (!navbar) return
          void Taro.pageScrollTo({ selector: '#membership-tabs', offsetTop: -navbar.height, duration: 300 })
        })
    })
  }
  const run = async (task: () => Promise<unknown>, message: string) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setSuccess('')
    try {
      await task()
      setSuccess(message)
      await resource.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  /** 先问一句，点了确认才做：生日一年只能设一次，福利一领就开始算有效期，都撤不回来（2026-10-27 起）。 */
  const confirmThen = async (modal: Taro.showModal.Option, task: () => Promise<unknown>, message: string) => {
    if (pending.current) return
    try {
      if (!(await Taro.showModal(modal)).confirm) return
    } catch {
      return
    }
    await run(task, message)
  }
  return (
    <Screen navigationHeight={44} title={membershipName} back className="membership-screen">
      <AuthBoundary>
        {!!resource.error && member && (
          <RefreshNotice
            retry={() => {
              void resource.refresh()
            }}
          />
        )}
        {resource.loading ? (
          <Skeleton />
        ) : !member ? (
          <Failure
            error={resource.error}
            retry={() => {
              void resource.refresh()
            }}
          />
        ) : (
          <View className="loyalty-content">
            <View className="loyalty-member">
              <View className="loyalty-member-top">
                <View className="loyalty-member-identity">
                  <Text className="loyalty-member-phone">
                    {account?.phoneMasked ? `手机尾号 ${account.phoneMasked.slice(-4)} · ` : ''}
                    {member.balance.tierName}
                  </Text>
                  <Text className="loyalty-member-name">{account?.nickname || '示例工坊社会员'}</Text>
                </View>
                <Button className="loyalty-code-button" onClick={() => setCodeOpen(true)}>
                  <DesignIcon name="code" />
                  会员码
                </Button>
              </View>
              <View className="loyalty-balance">
                <Text className="loyalty-asset-label">余额</Text>
                <Text className="loyalty-balance-value">
                  ¥{moneyText(member.balance.principalCents + member.balance.giftCents)}
                </Text>
                {member.balance.giftCents > 0 && (
                  <Text className="loyalty-member-note">其中赠送 ¥{moneyText(member.balance.giftCents)}</Text>
                )}
              </View>
              <View className="loyalty-assets">
                <View className="loyalty-asset">
                  <Text className="loyalty-asset-label">智能豆板</Text>
                  <Text className="loyalty-asset-count">剩 {member.balance.boardUses} 次</Text>
                </View>
                <View className="loyalty-asset">
                  <Text className="loyalty-asset-label">积分</Text>
                  <Text className="loyalty-asset-count">{member.balance.points}</Text>
                </View>
              </View>
              {member.balance.expiringPoints > 0 && (
                <Text className="loyalty-member-note">{member.balance.expiringPoints} 积分将在 30 天内到期</Text>
              )}
              {latest && (
                <Button className="loyalty-latest" onClick={showHistory}>
                  <Text className="loyalty-latest-prefix">最近</Text>
                  <Text className="loyalty-latest-copy">
                    {memberDay(entryDate(latest.entry), false)}{' '}
                    {latest.reversal
                      ? '消费已撤销'
                      : latest.entry.kind === 'consume'
                        ? '消费'
                        : latest.entry.kind === 'recharge'
                          ? '充值'
                          : latest.title}{' '}
                    {signedAmount(entryAmount(latest.entry))}
                  </Text>
                  <Text className="loyalty-latest-link">明细</Text>
                  <DesignIcon name="right-gold" />
                </Button>
              )}
            </View>
            {codeOpen && <MemberCodeSheet onClose={() => setCodeOpen(false)} />}
            {/*
              余额 ¥0.00 摆在那，页面却一个字没说怎么变成非零 —— 充值和兑换都只能到店办，
              这件事得写出来，否则顾客会在小程序里找一个不存在的入口。
            */}
            <Text className="loyalty-store-note">充值、积分兑换、余额增减请到店找店员办</Text>
            <View id="membership-tabs" className="loyalty-tabs">
              {sections.map(([key, label]) => (
                <Button
                  key={key}
                  className={`loyalty-tab ${section === key ? 'loyalty-tab-selected' : ''}`}
                  disabled={busy}
                  onClick={() => setSection(key)}
                >
                  {label}
                </Button>
              ))}
            </View>
            {success && (
              <View className="loyalty-success" role="status">
                {success}
              </View>
            )}
            {error && (
              <View className="field-error" role="alert">
                {error}
              </View>
            )}
            {section === 'birthday' && (
              <View className="loyalty-section">
                {birthdayRules.length === 0 && (
                  <SectionEmpty title="暂未发布生日福利" message="门店发布生日福利后，会在这里展示。" />
                )}
                {birthdayRules.map((r) => (
                  <View className={`loyalty-rule ${r.kind === 'recharge' ? 'loyalty-recharge' : ''}`} key={r.id}>
                    <Text className="strong">{r.name}</Text>
                    <Text>
                      {r.mode === 'day' ? '生日当天' : '生日月'}福利 ·{' '}
                      {r.scope === 'points'
                        ? `${r.points} 积分`
                        : r.scope === 'gift'
                          ? '到店领取礼物'
                          : `消费按 ${r.rateBasisPoints / 100}% 计价`}{' '}
                      · 每年限领 {r.perUserLimit} 次，领取后 {r.validDays} 天内有效
                    </Text>
                    <Button
                      className="button button-outline"
                      disabled={busy}
                      onClick={() => {
                        void confirmThen(
                          {
                            title: '现在领取生日福利？',
                            content: claimNotice(r),
                            confirmText: '领取',
                            cancelText: '先不领',
                          },
                          () => loyalty.action({ action: 'claim', targetId: r.id, expectedVersion: member.version }),
                          '生日福利已领取，可在明细里查看',
                        )
                      }}
                    >
                      领取生日福利
                    </Button>
                  </View>
                ))}
                <Text className="section-title loyalty-birthday-title">我的生日</Text>
                <Text className="field-help">只保存月日，每个自然年可设置一次；2 月 29 日的当天福利仅闰年可领。</Text>
                {(() => {
                  const [month, day] = monthDayOf(birthday || member.profile.birthday)
                  const pick = (m: number, d: number) =>
                    setBirthday(`${pad(m + 1)}-${pad(Math.min(d + 1, monthDays[m]))}`)
                  return (
                    <Picker
                      mode="multiSelector"
                      range={[monthNames, dayNames(month)]}
                      value={[month, day]}
                      disabled={busy || birthdaySetThisYear}
                      onColumnChange={(e) => {
                        if (e.detail.column === 0) pick(e.detail.value, day)
                      }}
                      onChange={(e) => {
                        const [m, d] = e.detail.value as number[]
                        pick(m, d)
                      }}
                    >
                      <View
                        className="loyalty-picker"
                        ariaLabel={`生日：${birthday || member.profile.birthday || '未设置'}`}
                      >
                        生日：{birthday || member.profile.birthday || '请选择'}
                      </View>
                    </Picker>
                  )
                })()}
                {birthdaySetThisYear ? (
                  <Text className="field-help">今年已经设置过生日，明年 1 月 1 日起可以再改。</Text>
                ) : (
                  <Button
                    className="button button-outline"
                    disabled={!birthday || busy}
                    loading={busy}
                    onClick={() => {
                      void confirmThen(
                        {
                          title: '保存生日？',
                          content: `生日设为 ${birthdayText(birthday)}。每个自然年只能设置一次，保存后今年就改不了了。`,
                          confirmText: '保存',
                          cancelText: '再看看',
                        },
                        async () => {
                          await loyalty.action({ action: 'birthday', birthday })
                          setBirthday('')
                        },
                        '生日已保存',
                      )
                    }}
                  >
                    保存生日
                  </Button>
                )}
              </View>
            )}
            {section === 'benefits' && (
              <View className="loyalty-section">
                <Text className="field-help">到店充值，余额不过期</Text>
                {benefits.length === 0 && (
                  <SectionEmpty title="暂未发布会员活动" message="门店发布权益后，会在这里展示。" />
                )}
                {benefits.map((r) => (
                  <View className={`loyalty-rule ${r.kind === 'recharge' ? 'loyalty-recharge' : ''}`} key={r.id}>
                    {r.kind === 'recharge' ? (
                      <>
                        <View className="loyalty-recharge-copy">
                          <Text className="strong">{r.name}</Text>
                          <Text className="loyalty-recharge-note">
                            充 ¥{moneyText(r.amountCents).replace(/\.00$/, '')}，余额到账 ¥
                            {moneyText(r.amountCents + r.giftCents).replace(/\.00$/, '')}
                          </Text>
                          {r.points > 0 && (
                            <Text className="loyalty-recharge-note">
                              {r.points} 积分（{validity(r.validDays).trim()}）
                            </Text>
                          )}
                        </View>
                        {!!r.boardUses && <Text className="loyalty-recharge-tag">送智能豆板 {r.boardUses} 次</Text>}
                      </>
                    ) : (
                      <Text className="strong">{r.name}</Text>
                    )}
                    {r.kind === 'tier' && (
                      <Text>
                        {r.mode === 'single' ? '单次' : '累计'}充值 ¥{moneyText(r.amountCents)}，消费按{' '}
                        {r.rateBasisPoints / 100}% 计价 · 等级{validity(r.validDays)}
                      </Text>
                    )}
                    {r.kind === 'earn' && (
                      <Text>
                        {earnScopes[r.scope] ?? '实付消费'}每 ¥{moneyText(r.amountCents)} 获得 {r.points} 积分 · 积分
                        {validity(r.validDays)}
                      </Text>
                    )}
                    {r.kind === 'redeem' && (
                      <Text>
                        {r.points} 积分抵 ¥{moneyText(r.amountCents)}，每单最多抵 {r.maxBasisPoints / 100}%，至少用{' '}
                        {r.minimumPoints} 积分 · {r.stack ? '可与会员价同时享受' : '不与会员价同时享受'}
                      </Text>
                    )}
                    {r.kind === 'exchange' && (
                      <Text>
                        {r.points} 积分兑换，每人限 {r.perUserLimit} 次，请到店由员工办理
                      </Text>
                    )}
                    {r.validDays > 0 && <Text className="field-help">权益或积分有效期 {r.validDays} 天</Text>}
                  </View>
                ))}
              </View>
            )}
            {section === 'history' && (
              <View className="loyalty-section">
                {!member.entries.length ? (
                  <SectionEmpty title="还没有资产记录" message="到店充值、消费或领取福利后，可在这里查看明细。" />
                ) : (
                  <MemberHistory entries={member.entries} page={page} onPage={setPage} busy={busy} />
                )}
              </View>
            )}
            {!member.profile.birthday && section !== 'birthday' && (
              <Button className="loyalty-birthday-card" disabled={busy} onClick={() => setSection('birthday')}>
                <Text className="loyalty-birthday-card-title">还没填生日</Text>
                <Text className="loyalty-birthday-card-note">填好月日，生日那天来店里领福利 ›</Text>
              </Button>
            )}
            <Button
              className="text-button loyalty-leave"
              disabled={busy}
              onClick={() => {
                void navigateApp('/pages/customer/experience/index')
              }}
            >
              在店里？去本次手作
            </Button>
          </View>
        )}
      </AuthBoundary>
    </Screen>
  )
}
