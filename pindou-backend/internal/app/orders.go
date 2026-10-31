package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
	ordersdomain "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/domain"
)

// createOrder 建单（员工）：桌位会话已有草稿时返回那张草稿，结算或取消后不能再建。
func (s *Server) createOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.staffMember(w, r)
	if !ok {
		return
	}
	if idemKey(r) == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	var in struct {
		TableSessionID string `json:"venueSessionId"`
		UserID         string `json:"accountId"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	q := s.tx(r)
	fingerprintBytes, _ := json.Marshal(in)
	fingerprint := identityKey(string(fingerprintBytes))
	cacheKey := "create-order:" + u.ID + ":" + idemKey(r)
	if cached := q.idemGet(cacheKey); cached != nil {
		if cached.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
			return
		}
		w.Header().Set("Content-Type", cached.ContentType)
		w.WriteHeader(cached.Status)
		_, _ = w.Write(cached.Body)
		return
	}
	session := q.session(in.TableSessionID)
	if in.TableSessionID != "" && session == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if session != nil {
		if !liveSession(session) {
			s.writeError(w, r, 409, "session_closed", errors.New("该会话已结束"))
			return
		}
		in.UserID = session.UserID
		for _, existing := range q.ordersOfSession(session.ID) {
			if existing.Status != ordersdomain.StatusVoided {
				// 草稿或部分付款（分笔付款收了一部分）的单都还没收齐：去结账就回到这张单，接着收
				if !ordersapp.Open(*existing) {
					s.writeError(w, r, 409, "session_closed", errors.New("该会话已有结算完成的订单"))
					return
				}
				view := s.orderView(q, *existing)
				body, _ := json.Marshal(view)
				q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: body})
				writeJSON(w, 200, view)
				return
			}
		}
	}
	if in.UserID != "" && q.user(in.UserID) == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	o := &Order{ID: id(), TableSessionID: in.TableSessionID, UserID: in.UserID, Status: "draft", CreatedAt: q.now()}
	// 桌位会话建单时按计时自动带明细。以前这里是一张白单，店员要手打「计时收费 29.90」，
	// 而系统明知道计了多久、也明知道门店发布的套餐价（见 session_billing.go 的说明）。
	// 匹配不上套餐时带的是 0 价占位行，仍然要店员填价 —— 但至少时长已经写在那儿了。
	// 开头这几行记为系统生成（AutoLines）：之后跟着计时重算，员工改过就不再自动改。
	if session != nil {
		o.Lines = chargeLines(s.sessionCharge(q, session))
		if len(o.Lines) > 0 {
			o.AutoLines = autoLines(len(o.Lines))
		}
		if err := ordersapp.Reprice(o); err != nil {
			s.writeError(w, r, 500, "internal_error", err)
			return
		}
	}
	q.addOrder(o)
	view := s.orderView(q, *o)
	body, _ := json.Marshal(view)
	q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 201, ContentType: "application/json", Body: body})
	writeJSON(w, 201, view)
}

// getOrder 是一张订单：员工都能看，顾客只能看自己的。
func (s *Server) getOrder(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	oid := r.PathValue("id")
	if !validID(oid) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	employee := hasRole(u, Clerk, Manager, Owner)
	q := s.tx(r)
	o := q.order(oid)
	if o == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if !employee && o.UserID != u.ID {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	writeJSON(w, 200, s.orderView(q, *o))
}

// changeOrder 处理改订单的写请求（员工）：kind 是 lines（改明细）、customer（换顾客账户）、payments、refunds、discounts
// 或 comps（免单）。
func (s *Server) changeOrder(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.signedIn(w, r)
		if !ok {
			return
		}
		oid := r.PathValue("id")
		if !validID(oid) {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		if !hasRole(u, Clerk, Manager, Owner) {
			s.writeError(w, r, 403, "forbidden", errForbidden)
			return
		}
		s.orderMutation(w, r, u, oid, kind)
	}
}

func idemKey(r *http.Request) string { return strings.TrimSpace(r.Header.Get("Idempotency-Key")) }

func (s *Server) orderMutation(w http.ResponseWriter, r *http.Request, u *User, oid, kind string) {
	key := idemKey(r)
	if key == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	if (kind == "discounts" || kind == "refunds" || kind == "comps") && !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	var in struct {
		ExpectedVersion string      `json:"expectedVersion"`
		Lines           []OrderLine `json:"lines"`
		Kind            string      `json:"kind"`
		Method          string      `json:"method"`
		AmountCents     int64       `json:"amountCents"`
		RateBasisPoints int64       `json:"rateBasisPoints"`
		Reason          string      `json:"reason"`
		// omitempty：不带这个字段时请求的序列化结果与加字段之前一致，
		// 幂等指纹不变，升级前发出的重试不会变成 idempotency_conflict。
		ReturnedProducts map[string]int64 `json:"returnedProducts,omitempty"`
		// AccountID 只用于换顾客（customer）：账户编号，或 null 表示改成散客；不带是请求不全。
		// 原样留着 JSON 才分得清 null 和没带。omitempty 同上：别的写请求的指纹不变。
		AccountID json.RawMessage `json:"accountId,omitempty"`
		// CashReceivedCents 只用于收款（payments）：现金收款时员工可选填的实收现金（整数分），后端据此记找零。
		// 指针分得清没填和填了 0；omitempty 同上：不带时指纹不变。
		CashReceivedCents *int64 `json:"cashReceivedCents,omitempty"`
		// PaymentID 只用于退款（refunds）：退的是哪一笔付款。分几笔收的单必须选，一笔收齐的可以不带。omitempty 同上。
		PaymentID string `json:"paymentId,omitempty"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	customer, customerErr := customerInput(kind, in.AccountID)
	if customerErr != nil {
		s.writeError(w, r, 400, "invalid_request", customerErr)
		return
	}
	if in.CashReceivedCents != nil && kind != "payments" {
		s.writeError(w, r, 400, "invalid_request", errors.New("只有收款能带实收现金"))
		return
	}
	if in.PaymentID != "" && (kind != "refunds" || !validID(in.PaymentID)) {
		s.writeError(w, r, 400, "invalid_request", errors.New("只有退款能选付款，且要是付款记录的编号"))
		return
	}
	for _, line := range in.Lines {
		// productId 落库时转成 uuid；不是 UUID 的值会让保存失败，只能换来一个 503。
		if line.ProductID != "" && !validID(line.ProductID) {
			s.writeError(w, r, 400, "invalid_request", errors.New("明细里的商品编号无效，请重新选择商品"))
			return
		}
	}
	versionBytes, versionErr := hex.DecodeString(in.ExpectedVersion)
	if versionErr != nil || len(versionBytes) != sha256.Size || in.ExpectedVersion != strings.ToLower(in.ExpectedVersion) || (kind == "lines" && in.Lines == nil) {
		s.writeError(w, r, 400, "invalid_request", errors.New("expectedVersion and operation fields are required"))
		return
	}
	fingerprintBytes, _ := json.Marshal(in)
	fingerprint := identityKey(string(fingerprintBytes))
	cacheKey := "order:" + u.ID + ":" + kind + ":" + oid + ":" + key
	q := s.tx(r)
	if cached := q.idemGet(cacheKey); cached != nil {
		if cached.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
			return
		}
		ct := cached.ContentType
		body := append([]byte(nil), cached.Body...)
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(cached.Status)
		_, _ = w.Write(body)
		return
	}
	o := q.order(oid)
	if o == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if err := ordersapp.CheckVersion(*o, in.ExpectedVersion); err != nil {
		s.writeError(w, r, 409, "order_version_conflict", err)
		return
	}
	// 会员结账走 /loyalty/actions；免单不动会员资产（不扣余额积分、不送积分），关联顾客的单也直接在这里办。
	// 会员价在收第一笔时就定了：部分付款的单（会员结账收了一部分，或门店还没有会员规则时收的）余下的照常在这里分笔收。
	if kind == "payments" && o.Status == ordersdomain.StatusDraft && o.UserID != "" && len(q.membership().Rules()) > 0 {
		s.writeError(w, r, 409, "loyalty_conflict", errors.New("请使用会员结账预览并确认收款"))
		return
	}
	if x := q.session(o.TableSessionID); x != nil && x.AdmissionID != "" && (kind == "lines" || kind == "discounts") {
		s.writeError(w, r, 409, "loyalty_conflict", errors.New("套餐订单按购买快照结算，其他消费请单独建单"))
		return
	}
	// 会员扫码入座的套餐订单：顾客是扫码申请的那个人，由会话决定（计时、呼叫店员、本次手作都认它），不能在订单上另换。
	if x := q.session(o.TableSessionID); x != nil && x.AdmissionID != "" && kind == "customer" {
		s.writeError(w, r, 409, "loyalty_conflict", errors.New("这是会员扫码入座的套餐订单，顾客由入座申请决定，不能更换"))
		return
	}
	var status = 201
	var err error
	switch kind {
	case "lines":
		if !hasRole(u, Manager, Owner) {
			if err = clerkLinePrices(q, *o, in.Lines); err != nil {
				break
			}
		}
		before := o.ReceivableCents
		var updated Order
		updated, err = ordersapp.UpdateLines(*o, in.Lines, in.ExpectedVersion)
		if err == nil {
			updated.AutoLines = keptAutoLines(*o, updated.Lines)
		}
		if err == nil && ordersapp.DiscountedToZero(updated) {
			// 已有的人工折扣在改便宜的明细上会把应收减到 0，同样收不了款
			err = ordersapp.ErrZeroReceivable
		}
		if err == nil {
			*o = updated
			// 改明细会改应收：留痕，对账时能看出谁、何时、从多少改成多少
			q.audit(u.ID, "order.lines.updated", o.ID, fmt.Sprintf("应收 ¥%s → ¥%s，明细 %d 行", yuanText(before), yuanText(o.ReceivableCents), len(o.Lines)), requestID(r))
		}
		status = 200
	case "customer":
		status = 200
		if o.Status != "draft" {
			err = ordersapp.ErrClosed
			break
		}
		if customer != "" && q.user(customer) == nil {
			err = errNotFound
			break
		}
		if customer == o.UserID {
			// 本来就是这位（或本来就是散客）：什么都不改，版本照旧，不记审计
			break
		}
		before := o.UserID
		o.UserID = customer
		// 换人留痕：谁、哪张单、从谁换成谁。只记称呼和账户编号，不记手机号
		labels := q.accountLabels([]string{before, customer})
		q.audit(u.ID, "order.customer.changed", o.ID, fmt.Sprintf("顾客 %s → %s", customerAuditName(labels, before), customerAuditName(labels, customer)), requestID(r))
	case "discounts":
		if !hasRole(u, Manager, Owner) {
			err = errForbidden
			break
		}
		if o.Status != "draft" {
			err = errors.New("只有草稿订单可以打折")
			break
		}
		if in.Reason == "" || utf8.RuneCountInString(in.Reason) > 200 || (in.Kind != "fixed" && in.Kind != "percentage") || (in.Kind == "fixed" && (in.AmountCents < 1 || in.RateBasisPoints != 0)) || (in.Kind == "percentage" && (in.RateBasisPoints < 1 || in.RateBasisPoints > 10000 || in.AmountCents != 0)) {
			err = errors.New("折扣无效")
			break
		}
		d := Discount{ID: id(), Kind: in.Kind, AmountCents: in.AmountCents, RateBasisPoints: in.RateBasisPoints, Reason: in.Reason, CreatedAt: q.now()}
		candidate := *o
		candidate.Discounts = append(append([]Discount(nil), o.Discounts...), d)
		if err = ordersapp.Reprice(&candidate); err != nil {
			break
		}
		if ordersapp.DiscountedToZero(candidate) {
			err = ordersapp.ErrZeroReceivable
			break
		}
		*o = candidate
		q.audit(u.ID, "order.discount.created", o.ID, in.Reason, requestID(r))
	case "payments":
		err = s.collectPayment(q, u, r, o, in.Method, in.AmountCents, in.CashReceivedCents)
	case "comps":
		err = s.compOrder(q, u, r, o, in.Reason, in.AmountCents)
	case "refunds":
		err = s.refundPayment(q, u, r, o, in.PaymentID, in.AmountCents, in.Reason, in.ReturnedProducts)
	}
	if err != nil {
		statusCode := 400
		code := "invalid_request"
		if errors.Is(err, errForbidden) || errors.Is(err, errClerkPrice) {
			statusCode = 403
			code = "forbidden"
		}
		if errors.Is(err, ordersapp.ErrClosed) {
			statusCode, code = 409, "order_closed"
		}
		if errors.Is(err, ordersapp.ErrInsufficientStock) {
			statusCode, code = 409, "insufficient_stock"
		}
		if errors.Is(err, ordersapp.ErrZeroReceivable) {
			statusCode, code = 409, "zero_receivable"
		}
		if errors.Is(err, errCompNoRefund) || errors.Is(err, ordersapp.ErrCompPayment) {
			statusCode, code = 409, "comp_not_refundable"
		}
		if errors.Is(err, ordersapp.ErrMemberPayment) {
			statusCode, code = 409, "loyalty_conflict"
		}
		if errors.Is(err, errNotFound) {
			statusCode, code = 404, "not_found"
			err = errors.New("没有这位顾客的账户，请刷新后重新选择")
		}
		s.writeError(w, r, statusCode, code, err)
		return
	}
	body, _ := json.Marshal(s.orderView(q, *o))
	body = append(body, '\n')
	q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: status, ContentType: "application/json", Body: body})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// errCompNoRefund：免单结清的订单没有收到钱，没有可退的。
var errCompNoRefund = errors.New("这一单是免单结清的，没有收到钱，不能退款")

// compOrder 免单（店长、老板）：这一单不收钱（或分笔付款收了一部分之后，剩下的不收了），直接结清（2026-10-06 业主定）。
// 必须写原因。
//
// 免单是一条单独的结清记录（付款记录，method 为 comp），不是把人工折扣打到 100%：应收照旧是原来的金额，
// 结清记录记下免掉多少（就是还差的那部分）和原因，实收（paidCents）不增加，所以免掉的部分没有可退的钱；
// 商品照常出库（东西给了顾客；部分付款的单收第一笔时已经出过库），计时会话随之结清。已付款订单只能追加退款，
// 免单之后不能改回、也不能再收款。审计记下谁、免了多少、为什么。
// amountCents 只是请求不该带的字段（契约里没有），带了说明客户端拿错了接口。
func (s *Server) compOrder(q *txn, u *User, r *http.Request, o *Order, reason string, amountCents int64) error {
	if amountCents != 0 {
		return errors.New("免单不带金额，免掉的就是现在还差的")
	}
	reason = strings.TrimSpace(reason)
	if reason == "" || utf8.RuneCountInString(reason) > 200 {
		return errors.New("请填写免单原因（200 字以内）")
	}
	if !ordersapp.Open(*o) {
		return ordersapp.ErrClosed
	}
	if session := q.session(o.TableSessionID); session != nil && !liveSession(session) {
		return errors.New("该会话已结束")
	}
	outstanding := ordersapp.OutstandingCents(*o)
	if outstanding < 1 {
		return errors.New("这一单应收是 0，不用免单：计时待填价的行请先填价，误开的台请撤销开台")
	}
	now := q.now()
	if o.Status == ordersdomain.StatusDraft {
		if err := shipGoods(q, u, o); err != nil {
			return err
		}
	}
	collected := o.PaidCents
	o.Payments = append(o.Payments, Payment{ID: id(), Method: ordersapp.PaymentComp, AmountCents: outstanding, Reason: reason, CreatedAt: now})
	o.Status = ordersdomain.StatusPaid
	if x := q.session(o.TableSessionID); x != nil {
		s.settleSession(q, x, now)
	}
	detail := fmt.Sprintf("免单 ¥%s：%s", yuanText(outstanding), reason)
	if collected > 0 {
		detail = fmt.Sprintf("已收 ¥%s，剩余 ¥%s 免单：%s", yuanText(collected), yuanText(outstanding), reason)
	}
	q.audit(u.ID, "order.comped", o.ID, detail, requestID(r))
	return nil
}

// shipGoods 是一张草稿收第一笔（收款、免单）时出库：核对库存够不够，够了按明细出库（东西这时就给了顾客，之后分笔收的
// 不再动库存）。库存不够时什么都不做。
func shipGoods(q *txn, u *User, o *Order) error {
	required := map[string]int64{}
	for _, l := range o.Lines {
		if l.ProductID != "" {
			required[l.ProductID] += int64(l.Quantity)
		}
	}
	for productID, quantity := range required {
		if it := q.stockByProduct(productID); it == nil || it.Quantity < quantity {
			return ordersapp.ErrInsufficientStock
		}
	}
	for productID, quantity := range required {
		it := q.stockByProduct(productID)
		it.Quantity -= quantity
		addMovement(q, it.ID, -quantity, "sale", o.ID, u.ID)
	}
	return nil
}

// afterCollect 是收了一笔之后计时会话跟着变：收齐了结清；还没收齐（部分付款）就把计时停在这一刻（见 freezeSession）。
func (s *Server) afterCollect(q *txn, u *User, reqID string, o *Order, now time.Time) {
	x := q.session(o.TableSessionID)
	if x == nil || !liveSession(x) {
		return
	}
	if o.Status == ordersdomain.StatusPaid {
		x.Status = "settled"
		return
	}
	s.freezeSession(q, u, reqID, x, now)
}

// collectPayment 收一笔线下款（现金、微信、支付宝）。一单可以分几笔收（2026-10-06 业主定，多人合付）：每笔 1 分起、
// 不超过还差的数，收齐（已收 + 免单 = 应收）订单就结清、计时会话随之结清；没收齐是部分付款，可以接着收下一笔或对剩余免单。
// 收第一笔时库存出库、计时停在这一刻，计价与明细冻结（之后不再随时间重算，也不能改明细、折扣或顾客），付到一半应收不会变。
// 现金可附实收现金，找零按这一笔算、记在这一笔上；实收填得不对（不是现金、少于这笔金额、找零超上限）时什么都不扣、不记。
// 并发：带读到的订单版本，两个人同时收同一单，后到的版本已过期（409），不会超收。
func (s *Server) collectPayment(q *txn, u *User, r *http.Request, o *Order, method string, amount int64, received *int64) error {
	if !ordersapp.Open(*o) {
		return ordersapp.ErrClosed
	}
	if session := q.session(o.TableSessionID); session != nil && !liveSession(session) {
		return errors.New("该会话已结束")
	}
	if method != "cash" && method != "wechat" && method != "alipay" {
		return errors.New("请选择现金、微信或支付宝")
	}
	outstanding := ordersapp.OutstandingCents(*o)
	switch {
	case outstanding < 1:
		return errors.New("这一单应收是 0，收不了款：计时待填价的行请先填价，整单不收钱请用免单")
	case amount < 1:
		return errors.New("收款金额至少 ¥0.01")
	case amount > outstanding:
		return ordersapp.ErrOverpay{Outstanding: outstanding}
	}
	now := q.now()
	payment := Payment{ID: id(), Method: method, AmountCents: amount, CreatedAt: now}
	if err := ordersapp.CashTender(&payment, received); err != nil {
		return err
	}
	first := o.Status == ordersdomain.StatusDraft
	if first {
		if err := shipGoods(q, u, o); err != nil {
			return err
		}
	}
	settled, err := ordersapp.Collect(o, payment)
	if err != nil {
		return err
	}
	s.afterCollect(q, u, requestID(r), o, now)
	if !settled {
		q.audit(u.ID, "order.payment.partial", o.ID, fmt.Sprintf("收第 %d 笔 ¥%s（%s），还差 ¥%s", moneyPayments(*o), yuanText(amount), methodText(method), yuanText(ordersapp.OutstandingCents(*o))), requestID(r))
		return nil
	}
	detail := ""
	if !first {
		detail = fmt.Sprintf("收第 %d 笔 ¥%s（%s），已收齐", moneyPayments(*o), yuanText(amount), methodText(method))
	}
	q.audit(u.ID, "order.paid", o.ID, detail, requestID(r))
	return nil
}

// moneyPayments 是这一单收到钱的付款有几条（不含免单）。
func moneyPayments(o Order) int {
	n := 0
	for _, p := range o.Payments {
		if p.Method != ordersapp.PaymentComp {
			n++
		}
	}
	return n
}

// methodText 是付款方式的中文名（审计里用）。
func methodText(method string) string {
	switch method {
	case "cash":
		return "现金"
	case "wechat":
		return "微信"
	case "alipay":
		return "支付宝"
	case "balance":
		return "储值"
	}
	return method
}

// refundPayment 登记一笔普通退款（店长、老板）：退的是员工选的那一笔付款（分几笔收的单必须选，每笔最多退「这笔金额 − 已退」），
// 一笔收齐的单可以不选。会员结账那一笔按原付款比例退，走会员退款；免单那一笔没有收到钱，不能退。部分付款的单要先收齐。
// 库存只按员工逐件填的件数回补；收到的钱都退完时订单变为已退款。
func (s *Server) refundPayment(q *txn, u *User, r *http.Request, o *Order, paymentID string, amount int64, reason string, returnedProducts map[string]int64) error {
	if !hasRole(u, Manager, Owner) {
		return errForbidden
	}
	if o.Status == ordersdomain.StatusPartiallyPaid {
		return errors.New("这一单还没收齐：先把剩下的收齐或对剩余免单，再退款")
	}
	if o.Status != ordersdomain.StatusPaid && o.Status != ordersdomain.StatusRefunded {
		return errors.New("只有已付款的订单可以退款")
	}
	memberCheckout := must(q.db().HasCheckoutEntry(q.ctx, o.ID))
	units := ordersapp.RefundUnits(*o, memberCheckout)
	if len(units) == 0 {
		// 没有收到钱：整单免单，或全用积分抵扣的会员结账单（积分走会员退款退回）
		if memberCheckout {
			return ordersapp.ErrMemberPayment
		}
		return errCompNoRefund
	}
	unit, err := ordersapp.RefundTarget(units, *o, paymentID)
	if err != nil {
		return err
	}
	if amount < 1 || amount > min(unit.RefundableCents(), ordersapp.RefundableCents(*o)) || reason == "" || utf8.RuneCountInString(reason) > 200 {
		return errors.New("退款信息无效")
	}
	returned, err := refundReturns(q, o, returnedProducts)
	if err != nil {
		return err
	}
	refund := Refund{ID: id(), AmountCents: amount, Reason: reason, ReturnedProducts: returned, CreatedAt: q.now()}
	if len(units) > 1 {
		refund.PaymentID = unit.ID()
	}
	o.Refunds = append(o.Refunds, refund)
	o.RefundedCents = ordersapp.RefundedCents(*o)
	for product, quantity := range returned {
		it := q.stockByProduct(product)
		it.Quantity += quantity
		addMovement(q, it.ID, quantity, "refund", o.ID, u.ID)
	}
	if ordersapp.FullyRefunded(*o) {
		o.Status = ordersdomain.StatusRefunded
	}
	q.audit(u.ID, "order.refunded", o.ID, reason, requestID(r))
	return nil
}

// keptAutoLines 是员工保存明细之后，开头还有几行算系统生成的计时明细：开头那几行原样没动（只在后面加减了商品）
// 就照旧，跟着计时重算；改了名称、数量、价格或删掉、挪动了就记 0，之后不再自动改（员工改过的计时行照旧不自动改）。
// 旧草稿（没有记）照旧没有。
func keptAutoLines(before Order, lines []OrderLine) *int {
	if before.AutoLines == nil {
		return nil
	}
	n := *before.AutoLines
	if n > 0 && n <= len(before.Lines) && len(lines) >= n && slices.Equal(lines[:n], before.Lines[:n]) {
		return autoLines(n)
	}
	return autoLines(0)
}

// customerInput 读换顾客请求里的 accountId：账户编号，或 null（改成散客，返回空串）。
// 只有 customer 能带它，也必须带；别的写请求带了算请求不对（以前不认识的字段一律拒收，这里照旧）。
func customerInput(kind string, raw json.RawMessage) (string, error) {
	if kind != "customer" {
		if raw != nil {
			return "", errors.New("这个操作不能带 accountId")
		}
		return "", nil
	}
	if raw == nil {
		return "", errors.New("请选择顾客账户，改成散客时 accountId 传 null")
	}
	if string(raw) == "null" {
		return "", nil
	}
	var account string
	if json.Unmarshal(raw, &account) != nil || !validID(account) {
		return "", errors.New("顾客账户编号无效，请重新选择")
	}
	return strings.ToLower(account), nil
}

// customerAuditName 是审计里写的顾客：散客，或「称呼（账户编号）」；账户不在了只写编号。
func customerAuditName(labels map[string]accountLabel, account string) string {
	if account == "" {
		return "散客"
	}
	if l, ok := labels[account]; ok && l.Nickname != "" {
		return fmt.Sprintf("%s（%s）", l.Nickname, account)
	}
	return account
}

// 退款回补多少库存，只认员工明确填写的件数。
//
// 原先按退款金额在订单里的占比推算：3 包材料 ¥150 加服务费 ¥150 的混合单，只退 ¥150
// 服务费，也会算出 3×150/300＝1 包材料回到货架。货其实在顾客手里，库存却凭空涨了一件，
// 退得越多错得越多，盘点时才发现。金额退了不等于货回了，拆封的材料也未必还能再卖，
// 所以这个数只能由经手的员工点清楚。
func refundReturns(q *txn, o *Order, requested map[string]int64) (map[string]int64, error) {
	if len(requested) == 0 {
		return nil, nil
	}
	sold := map[string]int64{}
	for _, l := range o.Lines {
		if l.ProductID != "" {
			sold[l.ProductID] += int64(l.Quantity)
		}
	}
	// 同一单可以退多次，累计退回数不能超过卖出数，否则分几笔退就能凭空造货。
	already := map[string]int64{}
	for _, r := range o.Refunds {
		for product, quantity := range r.ReturnedProducts {
			already[product] += quantity
		}
	}
	returned := map[string]int64{}
	for product, quantity := range requested {
		if quantity == 0 {
			continue
		}
		if quantity < 0 || already[product]+quantity > sold[product] {
			return nil, errors.New("退回数量超出本单已售数量")
		}
		if q.stockByProduct(product) == nil {
			return nil, errors.New("商品没有库存资料，请先登记实际入库")
		}
		returned[product] = quantity
	}
	if len(returned) == 0 {
		return nil, nil
	}
	return returned, nil
}

// addMovement 记一笔库存流水；actorID 是办这笔的员工。
func addMovement(q *txn, itemID string, delta int64, kind, reason, actorID string) {
	q.addMovementRecord(&movement{ID: id(), InventoryItemID: itemID, Kind: kind, Reason: reason, QuantityDelta: delta, CreatedAt: q.now(), ActorID: actorID})
}

// orderStatuses 是订单列表能筛的状态；open 是「待结账」：草稿和部分付款（还没收齐）的都在内。
var orderStatuses = map[string]bool{"draft": true, ordersdomain.StatusPartiallyPaid: true, "paid": true, "refunded": true, "voided": true, statusOpen: true}

// statusOpen 是订单列表的「待结账」筛选：还没收齐的单（草稿、部分付款）。
const statusOpen = "open"

// listOrders 是员工的订单列表：可按状态、关键字、结清方式（settlement=comp 只看免单）筛选，新的在前。带 pageSize 时只回那一页，
// 匹配总数和实际页码放在 X-Total-Count、X-Page 响应头里（页码超出时落到最后一页）；
// 不带 pageSize 时回全部匹配的订单（小程序旧版本就是这样取的）。返回体始终是数组。
func (s *Server) listOrders(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	query := r.URL.Query()
	status := query.Get("status")
	if status != "" && !orderStatuses[status] {
		s.writeError(w, r, 400, "invalid_request", errors.New("订单状态只能是 draft、partially_paid、paid、refunded、voided 或 open"))
		return
	}
	settlement := query.Get("settlement")
	if settlement != "" && settlement != settlementComp {
		s.writeError(w, r, 400, "invalid_request", errors.New("结清方式筛选只能是 comp（免单）"))
		return
	}
	needle := strings.ToLower(strings.TrimSpace(query.Get("q")))
	if utf8.RuneCountInString(needle) > 100 {
		s.writeError(w, r, 400, "invalid_request", errors.New("查找的关键字太长"))
		return
	}
	page, pageSize, err := pageParams(query)
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}

	q := s.tx(r)
	orders, total := q.ordersPage(status, needle, settlement, page, pageSize)
	if pageSize > 0 {
		setPageHeaders(w, page, pageSize, total)
	}
	view := s.orderViews(q, orders...)
	out := make([]orderResponse, 0, len(orders))
	for _, o := range orders {
		out = append(out, view(*o))
	}
	writeJSON(w, 200, out)
}

// errClerkPrice：店员改了商品的单价。人工改价等同折扣，只有店长、老板可以（折扣也是）。
var errClerkPrice = errors.New("店员只能按商品资料的售价记账，改价请找店长或老板")

// clerkLinePrices 核对店员提交的明细：带商品编号的行，单价要么等于商品资料的售价，
// 要么和这一单里原有的同一商品同价（商品资料改过价时，已有的行不受影响）。
// 不带商品的服务行（计时占位等）由员工按实际填价，收费政策另定，这里只留审计。
func clerkLinePrices(q *txn, o Order, lines []OrderLine) error {
	kept := map[string]map[int64]bool{}
	for _, l := range o.Lines {
		if l.ProductID == "" {
			continue
		}
		if kept[l.ProductID] == nil {
			kept[l.ProductID] = map[int64]bool{}
		}
		kept[l.ProductID][l.UnitPriceCents] = true
	}
	for _, l := range lines {
		if l.ProductID == "" || kept[l.ProductID][l.UnitPriceCents] {
			continue
		}
		if item := q.catalogItem(l.ProductID); item == nil || item.UnitPriceCents != l.UnitPriceCents {
			return errClerkPrice
		}
	}
	return nil
}

func yuanText(cents int64) string {
	sign := ""
	if cents < 0 {
		sign, cents = "-", -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}

// pageSizeMax 是按页取列表时一页的上限。
const pageSizeMax = 100

// pageParams 读列表的 page、pageSize。不带 pageSize 时 size 为 0，表示不分页（回全部，兼容旧客户端）。
// defaultPageSize 是带了关键字却没带 pageSize 的搜索每页条数。
const defaultPageSize = 20

// setPageHeaders 告诉客户端匹配的总数和实际返回的页码（超出时落到最后一页）。
func setPageHeaders(w http.ResponseWriter, page, size, total int) {
	w.Header().Set("X-Total-Count", strconv.Itoa(total))
	w.Header().Set("X-Page", strconv.Itoa(min(page, max(1, (total+size-1)/size))))
}

func pageParams(query url.Values) (page, size int, err error) {
	page = 1
	if v := query.Get("pageSize"); v != "" {
		n, convErr := strconv.Atoi(v)
		if convErr != nil || n < 1 || n > pageSizeMax {
			return 0, 0, errors.New("每页条数须在 1 到 100 之间")
		}
		size = n
	}
	if v := query.Get("page"); v != "" {
		n, convErr := strconv.Atoi(v)
		if convErr != nil || n < 1 {
			return 0, 0, errors.New("页码须为正整数")
		}
		page = n
	}
	return page, size, nil
}
