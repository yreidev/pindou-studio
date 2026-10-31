package application

import "fmt"

func cents(n int64) string { return fmt.Sprintf("%d.%02d", n/100, n%100) }

// Preview explains a sample transaction without creating balances or promises.
func Preview(r Rule) (string, error) {
	if err := Validate(r); err != nil {
		return "", err
	}
	switch r.Kind {
	case "tier":
		return fmt.Sprintf("示例：原价 100.00 元，会员应付 %s 元。达到门槛 %s 元才获得该等级；已有等级按获赠时的规则保留。", cents(r.RateBasisPoints), cents(r.AmountCents)), nil
	case "recharge":
		text := fmt.Sprintf("顾客到店付款 %s 元，本金增加 %s 元，赠送余额增加 %s 元，赠送 %d 积分。", cents(r.AmountCents), cents(r.AmountCents), cents(r.GiftCents), r.Points)
		if r.BoardUses > 0 {
			text += fmt.Sprintf("另送智能豆板 %d 次，不过期。", r.BoardUses)
		}
		return text, nil
	case "earn":
		return fmt.Sprintf("示例：符合范围的实付消费 100.00 元，获得 %d 积分。每 %s 元赠 %d 积分，不足部分向下取整。", 10000/r.AmountCents*r.Points, cents(r.AmountCents), r.Points), nil
	case "redeem":
		return fmt.Sprintf("每 %d 积分抵 %s 元，须使用完整兑换份数。示例：优惠后应付 100.00 元时，抵扣上限 %s 元。最低使用 %d 积分。", r.Points, cents(r.AmountCents), cents(r.MaxBasisPoints), r.MinimumPoints), nil
	case "exchange":
		return fmt.Sprintf("兑换一件商品扣除 %d 积分、出库一件。累计兑换上限 %d 件，每人限 %d 次。", r.Points, r.Quantity, r.PerUserLimit), nil
	case "birthday":
		return fmt.Sprintf("生日福利每个自然年最多领取 %d 次，领取后 %d 天内有效。积分即时到账；礼物需员工核销；折扣与会员折扣取更优惠的一种。", r.PerUserLimit, r.ValidDays), nil
	case "package":
		price := "价格 " + cents(r.AmountCents) + " 元"
		if r.AmountCents == 0 {
			price = "未定价（系统内收费开着时不能用它开台、预约）"
		}
		if r.UntilClose {
			return fmt.Sprintf("开台用到当天打烊（「营业与预约」里的每天结束时间），%s。不能续时、不能暂停；预约从所选开始时间约到打烊。%s", price, overtimePreview(r)), nil
		}
		return fmt.Sprintf("开台 %d 分钟，%s。每次续时 %d 分钟，追加 %s 元；累计免费暂停 %d 分钟。停止计时后保留座位至结账。%s", r.DurationMinutes, price, r.RenewalMinutes, cents(r.RenewalCents), r.PauseLimitMinutes, overtimePreview(r)), nil
	case "free_timing":
		return fmt.Sprintf("自由计时每 %d 分钟 %s 元（折合每小时 %s 元），按实际使用时长（不含暂停）分块，不足一块按一块。示例：用了 31 分钟收 2 块 %s 元。", r.DurationMinutes, cents(r.AmountCents), cents(r.AmountCents*60/int64(r.DurationMinutes)), cents(2*r.AmountCents)), nil
	case "companion":
		return fmt.Sprintf("陪客不计时、仍占座，结账时自动带一行「%s」%s 元。", r.Name, cents(r.AmountCents)), nil
	}
	return "", ErrInvalid
}

// overtimePreview 说明套餐的超时处理，带一个按续时方案加收的例子。
func overtimePreview(r Rule) string {
	switch r.Overtime {
	case "renewal":
		over := r.OvertimeGraceMinutes + 15
		blocks := (over + r.RenewalMinutes - 1) / r.RenewalMinutes
		return fmt.Sprintf("超时按续时方案自动加收：超出不超过 %d 分钟不收，超过就从套餐结束时起每 %d 分钟加收 %s 元，不足 %d 分钟按 %d 分钟算。示例：超时 %d 分钟加收 %d 块共 %s 元。",
			r.OvertimeGraceMinutes, r.RenewalMinutes, cents(r.RenewalCents), r.RenewalMinutes, r.RenewalMinutes, over, blocks, cents(int64(blocks)*r.RenewalCents))
	case "manual":
		return "超时提示员工处理，不自动加收。"
	}
	return "超时不加收。"
}
