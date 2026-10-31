import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { Button } from '../../../components/button'
import { navbarHeight, SectionEmpty } from '../../../components/customer'
import { StaffScreen, useStaffEvents, useStaffQuery } from '../../../components/staff'
import { AccountSearch, type AccountChoice } from '../../../components/staff/account-search'
import { StaffSheet } from '../../../components/staff/table-sheet'
import { navigateApp } from '../../../services/navigation'
import { useLeaveGuard } from '../../../hooks/leave-guard'
import { useCustomer } from '../../../hooks/customer'
import { useBillingEnabled } from '../../../hooks/billing'
import { useRefreshAll } from '../../../hooks/query'
import { useStaffOverview } from '../../../hooks/staff-overview'
import { loyalty, withChosenMember, type Entry, type LoyaltyAction } from '../../../services/membership'
import { registeredEntry } from '../../../services/member-copy'
import {
  reservations,
  storeClock,
  storeDate,
  isoDate,
  storeDayLabel,
  storeStamp,
  type ReservationEntry,
} from '../../../services/reservations'
import { couponText } from '../../../services/coupon'
import { staffApi, staffMessage } from '../../../services/staff'
import {
  AdjustSheet,
  ConsumptionSheet,
  OpenMemberSheet,
  EntryList,
  ExchangeSheet,
  pendingGifts,
  RechargeSheet,
  WalletRow,
  MemberDoneSheet,
} from './members'
import './index.scss'

// 会员（2026-10-20 从「会员与计时」拆出来，docs/plan-page-redesign.md 第 2 节第 6 条）：计时并进了现场和桌位，
// 这一页只办柜台前当场的事：扫会员码或搜索找到人，会员卡（等级、手机尾号、生日、资产），「到店充值 / 积分兑换 /
// 消费登记 / 手动加减」各自从底部弹出，生日礼物待领直接核销，「这位顾客今天」列出今天的预约，已确认的直接开台。
// 会员资产的退款与纠错、经营规则、会员结账单的退款都在电脑后台（admin.example.invalid）。
// 2026-10-27 起：「这位顾客今天」的预约等确认的也能直接开台，开台前问一句；会员卡下面能「发临时密码」
// 给顾客认领会员用（和电脑后台同一个接口，临时密码只在弹层里显示这一次，当面告诉顾客）。

type Sheet = '' | 'recharge' | 'exchange' | 'adjust' | 'consume' | 'open'

/** 各会员动作确认框的标题和按钮：按钮写动作，不写「确认」（微信确认框按钮最多 4 个字） */
const confirmCopy: Partial<Record<LoyaltyAction['action'], { title: string; confirmText: string }>> = {
  recharge: { title: '到店充值', confirmText: '确认充值' },
  consume: { title: '消费登记', confirmText: '确认扣费' },
  exchange: { title: '积分兑换', confirmText: '确认兑换' },
  adjust: { title: '手动加减', confirmText: '确认加减' },
  fulfill_gift: { title: '交付生日礼物', confirmText: '确认交付' },
}

/** 「138****0000」→「尾号 0000」。 */
const phoneTail = (masked?: string) => (masked ? `尾号 ${masked.slice(-4)}` : '未绑定手机')

export default function StaffMembership() {
  const billing = useBillingEnabled()
  const auth = useCustomer()
  const unlimitedDates = !!auth.account?.roles.some((role) => role === 'manager' || role === 'owner')
  const live = useStaffEvents(5000)
  const { params } = useRouter()
  // 选中的会员整个留着（会员资产接口不带称呼，要靠它显示是谁）
  const [chosen, setChosen] = useState<AccountChoice | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sheet, setSheet] = useState<Sheet>('')
  const [showEntries, setShowEntries] = useState(false)
  const [registered, setRegistered] = useState<Entry | null>(null)
  // 刚发的临时密码，只在弹层里显示这一次
  const [issued, setIssued] = useState<Awaited<ReturnType<typeof staffApi.issueTemporaryPassword>> | null>(null)
  const accountId = chosen?.id || ''
  const pending = useRef(false)
  // 选中的会员的资产。查询键带着会员编号和当前身份：换人、换身份时旧的立即不显示，迟到的响应也盖不过来。
  const memberQuery = useStaffQuery(['loyalty-account', accountId], () => loyalty.account(accountId), {
    enabled: !!accountId,
    refetchInterval: live.refetchInterval,
  })
  const member = accountId ? memberQuery.data : null
  const memberError = accountId && memberQuery.error ? staffMessage(memberQuery.error) : ''
  // 「这位顾客今天」：今天的预约和正在计时的桌，从现场那一份里按这位顾客挑
  const overview = useStaffOverview(billing, live.refetchInterval)
  const refreshAll = useRefreshAll()
  useLeaveGuard(false, busy)
  useEffect(() => {
    // 结账在结账页（一屏结清）。这个深链是旧入口，留着做重定向：桌码、通知里可能还带着它，断掉不如接住。
    if (params.orderId) void navigateApp(`/pages/staff/checkout/index?id=${encodeURIComponent(params.orderId)}`, true)
  }, [params.orderId])
  useEffect(() => {
    setSheet('')
    setShowEntries(false)
    setRegistered(null)
    setIssued(null)
  }, [accountId])
  // 返回是否真正执行成功：调用方据此决定要不要关掉弹层、清掉已用过的输入。
  const act = async (input: LoyaltyAction, confirmation?: string) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    try {
      if (
        confirmation &&
        !(
          await Taro.showModal({
            title: confirmCopy[input.action]?.title || '确认操作',
            content: confirmation,
            confirmText: confirmCopy[input.action]?.confirmText || '确认',
          })
        ).confirm
      )
        return false
      const result = await loyalty.action(withChosenMember(input, accountId, member?.version))
      if (input.action === 'consume' || input.action === 'recharge') {
        setRegistered(registeredEntry(member?.entries || [], result.entries, input.action) || null)
      } else void Taro.showToast({ title: '已办好', icon: 'success' })
      await refreshAll()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const openAccount = async (input: Parameters<typeof loyalty.openAccount>[0]) => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await loyalty.openAccount(input)
      setChosen(result.account)
      setNotice(result.existing ? '这个手机号已经有账户，已为你打开' : '已代开会员')
      await refreshAll()
      return true
    } catch (e) {
      setError(staffMessage(e))
      return false
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  // AccountSearch 保留服务端会员摘要里的未认领标记。
  const choose = (account: AccountChoice | null) => {
    setChosen(account)
    setNotice('')
    setSearch('')
  }
  /** 先问一句，点了确认才做；弹窗起不来就不做。 */
  const sure = async (title: string, content: string, confirmText: string) => {
    try {
      return (await Taro.showModal({ title, content, confirmText, cancelText: '再看看' })).confirm
    } catch {
      return false
    }
  }
  /** 预约到店开台：预约已经关联了这位顾客，按预约的套餐开；等确认的也能开（不再发「预约成功」通知）。 */
  const seat = async (entry: ReservationEntry) => {
    if (pending.current) return
    const x = entry.reservation
    const ok = await sure(
      '到店开台？',
      `给 ${chosen?.nickname || '这位顾客'} 按「${x.packageName}」从现在开始计时（预约 ${storeClock(x.startAt)}${
        entry.tableNumber ? ` · ${entry.tableNumber} 号桌` : ''
      }）。${entry.displayStatus === 'pending' ? '这条预约还没确认，开台就算到店了，不再发「预约成功」通知。' : ''}`,
      '开台',
    )
    if (!ok) return
    const targetId = x.id
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await reservations.action({ action: 'seat', targetId })
      void Taro.showToast({ title: '已开台', icon: 'success' })
      await refreshAll()
    } catch (e) {
      setError(staffMessage(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  /** 发认领用的临时密码：问过再发，发了在弹层里显示临时密码。 */
  const issuePassword = async () => {
    if (pending.current || !chosen) return
    const ok = await sure(
      '发临时密码？',
      `给 ${chosen.nickname || '这位顾客'} 一个临时密码，在小程序登录页认领会员用；之前发的作废。已经绑好微信的顾客用不上。`,
      '发临时密码',
    )
    if (!ok) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      setIssued(await staffApi.issueTemporaryPassword(chosen.id))
    } catch (e) {
      setError(staffMessage(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const today = isoDate(storeDate(0)).slice(5)
  const bookedToday = (overview.data?.reservations || []).filter(
    (entry) =>
      entry.reservation.accountId === accountId &&
      storeDayLabel(entry.reservation.startAt) === today &&
      (entry.displayStatus === 'pending' || entry.displayStatus === 'confirmed'),
  )
  const sitting = (overview.data?.sessions || []).filter((session) => session.accountId === accountId)
  const tableOf = (id: string) => overview.data?.tables.find((table) => table.id === id)
  const gifts = member ? pendingGifts(member) : []
  const birthday = member?.profile.birthday || ''
  return (
    <StaffScreen title="会员">
      <View
        className="member-page-content"
        style={{ '--member-sheet-top': `${navbarHeight(false) - 4}px` } as CSSProperties}
      >
        <View className="member-find">
          <AccountSearch
            label="找会员"
            keyword={search}
            onKeyword={setSearch}
            selected={chosen}
            onSelect={choose}
            disabled={busy}
            paged
            refetchInterval={live.refetchInterval}
            resource="loyalty-members"
            load={loyalty.members}
            hint="未输入关键字时按昵称排列全部会员。"
            empty="没有匹配的会员，可换个关键字。"
            scan={!chosen}
            placeholder="手机号后四位、称呼"
            showResults={!chosen || !!search.trim()}
            inputAction={
              <Button className="member-open" disabled={busy} onClick={() => setSheet('open')}>
                代开
              </Button>
            }
          />
        </View>
        {notice && (
          <View className="field-help" role="status">
            {notice}
          </View>
        )}
        {(error || memberError) && (
          <View className="inline-error" role="alert">
            {error || memberError}
          </View>
        )}
        {!chosen && (
          <SectionEmpty
            title="先找到这位顾客"
            message="扫顾客的会员码，或按昵称、手机尾号、完整手机号查找，选中后办理充值、兑换、加减或核销生日礼物。"
          />
        )}
        {chosen && (
          <View className="member-card">
            <View className="member-card-head">
              <Text className="member-card-initial">{(chosen.nickname || '会').slice(0, 1)}</Text>
              <View className="member-card-copy">
                <Text className="member-card-name">{chosen.nickname || '未命名顾客'}</Text>
                <Text className="member-card-meta">
                  {member?.balance.tierName || '普通会员'} · {phoneTail(chosen.phoneMasked)} ·{' '}
                  {birthday
                    ? `${birthday === today ? '今天生日 · ' : '生日 '}${Number(birthday.slice(0, 2))}月${Number(birthday.slice(3))}日`
                    : '没填生日'}
                </Text>
              </View>
              <Button className="member-card-switch" disabled={busy} onClick={() => choose(null)}>
                换一位
              </Button>
            </View>
            {chosen.unclaimed && (
              <>
                <Text className="badge">店员代开 · 未认领</Text>
                <Text className="field-help">顾客可在小程序登录页认领，临时密码点下面的「发临时密码」发。</Text>
              </>
            )}
            {member ? <WalletRow member={member} /> : <Text className="member-card-loading">正在读取会员资产…</Text>}
            <Button className="member-card-link" disabled={busy} onClick={() => void issuePassword()}>
              发临时密码
            </Button>
          </View>
        )}
        {member && (
          <>
            <View className="member-actions">
              <Button
                className="member-action member-action-primary"
                disabled={busy}
                onClick={() => setSheet('consume')}
              >
                <Text className="member-action-title">消费登记</Text>
                <Text className="member-action-note">扣余额和豆板次数</Text>
              </Button>
              <Button className="member-action" disabled={busy} onClick={() => setSheet('recharge')}>
                <Text className="member-action-title">到店充值</Text>
                <Text className="member-action-note">按已发布方案</Text>
              </Button>
              <Button className="member-action" disabled={busy} onClick={() => setSheet('exchange')}>
                <Text className="member-action-title">积分兑换</Text>
                <Text className="member-action-note">扣积分出一件</Text>
              </Button>
              <Button className="member-action" disabled={busy} onClick={() => setSheet('adjust')}>
                <Text className="member-action-title">手动加减</Text>
                <Text className="member-action-note">要写原因</Text>
              </Button>
            </View>
            {gifts.map((gift) => (
              <View className="member-gift" key={gift.id}>
                <View className="member-gift-copy">
                  <Text className="member-gift-title">生日礼物待领</Text>
                  <Text className="member-gift-meta">
                    {gift.rule?.name || '生日礼物'} · 交给顾客后点核销，库存减一件
                  </Text>
                </View>
                <Button
                  className="member-gift-button"
                  disabled={busy}
                  onClick={() => {
                    void act({ action: 'fulfill_gift', targetId: gift.id }, '确认交付生日礼物并扣减库存？')
                  }}
                >
                  核销
                </Button>
              </View>
            ))}
            <View className="member-today">
              <Text className="member-section-title">这位顾客今天</Text>
              <View className="member-today-list">
                {bookedToday.map((entry) => {
                  const x = entry.reservation
                  return (
                    <View className="member-today-row" key={x.id}>
                      <View className="member-today-copy">
                        <Text className="member-today-title">
                          预约 {storeClock(x.startAt)}–{storeClock(entry.endAt)}
                          {entry.tableNumber ? ` · ${entry.tableNumber} 号桌` : ''}
                        </Text>
                        <Text className="member-today-meta">
                          {entry.displayStatus === 'confirmed' ? '已确认' : '等确认'}
                          {x.coupon ? ` · ${couponText(x.coupon)}` : ''}
                        </Text>
                      </View>
                      <Button className="member-today-button" disabled={busy} onClick={() => void seat(entry)}>
                        开台
                      </Button>
                    </View>
                  )
                })}
                {sitting.map((session) => {
                  const table = tableOf(session.serviceTableId)
                  return (
                    <Button
                      className="member-today-row"
                      key={session.id}
                      onClick={() =>
                        void navigateApp(
                          `/pages/staff/tables/index?tableId=${encodeURIComponent(session.serviceTableId)}`,
                          true,
                        )
                      }
                    >
                      <View className="member-today-copy">
                        <Text className="member-today-title">
                          {table?.code || '桌位'} 计时中 · {storeClock(session.startedAt)} 开始
                        </Text>
                        <Text className="member-today-meta">点开看会话</Text>
                      </View>
                      <Text className="member-today-arrow">›</Text>
                    </Button>
                  )
                })}
                {!bookedToday.length && !sitting.length && (
                  <Text className="member-today-empty">今天没有预约，现在也没有在计时</Text>
                )}
              </View>
            </View>
            <Button className="member-entries-toggle" onClick={() => setShowEntries((value) => !value)}>
              {showEntries ? '收起会员流水' : '会员流水与核销记录'}
            </Button>
            {showEntries && <EntryList member={member} busy={busy} />}
            {sheet === 'recharge' && (
              <RechargeSheet
                unlimitedDates={unlimitedDates}
                member={member}
                busy={busy}
                act={act}
                onClose={() => setSheet('')}
              />
            )}
            {sheet === 'consume' && (
              <ConsumptionSheet
                key={accountId}
                unlimitedDates={unlimitedDates}
                member={member}
                name={chosen?.nickname}
                busy={busy}
                act={act}
                onClose={() => setSheet('')}
              />
            )}
            {sheet === 'exchange' && (
              <ExchangeSheet member={member} busy={busy} act={act} onClose={() => setSheet('')} />
            )}
            {sheet === 'adjust' && (
              <AdjustSheet key={accountId} member={member} busy={busy} act={act} onClose={() => setSheet('')} />
            )}
          </>
        )}
        {sheet === 'open' && <OpenMemberSheet busy={busy} open={openAccount} onClose={() => setSheet('')} />}
        {registered && (
          <MemberDoneSheet entry={registered} entries={member?.entries || []} onClose={() => setRegistered(null)} />
        )}
        {issued && (
          <StaffSheet
            title="临时密码"
            meta={`认领手机号 ${issued.phoneMasked} · 有效到 ${storeStamp(issued.expiresAt)}`}
            onClose={() => setIssued(null)}
            footer={
              <Button className="table-sheet-primary" onClick={() => setIssued(null)}>
                已告诉顾客
              </Button>
            }
          >
            <Text className="member-password" userSelect>
              {issued.temporaryPassword}
            </Text>
            <Text className="table-sheet-hint">
              请当面告诉顾客：在小程序登录页点「店员帮我开过会员，去认领」，填手机号和这个临时密码。关掉后就看不到了，忘了可以再发一次。
            </Text>
          </StaffSheet>
        )}
      </View>
    </StaffScreen>
  )
}
