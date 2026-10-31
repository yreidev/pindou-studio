import { useState } from 'react'
import { Checkbox, CheckboxGroup, Label, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { Button } from '../../../components/button'
import { PageControls, pageSlice } from '../../../components/pagination'
import { DateField, Field, Stepper } from '../../../components/staff'
import { DoneMark } from '../../../components/done-mark'
import { StaffSheet } from '../../../components/staff/table-sheet'
import {
  adjustPlan,
  emptyAdjustForm,
  parseSignedYuan,
  reasonMaxLength,
  type AdjustForm,
} from '../../../services/adjust'
import { type Entry, type LoyaltyAction, type Member } from '../../../services/membership'
import { money, moneyText } from '../../../services/format'
import { byDuration } from '../../../services/packages'
import { memberCopy } from '../../../services/member-copy'
import { isoDate, relativeDayLabel, storeDate } from '../../../services/reservations'

import { memberEntry } from '../../../services/member-entry'
import {
  consumptionPlan,
  dayTypeForDate,
  earliestServiceDate,
  serviceDateProblem,
  serviceToday,
  type ConsumptionForm,
} from '../../../services/member-consumption'
import { loginPhone, loginPhoneIsValid } from '../../../services/customer'
import { memberAccountTitle, memberConsumptionTitle } from '../../../brand'
import { nativeColors } from '../../../theme'

// 会员页的几块：会员卡上的资产、「消费登记 / 到店充值 / 积分兑换 / 手动加减」四个底部弹层、生日礼物核销、流水。
// 规则不变，也不受系统内收费开关影响（docs/plan-timing-without-billing.md 第 5 节）。
// 退回充值、撤销消费与退款在电脑后台（「会员资产」「订单与退款」）。

/** 到店充值的线下收款方式 */
export type PayMethod = NonNullable<LoyaltyAction['method']>
export type Act = (input: LoyaltyAction, confirmation?: string) => Promise<boolean>

const methods: { value: PayMethod; label: string }[] = [
  { value: 'wechat', label: '微信' },
  { value: 'cash', label: '现金' },
  { value: 'alipay', label: '支付宝' },
]

/** 还没核销的生日礼物（生日福利是礼物、还没有对应的核销流水）。 */
export const pendingGifts = (member: Member) =>
  member.entries.filter(
    (e) =>
      e.kind === 'birthday' &&
      e.rule?.scope === 'gift' &&
      !member.entries.some((x) => x.kind === 'fulfill_gift' && x.sourceId === e.id),
  )

export function WalletRow({ member }: { member: Member }) {
  return (
    <View className="member-wallet">
      <View className="member-wallet-item">
        <Text className="member-wallet-label">余额</Text>
        <Text className="member-wallet-value">
          ¥{moneyText(member.balance.principalCents + member.balance.giftCents)}
        </Text>
        {member.balance.giftCents > 0 && (
          <Text className="member-wallet-gift">含赠送 ¥{moneyText(member.balance.giftCents)}</Text>
        )}
      </View>
      <View className="member-wallet-item">
        <Text className="member-wallet-label">智能豆板</Text>
        <Text className="member-wallet-count">{member.balance.boardUses} 次</Text>
      </View>
      <View className="member-wallet-item">
        <Text className="member-wallet-label">积分</Text>
        <Text className="member-wallet-value">{member.balance.points}</Text>
      </View>
    </View>
  )
}

/** 到店充值：先选线下收的是哪种，再点方案；确认后本金入账、送赠送余额和积分。 */
export function RechargeSheet({
  unlimitedDates = false,
  member,
  busy,
  act,
  onClose,
}: {
  unlimitedDates?: boolean
  member: Member
  busy: boolean
  act: Act
  onClose: () => void
}) {
  const [serviceDate, setServiceDate] = useState(serviceToday)
  const [error, setError] = useState('')
  const [method, setMethod] = useState<PayMethod>('wechat')
  const rules = member.rules.filter((r) => r.kind === 'recharge')
  return (
    <StaffSheet title="到店充值" meta="按已发布的充值方案，钱在店里线下收" busy={busy} onClose={onClose}>
      <ServiceDateField
        label="充值日期"
        value={serviceDate}
        onChange={(value) => {
          setServiceDate(value)
          setError('')
        }}
        unlimited={unlimitedDates}
        busy={busy}
      />
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
      <View className="table-sheet-section">
        <Text className="table-sheet-label">收款方式</Text>
        <View className="table-sheet-grid">
          {methods.map((item) => (
            <Button
              key={item.value}
              className={`table-sheet-choice ${method === item.value ? 'table-sheet-choice-on' : ''}`}
              ariaLabel={`${item.label}${method === item.value ? '，已选中' : ''}`}
              disabled={busy}
              onClick={() => setMethod(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </View>
      </View>
      <View className="table-sheet-section">
        <Text className="table-sheet-label">充值方案</Text>
        {rules.map((r) => (
          <Button
            key={r.id}
            className="member-option member-recharge-option"
            disabled={busy}
            onClick={() => {
              const problem = serviceDateProblem(serviceDate, unlimitedDates)
              if (problem) {
                setError(problem)
                return
              }
              void act(
                { action: 'recharge', targetId: r.id, method, serviceDate },
                `${serviceDate} 已收到该顾客 ¥${money(r.amountCents)}？确认后本金入账，赠送 ¥${money(r.giftCents)} 和 ${r.points} 积分${r.boardUses ? `、智能豆板 ${r.boardUses} 次` : ''}。`,
              ).then((done) => done && onClose())
            }}
          >
            <Text className="member-option-name">{r.name}</Text>
            <Text className="member-option-note">
              ¥{money(r.amountCents)}
              {r.giftCents ? ` 送 ¥${money(r.giftCents)}` : ''}
              {r.points ? ` · ${r.points} 积分` : ''}
              {r.boardUses ? ` · 送智能豆板 ${r.boardUses} 次` : ''}
            </Text>
          </Button>
        ))}
        {rules.length === 0 && (
          <Text className="field-help">暂无已发布充值方案（老板在电脑后台「经营规则」里发布）。</Text>
        )}
      </View>
    </StaffSheet>
  )
}

/** 积分兑换：扣积分、出库一件。 */
export function ExchangeSheet({
  member,
  busy,
  act,
  onClose,
}: {
  member: Member
  busy: boolean
  act: Act
  onClose: () => void
}) {
  const rules = member.rules.filter((r) => r.kind === 'exchange')
  return (
    <StaffSheet
      title="积分兑换"
      meta={`现有 ${member.balance.points} 积分 · 扣积分出一件`}
      busy={busy}
      onClose={onClose}
    >
      {rules.map((r) => (
        <Button
          key={r.id}
          className="member-option"
          disabled={busy || member.balance.points < r.points}
          onClick={() => {
            void act({ action: 'exchange', targetId: r.id }, `扣除 ${r.points} 积分并出库一件 ${r.name}？`).then(
              (done) => done && onClose(),
            )
          }}
        >
          <Text className="member-option-name">{r.name}</Text>
          <Text className="member-option-note">
            {r.points} 积分{member.balance.points < r.points ? ' · 积分不够' : ''}
          </Text>
        </Button>
      ))}
      {rules.length === 0 && <Text className="field-help">暂无已发布兑换商品。</Text>}
    </StaffSheet>
  )
}

/**
 * 手动加减（2026-10-10 起所有员工都能办）：本金、赠送余额、积分可加可减（减写负号），必须写原因；
 * 扣成负数的不提交（后端也拒绝）。确认框写清本次加减和调整后的数；另记一条「资产调整」流水，不改写已有记录。
 * 提交带这位会员资产的版本（withChosenMember），别人刚改过时后端回 409，重读后再确认。
 */
export function AdjustSheet({
  member,
  busy,
  act,
  onClose,
}: {
  member: Member
  busy: boolean
  act: Act
  onClose: () => void
}) {
  const [form, setForm] = useState<AdjustForm>(emptyAdjustForm)
  const [error, setError] = useState('')
  const set = (patch: Partial<AdjustForm>) => {
    setForm((value) => ({ ...value, ...patch }))
    setError('')
  }
  const submit = async () => {
    const plan = adjustPlan(form, member.balance)
    if (plan.error) {
      setError(plan.error)
      return
    }
    if ('change' in plan && (await act({ action: 'adjust', ...plan.change }, plan.confirmation))) {
      setForm(emptyAdjustForm)
      onClose()
    }
  }
  return (
    <StaffSheet
      title="手动加减"
      meta="加就填正数，减就写负号（如 -10）；不改的项留空"
      busy={busy}
      dirty={Object.values(form).some((value) => !!value?.trim())}
      onClose={onClose}
      footer={
        <Button className="table-sheet-primary" disabled={busy} onClick={() => void submit()}>
          确认加减
        </Button>
      }
    >
      <Field label="本金（元）" value={form.principal} onChange={(principal) => set({ principal })} disabled={busy} />
      <Field label="赠送余额（元）" value={form.gift} onChange={(gift) => set({ gift })} disabled={busy} />
      <Field label="积分" value={form.points} onChange={(points) => set({ points })} disabled={busy} />
      <Field
        label="智能豆板次数"
        value={form.boardUses || ''}
        onChange={(boardUses) => set({ boardUses })}
        disabled={busy}
      />
      <View className="staff-field">
        <Text className="field-label">原因（必填）</Text>
        <Textarea
          className="input"
          maxlength={reasonMaxLength}
          disabled={busy}
          value={form.reason}
          placeholder="如：补录线下充值、美团团购扣储值"
          onInput={(event) => set({ reason: event.detail.value })}
        />
      </View>
      <Text className="field-help">调整后不能是负数。退回充值在电脑后台「会员资产」里办。</Text>
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </StaffSheet>
  )
}

/** 会员流水（含生日福利、核销记录），新的在前，20 条一页。 */
export function EntryList({ member, busy }: { member: Member; busy: boolean }) {
  const [page, setPage] = useState(0)
  return (
    <View className="member-entries">
      {member.entries.length === 0 && <Text className="field-help">这位会员还没有流水。</Text>}
      {pageSlice(member.entries.slice().reverse(), page).map((e) => {
        const detail = memberEntry(e, member.entries)
        const copy = memberCopy(e, member.entries)
        return (
          <View className="member-entry" key={e.id}>
            <Text className="member-entry-title">{detail.title}</Text>
            <Text className="member-entry-meta">{detail.date}</Text>
            {detail.reversed && <Text className="badge">已撤销</Text>}
            {detail.lines.map((line, i) => (
              <Text className="member-entry-meta" key={i}>
                {line}
              </Text>
            ))}
            {copy && (
              <Button className="member-entry-copy" disabled={busy} onClick={() => void copyToCustomer(copy)}>
                复制
              </Button>
            )}
          </View>
        )
      })}
      <PageControls page={page} total={member.entries.length} onChange={setPage} disabled={busy} />
    </View>
  )
}

/** 日期范围只是输入提示，提交前和后端仍会再次校验。 */
export function ServiceDateField({
  label,
  value,
  onChange,
  unlimited,
  busy,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  unlimited: boolean
  busy: boolean
}) {
  return (
    <DateField
      className="member-service-date"
      label={label}
      value={value}
      text={relativeDayLabel(value)}
      start={earliestServiceDate(unlimited)}
      end={serviceToday()}
      disabled={busy}
      onChange={onChange}
      clearable={false}
      inlinePresets
      help={unlimited ? undefined : '最早 7 天前，更早的请店长补'}
      presets={[
        { text: '今天', value: serviceToday() },
        { text: '昨天', value: isoDate(storeDate(-1)) },
      ]}
    />
  )
}

export function ConsumptionSheet({
  member,
  name,
  busy,
  act,
  onClose,
  unlimitedDates = false,
}: {
  member: Member
  name?: string
  busy: boolean
  act: Act
  onClose: () => void
  unlimitedDates?: boolean
}) {
  const [form, setForm] = useState<ConsumptionForm>(() => {
    const serviceDate = serviceToday()
    return {
      serviceDate,
      packageId: '',
      headcount: 1,
      dayType: dayTypeForDate(serviceDate),
      amount: '',
      boardUses: '0',
      reason: '',
    }
  })
  const [packagePicked, setPackagePicked] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<ConsumptionForm>) => {
    setForm((value) => ({ ...value, ...patch }))
    setError('')
  }
  const submit = async () => {
    if (!packagePicked) {
      setError('请选择套餐')
      return
    }
    const plan = consumptionPlan(form, member, unlimitedDates)
    if (!('input' in plan)) {
      setError(plan.error)
      return
    }
    if (await act(plan.input, plan.confirmation)) onClose()
  }
  const packages = byDuration(member.rules.filter((r) => r.kind === 'package' && r.enabled))
  // 只供提交前核对；登记后的余额和次数始终读取流水快照。
  const amount = Math.max(0, parseSignedYuan(form.amount) ?? 0)
  const balance = member.balance.principalCents + member.balance.giftCents
  const deducted = Math.min(amount, balance)
  const remaining = Math.max(0, member.balance.boardUses - Number(form.boardUses))
  return (
    <StaffSheet
      title={memberConsumptionTitle}
      className="member-consumption-sheet"
      closeIcon={
        <View className="member-sheet-close-icon">
          <View />
          <View />
        </View>
      }
      meta={`${name ? `${name} · ` : ''}余额 ¥${moneyText(balance)} · 智能豆板剩 ${member.balance.boardUses} 次`}
      busy={busy}
      dirty={!!form.amount.trim() || !!form.reason.trim()}
      onClose={onClose}
      footer={
        <View className="member-consumption-footer">
          <Text className="member-consumption-summary">
            扣完：余额 <Text className="member-summary-value">¥{moneyText(balance - deducted)}</Text> · 智能豆板剩{' '}
            <Text className="member-summary-value">{remaining} 次</Text>
            {amount > deducted ? ` · 另付 ¥${moneyText(amount - deducted)}` : ''}
          </Text>
          <Button className="table-sheet-primary" disabled={busy} onClick={() => void submit()}>
            确认登记 · 扣 ¥{moneyText(deducted)}
          </Button>
        </View>
      }
    >
      <ServiceDateField
        label="消费日期"
        value={form.serviceDate}
        onChange={(serviceDate) => set({ serviceDate, dayType: dayTypeForDate(serviceDate) })}
        unlimited={unlimitedDates}
        busy={busy}
      />
      <View className="table-sheet-section">
        <Text className="table-sheet-label">套餐</Text>
        <View className="table-sheet-grid">
          {[...packages.map((r) => ({ id: r.id, name: r.name })), { id: '', name: '其他' }].map((r) => (
            <Button
              key={r.id}
              className={`table-sheet-choice ${packagePicked && form.packageId === r.id ? 'table-sheet-choice-on' : ''}`}
              disabled={busy}
              ariaLabel={`${r.name}${packagePicked && form.packageId === r.id ? '，已选中' : ''}`}
              onClick={() => {
                setPackagePicked(true)
                set({ packageId: r.id })
              }}
            >
              {r.name}
            </Button>
          ))}
        </View>
      </View>
      <View className="member-consumption-pair">
        <View className="table-sheet-section">
          <Text className="table-sheet-label">人数</Text>
          <View className="table-sheet-segments">
            {([1, 2] as const).map((headcount) => (
              <Button
                key={headcount}
                className={`table-sheet-choice ${form.headcount === headcount ? 'table-sheet-choice-on' : ''}`}
                disabled={busy}
                onClick={() => set({ headcount })}
              >
                {headcount === 1 ? '单人' : '双人'}
              </Button>
            ))}
          </View>
        </View>
        <View className="table-sheet-section">
          <View className="member-field-heading">
            <Text className="table-sheet-label">日子</Text>
            <Text className="member-field-help">按日期自动</Text>
          </View>
          <View className="table-sheet-segments">
            {(['workday', 'holiday'] as const).map((dayType) => (
              <Button
                key={dayType}
                className={`table-sheet-choice ${form.dayType === dayType ? 'table-sheet-choice-on' : ''}`}
                disabled={busy}
                onClick={() => set({ dayType })}
              >
                {dayType === 'workday' ? '工作日' : '节假日'}
              </Button>
            ))}
          </View>
        </View>
      </View>
      <View className="member-consumption-pair">
        <Field
          type="digit"
          label="金额（元）"
          value={form.amount}
          onChange={(amount) => set({ amount })}
          disabled={busy}
        />
        <Stepper
          label="智能豆板"
          value={form.boardUses}
          onChange={(boardUses) => set({ boardUses })}
          disabled={busy}
          min={0}
          max={Math.min(100, member.balance.boardUses)}
          unit="次"
          displayOnly
          help={`剩 ${member.balance.boardUses} 次`}
        />
      </View>
      <View className="staff-field">
        <View className="member-field-heading">
          <Text className="field-label">备注</Text>
          <Text className="member-field-help">选「其他」时必填，不发给顾客</Text>
        </View>
        <Textarea
          className="input"
          value={form.reason}
          maxlength={reasonMaxLength}
          disabled={busy}
          placeholder="选填"
          onInput={(e) => set({ reason: e.detail.value })}
        />
      </View>
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </StaffSheet>
  )
}

async function copyToCustomer(text: string) {
  try {
    await Taro.setClipboardData({ data: text })
    void Taro.showToast({ title: '已复制，去微信粘贴给顾客', icon: 'none' })
    return true
  } catch {
    void Taro.showToast({ title: '复制失败，请重试', icon: 'none' })
    return false
  }
}

export function MemberDoneSheet({ entry, entries, onClose }: { entry: Entry; entries: Entry[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = memberCopy(entry, entries)
  const copy = async () => {
    if (text && (await copyToCustomer(text))) setCopied(true)
  }
  return (
    <StaffSheet title="已登记" heading={false} className="member-done-sheet" onClose={onClose}>
      <DoneMark className="member-done-mark" />
      <Text className="member-done-title">已登记</Text>
      {text && (
        <View className="member-copy-card">
          <Text className="member-copy-text" selectable>
            {text}
          </Text>
        </View>
      )}
      {text && (
        <Button className="table-sheet-primary" onClick={() => void copy()}>
          <View className="member-copy-icon">
            <View className="member-copy-icon-back" />
            <View className="member-copy-icon-front" />
          </View>
          {copied ? '已复制，去微信粘贴给顾客' : '复制给顾客'}
        </Button>
      )}
      <Button className="member-done-close" onClick={onClose}>
        完成
      </Button>
      <Text className="member-done-hint">会员流水里每一笔也能再复制</Text>
    </StaffSheet>
  )
}

export function OpenMemberSheet({
  busy,
  open,
  onClose,
}: {
  busy: boolean
  open: (input: { nickname: string; phone: string; consent: true }) => Promise<boolean>
  onClose: () => void
}) {
  const [nickname, setNickname] = useState('')
  const [phone, setPhone] = useState('')
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState('')
  const submit = async () => {
    if (!nickname.trim() || [...nickname.trim()].length > 50) {
      setError('请填写称呼，最多 50 字')
      return
    }
    if (!loginPhoneIsValid(phone)) {
      setError('请填写正确的手机号')
      return
    }
    if (!consent) {
      setError('请先确认顾客已同意门店记下称呼和手机号')
      return
    }
    if (await open({ nickname: nickname.trim(), phone: loginPhone(phone), consent: true })) onClose()
  }
  return (
    <StaffSheet
      title={memberAccountTitle}
      meta="顾客口头同意后再登记"
      busy={busy}
      dirty={!!nickname.trim() || !!phone.trim()}
      onClose={onClose}
      footer={
        <Button className="table-sheet-primary" disabled={busy} onClick={() => void submit()}>
          确认代开
        </Button>
      }
    >
      <Field label="称呼" value={nickname} onChange={setNickname} disabled={busy} />
      <Field label="手机号" value={phone} onChange={setPhone} disabled={busy} />
      <CheckboxGroup onChange={(e) => setConsent(e.detail.value.includes('consent'))}>
        <Label>
          <Checkbox value="consent" checked={consent} disabled={busy} color={nativeColors.action} />
          <Text>顾客已同意门店记下称呼和手机号</Text>
        </Label>
      </CheckboxGroup>
      {error && (
        <View className="field-error" role="alert">
          {error}
        </View>
      )}
    </StaffSheet>
  )
}
