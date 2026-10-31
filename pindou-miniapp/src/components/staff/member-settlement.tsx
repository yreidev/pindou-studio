import { Switch, Text, View } from '@tarojs/components'
import { Field } from '../staff'
import { type Quote } from '../../services/membership'

/**
 * 结账页里的「会员抵扣」一段。
 *
 * ★ 这一段以前是**另一个页面**：结账页有个「会员结账 · 积分与余额」大按钮，点了跳到
 *   「会员与计时 › 结账」tab，在那儿再选一次收款方式、再确认一次。一次结账两个页面、
 *   两次选方式。更糟的是后端 `orders.go:225` 规定「订单带账户 + 门店有任何已发布规则
 *   → 普通收款一律 409」，而门店确实发布了套餐，所以**所有注册顾客**在结账页点
 *   「确认已收款」都会在最后一步被打回，必须去那一页。
 *
 * 现在它只是结账页上的一段，默认什么都不用动：打开页面就已经按「不用积分、不用余额」
 * 预览过一次，店员直接收线下款即可（业主 2026-09-20 确认允许）。要抵扣才动这两个控件。
 */
export function MemberSettlement({
  quote,
  points,
  setPoints,
  useBalance,
  setUseBalance,
  balance = '',
  setBalance = () => {},
  balanceError = '',
  disabled,
}: {
  quote: Quote | null
  points: string
  setPoints: (value: string) => void
  useBalance: boolean
  setUseBalance: (value: boolean) => void
  /** 这次用多少储值（元）：空着就是能用多少用多少；会员只用储值付自己那份时填。 */
  balance?: string
  setBalance?: (value: string) => void
  balanceError?: string
  disabled: boolean
}) {
  return (
    <View className="staff-section member-settlement">
      <Text className="staff-section-title">会员抵扣</Text>
      <View className="member-settlement-row">
        <View className="member-settlement-copy">
          <Text className="strong">用储值余额</Text>
          <Text className="field-help">本金和赠送一起算，先扣本金</Text>
        </View>
        <Switch checked={useBalance} disabled={disabled} onChange={(e) => setUseBalance(e.detail.value)} />
      </View>
      {useBalance && (
        // 多人合付时会员只用储值付自己那份：填这次用多少，空着照旧能用多少用多少。超了由后端说明
        <Field
          label="这次用多少储值（元）"
          type="digit"
          placeholder="全部可用"
          help="只付会员自己那份时填，不超过可用储值和这一笔应付；先扣本金，再扣赠送"
          value={balance}
          onChange={setBalance}
          error={balanceError}
          disabled={disabled}
        />
      )}
      <Field label="使用积分" type="number" value={points} onChange={setPoints} disabled={disabled} />
      {/* 报价的明细（原应收、会员优惠、积分、储值、线下补付）在结账页顶部的汇总卡里 */}
      {!quote && <Text className="field-help">正在按当前明细计算会员优惠…</Text>}
    </View>
  )
}
