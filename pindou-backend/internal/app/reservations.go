package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	member "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/membership/application"
	reserve "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/reservations/domain"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

type Reservation = reserve.Reservation

// reservationInput 是预约动作的请求；omitzero 的用意同 loyaltyInput。
type reservationInput struct {
	Action          string            `json:"action"`
	TargetID        string            `json:"targetId,omitzero"`
	AccountID       string            `json:"accountId,omitzero"`
	GuestName       string            `json:"guestName,omitzero"`
	TableID         string            `json:"serviceTableId,omitzero"`
	SeatNumber      int               `json:"seatNumber,omitzero"`
	PackageID       string            `json:"packageId,omitzero"`
	StartAt         string            `json:"startAt,omitzero"`
	Note            string            `json:"note,omitzero"`
	Reason          string            `json:"reason,omitzero"`
	ExpectedVersion string            `json:"expectedVersion,omitzero"`
	Settings        *reserve.Settings `json:"settings,omitzero"`
	// Coupon 是团购记录（book、register，选填）。不带时编码不变，幂等指纹不变。
	Coupon *reserve.Coupon `json:"coupon,omitzero"`
}

// myReservations 是登录者自己的预约。
func (s *Server) myReservations(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	q := s.tx(r)
	writeJSON(w, 200, s.reservationView(q, u.ID, false))
}

// staffReservations 是员工看的预约：scope=open 进行中的，scope=ended 已结束的一页（可按门店日期 date 筛）。
func (s *Server) staffReservations(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.staffMember(w, r); !ok {
		return
	}
	q := s.tx(r)
	query := r.URL.Query()
	switch query.Get("scope") {
	case "open":
		writeJSON(w, 200, s.reservationView(q, "", true))
	case "ended":
		page, size, err := pageParams(query)
		if err != nil {
			s.writeError(w, r, 400, "invalid_request", err)
			return
		}
		if size == 0 {
			size = defaultPageSize
		}
		from, to, err := storeDayRange(query.Get("date"))
		if err != nil {
			s.writeError(w, r, 400, "invalid_request", err)
			return
		}
		ended, total := q.endedReservations(page, size, from, to)
		setPageHeaders(w, page, size, total)
		writeJSON(w, 200, s.reservationViewOf(q, ended, true))
	default:
		s.writeError(w, r, 400, "invalid_request", errors.New("scope 只能是 open 或 ended"))
	}
}

// storeDayRange 是门店日期（YYYY-MM-DD，中国标准时间）这一天的起止 [from, to)：从当天 0 点到次日 0 点，
// 不看服务器所在的时区。没给日期时两端都是零值（不限）。
func storeDayRange(day string) (from, to time.Time, err error) {
	if day == "" {
		return time.Time{}, time.Time{}, nil
	}
	from, err = time.ParseInLocation(time.DateOnly, day, storetime.Location)
	if err != nil {
		return time.Time{}, time.Time{}, errors.New("日期格式应为 YYYY-MM-DD")
	}
	return from, from.AddDate(0, 0, 1), nil
}

// postReservationAction 执行一个预约动作（预约、确认、取消、爽约、入座、预约设置），权限按动作核对。
func (s *Server) postReservationAction(w http.ResponseWriter, r *http.Request) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return
	}
	staff := hasRole(u, Clerk, Manager, Owner)
	q := s.tx(r)
	var in reservationInput
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	if idemKey(r) == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("缺少幂等键"))
		return
	}
	// Authorization is checked before idempotent replay.
	allowed := staff
	switch in.Action {
	case "book", "cancel":
		allowed = true
	case "save_settings":
		allowed = hasRole(u, Owner)
	}
	if !allowed {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	key := "reservation:" + u.ID + ":" + in.Action + ":" + idemKey(r)
	fingerprint := member.Version(in)
	if prev := q.idemGet(key); prev != nil {
		if prev.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("相同幂等键的内容已改变"))
			return
		}
		if prev.Replay == replayReservationView {
			// 重放回当前的预约视图，和第一次一样带上那次操作的目标
			var recorded struct {
				TargetID string `json:"targetId"`
			}
			_ = json.Unmarshal(prev.Body, &recorded)
			view := s.reservationView(q, u.ID, staff)
			if recorded.TargetID != "" {
				view["targetId"] = recorded.TargetID
			}
			writeJSON(w, prev.Status, view)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(prev.Status)
		_, _ = w.Write(prev.Body)
		return
	}
	target, err := s.reservationAction(q, u, in)
	if err != nil {
		switch {
		case errors.Is(err, errForbidden):
			s.writeError(w, r, 403, "forbidden", err)
		case errors.As(err, new(invalidInput)):
			s.writeError(w, r, 400, "invalid_request", err)
		case errors.Is(err, reserve.ErrLimitReached):
			// 小程序按这个错误码提示上限并给出门店联系方式
			s.writeError(w, r, 409, "reservation_limit_reached", err)
		case errors.Is(err, reserve.ErrStoreClosed):
			s.writeError(w, r, 409, "store_closed", err)
		case errors.Is(err, reserve.ErrSuspended):
			// 小程序按这个错误码提示联系门店并给出门店联系方式
			s.writeError(w, r, 409, "reservation_suspended", err)
		case errors.As(err, new(seatInUse)):
			s.writeError(w, r, 409, "seat_in_use", err)
		default:
			s.writeError(w, r, 409, "reservation_conflict", err)
		}
		return
	}
	q.audit(u.ID, "reservation."+in.Action, target, in.Reason, requestID(r))
	// 只记目标，不记整份视图：员工视图带着全部历史预约，一年下来一条就近 2MB，30 天的幂等记录
	// 能把内存和每次保存撑到上百 MB。重放时按当前状态重新生成视图。
	recorded, _ := json.Marshal(map[string]string{"targetId": target})
	q.rememberIdem(key, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: recorded, Replay: replayReservationView})
	// 视图在记下审计之后才生成（和重放一样）：员工视图里「顾客取消」的提醒按审计判断，刚点的「知道了」要算上
	view := s.reservationView(q, u.ID, staff)
	if target != "" {
		view["targetId"] = target
	}
	writeJSON(w, 200, view)
}

// reservationAction 执行一个预约动作，返回这次的目标预约（新建的就是新预约；保存设置时是请求里带的 targetId，通常为空）。
// 响应的视图由 postReservationAction 在记下审计之后生成。
func (s *Server) reservationAction(q *txn, u *User, in reservationInput) (string, error) {
	now := q.now()
	set := *q.reservationSettings()
	staff := hasRole(u, Clerk, Manager, Owner)
	note, err := reserve.Note(in.Note)
	if err != nil {
		return "", err
	}
	reason, err := reserve.Note(in.Reason)
	if err != nil {
		return "", err
	}
	switch in.Action {
	case "save_settings":
		if in.Settings == nil {
			return "", invalidInput{reserve.ErrInvalid}
		}
		if in.ExpectedVersion != member.Version(set) {
			return "", errors.New("预约设置已变化，请重新读取后确认")
		}
		// 设置填得不对是请求本身不合法，重读也没用：回 400，不和版本冲突混在一起。
		// 把某天设为歇业不动已经约在那天的预约（不取消、不改状态），由老板联系顾客；网页保存前会列出受影响的预约。
		settings, err := in.Settings.Normalize(set, now)
		if err != nil {
			return "", invalidInput{err}
		}
		*q.reservationSettings() = settings
		return in.TargetID, nil

	case "book", "register":
		if in.Action == "book" && !set.Enabled {
			return "", errors.New("门店暂未开放自助预约")
		}
		if in.Action == "register" && !staff {
			return "", errForbidden
		}
		// 爽约限制只管顾客自助预约；员工代客登记不受限（和每人上限一样，员工可以特殊安排）
		if in.Action == "book" && selfServiceSuspended(q, u.ID, set, now) {
			return "", reserve.ErrSuspended
		}
		rule, ok := q.membership().Rule(in.PackageID)
		if !ok || rule.Kind != "package" {
			return "", errors.New("套餐不可用，请刷新后重新选择")
		}
		if err := packageUsable(q, rule); err != nil {
			return "", err
		}
		coupon, err := reserve.NormalizeCoupon(in.Coupon)
		if err != nil {
			return "", invalidInput{err}
		}
		start, err := parseTime(in.StartAt)
		if err != nil {
			return "", reserve.ErrInvalid
		}
		// 「到打烊」的套餐从所选开始时间约到当天打烊；开始时间已到或过了打烊就不在可约范围内
		duration := rule.DurationMinutes
		if rule.UntilClose {
			if duration = set.MinutesUntilClose(start); duration < 1 {
				return "", reserve.ErrClosed
			}
		}
		// 歇业日（按门店时区的日期）顾客不能自助预约；员工代客登记照常，小程序登记时提示这天歇业
		if in.Action == "book" && set.ClosedOn(start) {
			return "", reserve.ErrStoreClosed
		}
		// Staff record bookings that customers make by phone, including ones
		// starting sooner than self-service allows; opening hours still apply.
		window := set
		if in.Action == "register" {
			window.LeadMinutes = 0
		}
		if err := reserve.Window(start, duration, window, now); err != nil {
			return "", err
		}
		account, guest := u.ID, ""
		if in.Action == "register" {
			account = in.AccountID
			if account != "" && q.user(account) == nil {
				return "", errNotFound
			}
			if guest, err = reserve.Name(in.GuestName); err != nil {
				return "", err
			}
			if account == "" && guest == "" {
				return "", errors.New("请选择顾客账户或填写称呼")
			}
		} else if in.AccountID != "" && in.AccountID != u.ID {
			return "", errForbidden
		}
		if err := s.reservationSeatFree(q, in.TableID, in.SeatNumber, start, start.Add(time.Duration(duration)*time.Minute), "", now); err != nil {
			return "", err
		}
		// 现场挡预约：座位上正在进行的定时会话结束前，顾客不能自助约进来；员工代客登记不受限（小程序登记时提示）
		if in.Action == "book" {
			if until, checkout, held := sessionHold(q, in.TableID, in.SeatNumber, start, now); held {
				return "", seatInUse{until: until, now: now, checkout: checkout}
			}
		}
		if account != "" {
			live := 0
			for _, existing := range q.openReservations(now) {
				if existing.AccountID != account || !existing.Live(now, set.GraceMinutes) {
					continue
				}
				live++
				if start.Before(existing.EndAt()) && existing.StartAt.Before(start.Add(time.Duration(duration)*time.Minute)) {
					return "", errors.New("该顾客在这个时间段已有预约")
				}
			}
			// 上限只管顾客自助预约，免得一个账号把座位占满；顾客打电话、发微信约更多，由员工代客登记，不受它限制。
			// 员工替这个账号登记的也算在还没到店的预约里。
			if in.Action == "book" && live >= reserve.SelfServiceLimit {
				return "", reserve.ErrLimitReached
			}
		}
		status := "pending"
		if in.Action == "register" {
			status = "confirmed"
		}
		x := &Reservation{ID: id(), AccountID: account, GuestName: guest, TableID: in.TableID, SeatNumber: in.SeatNumber,
			PackageID: rule.ID, PackageName: rule.Name, DurationMinutes: duration, AmountCents: rule.AmountCents,
			StartAt: start.UTC(), Status: status, Note: note, CreatedBy: u.ID, CreatedAt: now, Coupon: coupon}
		if status == "confirmed" {
			x.DecidedAt = &now
		}
		q.addReservation(x)
		return x.ID, nil

	case "confirm", "cancel", "no_show", "seat":
		x := q.reservation(in.TargetID)
		if x == nil {
			return "", errNotFound
		}
		if !staff && x.AccountID != u.ID {
			return "", errForbidden
		}
		if !staff && in.Action != "cancel" {
			return "", errForbidden
		}
		return s.reservationDecide(q, u, staff, x, in, reason, now)

	case "acknowledge":
		// 现场页「顾客取消」提醒上的「知道了」（只有员工能点，见上面的权限）：这一步只核对，postReservationAction
		// 记下的审计 reservation.acknowledge 就是已读的记号，员工视图的 customerCancellations 据此不再列这条。全店一起消掉。
		x := q.reservation(in.TargetID)
		if x == nil {
			return "", errNotFound
		}
		if x.Status != "cancelled" {
			return "", errors.New("预约状态已变化，请刷新")
		}
		return x.ID, nil
	}
	return "", reserve.ErrInvalid
}

func (s *Server) reservationDecide(q *txn, u *User, staff bool, x *Reservation, in reservationInput, reason string, now time.Time) (string, error) {
	set := *q.reservationSettings()
	switch in.Action {
	case "cancel":
		if x.Status != "pending" && x.Status != "confirmed" {
			return "", errors.New("预约状态已变化，请刷新")
		}
		x.Status, x.Reason, x.DecidedAt = "cancelled", reason, &now
	case "confirm":
		if x.Status != "pending" {
			return "", errors.New("预约状态已变化，请刷新")
		}
		if !x.Live(now, set.GraceMinutes) {
			return "", errors.New("预约已过期，请顾客重新预约")
		}
		if err := s.reservationSeatFree(q, x.TableID, x.SeatNumber, x.StartAt, x.EndAt(), x.ID, now); err != nil {
			return "", err
		}
		x.Status, x.DecidedAt = "confirmed", &now
	case "no_show":
		if x.Status != "pending" && x.Status != "confirmed" {
			return "", errors.New("预约状态已变化，请刷新")
		}
		if now.Before(x.StartAt) {
			return "", errors.New("预约尚未开始，不能标记爽约")
		}
		x.Status, x.Reason, x.DecidedAt = "no_show", reason, &now
	case "seat":
		// 待确认的也能直接开台（2026-10-27 起）：顾客人已经到了，不用先点「确认」。不发「预约成功」通知（下面作废）
		if x.Status != "pending" && x.Status != "confirmed" {
			return "", errors.New("预约状态已变化，请刷新")
		}
		if err := s.reservationSeat(q, x, in.AccountID, now); err != nil {
			return "", err
		}
	}
	// 顾客的微信通知：店员确认、店员取消各发一条；顾客自己取消、爽约、到店开台后没发的作废
	event := ""
	switch {
	case in.Action == "confirm":
		event = noticeConfirmed
	case in.Action == "cancel" && staff && x.AccountID != u.ID:
		event = noticeCancelled
	}
	s.reservationNoticesAfter(q, x, event)
	return x.ID, nil
}

// reservationSeat starts the booked package through the existing seat timing
// flow, so pausing, renewing and checkout stay in one place.
// 只写了称呼、没关联账户的预约（员工代客登记）到店时可以不选账户，当散客开台（2026-10-20 业主定）：
// 按座计时挂在顾客账户上，散客就走整桌开台那条路，按预约的套餐时长计时。门店的桌都是单座或论桌卖，整桌会话占的就是这一座。
func (s *Server) reservationSeat(q *txn, x *Reservation, account string, now time.Time) error {
	if x.AccountID == "" && account != "" {
		if q.user(account) == nil {
			return errNotFound
		}
		x.AccountID = account
	}
	rule, ok := q.membership().Rule(x.PackageID)
	if !ok || rule.Kind != "package" {
		return errors.New("该套餐已停用，请改用现场开台或另选套餐")
	}
	if err := packageUsable(q, rule); err != nil {
		return err
	}
	// 「到打烊」的套餐从现在算到打烊
	minutes, err := packageMinutes(q, rule, now)
	if err != nil {
		return err
	}
	if t := q.table(x.TableID); t == nil || !t.Enabled {
		return errors.New("该桌位已停用，请为顾客改换座位或联系老板恢复该桌")
	}
	if !s.seatAvailable(q, x.TableID, x.SeatNumber, "") {
		return errors.New("该座位已被占用，请先处理现场会话")
	}
	if x.AccountID != "" && len(q.liveSessionsOf(x.AccountID)) > 0 {
		return errors.New("顾客已有进行中的体验")
	}
	// 从现在起按套餐坐满，不能压到这个座位后面别人的预约（迟到的顾客尤其容易压到下一位）
	end := now.Add(time.Duration(minutes) * time.Minute)
	if hold := s.reservationHoldExcept(q, x.TableID, x.SeatNumber, now, end, x.AccountID, x.ID); hold != nil {
		return fmt.Errorf("按套餐「%s」从现在坐满 %d 分钟会压到%s：请先处理那个预约，或为顾客换座", rule.Name, minutes, s.reservationText(q, hold))
	}
	if x.AccountID == "" {
		// 按座卖的多座桌开整桌会话会占掉别的座：这种桌（门店现在没有）仍要先选账户
		if t := q.table(x.TableID); t.SeatCount > 1 && !t.WholeTable {
			return errors.New("这张桌按座卖，没关联账户的预约到店请先选择顾客账户")
		}
		// 同整桌开台：记下这一刻生效的价，不建草稿单（结账时建单）
		tariff := tariffOf(q.membership().Rules())
		session := &TableSession{ID: id(), TableID: x.TableID, Status: "active", StartedAt: now, TimingMode: "timed", DurationMinutes: minutes, UntilClose: rule.UntilClose, Tariff: &tariff}
		q.addSession(session)
		x.Status, x.SessionID, x.DecidedAt = "seated", session.ID, &now
		return nil
	}
	a := member.Admission{ID: id(), AccountID: x.AccountID, TableID: x.TableID, SeatNumber: x.SeatNumber, Package: rule, Status: "confirmed", CreatedAt: now, Coupon: reservationCoupon(x)}
	session := &TableSession{ID: id(), TableID: x.TableID, UserID: x.AccountID, SeatNumber: x.SeatNumber, AdmissionID: a.ID, Status: "active", StartedAt: now, TimingMode: "timed", DurationMinutes: minutes, UntilClose: rule.UntilClose}
	a.SessionID = session.ID
	q.addSession(session)
	q.memberAccount(x.AccountID).Admissions[a.ID] = a
	// 系统内收费开着才建套餐草稿单（关着时店员点「结束」放座，见 session_end.go）
	if q.billingEnabled() {
		order := &Order{ID: id(), TableSessionID: session.ID, UserID: x.AccountID, Status: "draft", CreatedAt: now,
			ReceivableCents: rule.AmountCents, Lines: []OrderLine{{Name: rule.Name, Quantity: 1, UnitPriceCents: rule.AmountCents}}}
		q.addOrder(order)
	}
	x.Status, x.SessionID, x.DecidedAt = "seated", session.ID, &now
	return nil
}

// reservationSeatFree rejects a window that another live reservation already
// holds, and — when the window has already started — a seat currently in use.
func (s *Server) reservationSeatFree(q *txn, table string, seat int, start, end time.Time, except string, now time.Time) error {
	t := q.table(table)
	if t == nil || !t.Enabled || seat < 1 || seat > t.SeatCount {
		return errors.New("座位不可用，请刷新后重新选择")
	}
	// ★ 整桌单位要按**整张桌**比：别人订了 1 号座，2 号座就不能再卖，
	//   否则平面图上「订整桌」的承诺在后端根本不成立。
	//   Reservation.Blocks 刻意保持按座号判（它不知道桌的售卖单位），
	//   展开成哪些座号是这一层的事。
	grace := q.reservationSettings().GraceMinutes
	for _, other := range q.openReservations(now) {
		for _, n := range unitSeats(t, seat) {
			if other.ID != except && other.Blocks(table, n, start, end, now, grace) {
				return reserve.ErrConflict
			}
		}
	}
	if !start.After(now) && !s.seatAvailable(q, table, seat, "") {
		return errors.New("该座位当前正在使用")
	}
	return nil
}

// seatInUse 是顾客自助预约的时段压到了座位上正在进行的定时会话（回 409 seat_in_use）。
// seatInUse 是自助预约压到现场会话的拒绝说明。checkout 为真时座位上是停止计时、还没结账的会话。
type seatInUse struct {
	until, now time.Time
	checkout   bool
}

func (e seatInUse) Error() string {
	if e.checkout {
		return "这个座位的顾客还在等结账，今天后面的时段暂时不能约，请换个座位或改约明天"
	}
	until, today := e.until.In(storetime.Location), e.now.In(storetime.Location)
	when := until.Format("15:04")
	if until.Format(time.DateOnly) != today.Format(time.DateOnly) {
		when = until.Format("1月2日 15:04")
	}
	return fmt.Sprintf("这个座位现场正在使用，到 %s 才空出，请换个时段或座位", when)
}

// stoppedHoldUntil 是停止计时、等结账的会话占座到什么时候。2026-10-06 业主定：结账前一直挡着；
// 不知道什么时候结账，按占到门店今天结束算（当天后面的时段约不了，明天照常），结账后就不在 liveSessions 里了。
func stoppedHoldUntil(now time.Time) time.Time {
	d := now.In(storetime.Location)
	return time.Date(d.Year(), d.Month(), d.Day()+1, 0, 0, 0, 0, storetime.Location)
}

// sessionHold 报告这个座位上正在进行的会话最晚占到什么时候，start 在那之前就和它重叠：顾客自助预约要避开。
// 整桌会话、整桌售卖的桌上任何一个会话都占着整张桌（同 seatAvailable）。定时会话按桌位视图的 endsAt 口径（含暂停，
// 见 sessionEndsAt）；自由计时没有结束时间，不挡；停止计时、等结账的挡到门店今天结束（见 stoppedHoldUntil），
// checkout 为真表示挡住它的是这种。
func sessionHold(q *txn, table string, seat int, start, now time.Time) (until time.Time, checkout bool, held bool) {
	t := q.table(table)
	if t == nil {
		return time.Time{}, false, false
	}
	for _, x := range q.liveSessionsOnTable(table) {
		if x.SeatNumber != 0 && x.SeatNumber != seat && !t.WholeTable {
			continue
		}
		ends, ok := sessionEndsAt(q, x, now)
		if x.StoppedAt != nil {
			ends, ok = stoppedHoldUntil(now), true
		}
		if ok && start.Before(ends) {
			checkout = checkout || x.StoppedAt != nil
			if ends.After(until) {
				until = ends
			}
		}
	}
	return until, checkout, !until.IsZero()
}

// sessionBusy 是座位上正在进行、还没到结束时间的定时会话占着的时间段（kind=session），并进预约视图的 busy：
// 顾客的平面选座据此把这段算作占用，员工代客登记据此提示冲突。整桌会话、整桌售卖的桌展开成每个座号。
// 停止计时、等结账的占到门店今天结束（见 stoppedHoldUntil）。
func sessionBusy(q *txn, tables map[string]*Table, now time.Time) []map[string]any {
	out := []map[string]any{}
	for _, x := range q.liveSessions() {
		t := tables[x.TableID]
		if t == nil {
			continue
		}
		ends, ok := sessionEndsAt(q, x, now)
		if x.StoppedAt != nil {
			ends, ok = stoppedHoldUntil(now), true
		}
		if !ok || !ends.After(now) {
			continue
		}
		seats := []int{x.SeatNumber}
		if x.SeatNumber == 0 || t.WholeTable {
			seats = unitSeats(&Table{WholeTable: true, SeatCount: t.SeatCount}, 1)
		}
		for _, n := range seats {
			out = append(out, map[string]any{"serviceTableId": x.TableID, "seatNumber": n, "startAt": x.StartedAt, "endAt": ends, "kind": "session"})
		}
	}
	return out
}

// reservationHold reports the live reservation, if any, that holds a seat for a
// window a walk-in is about to take. Reservations made by the same customer do
// not stand in their own way.
func (s *Server) reservationHold(q *txn, table string, seat int, start, end time.Time, account string) *Reservation {
	return s.reservationHoldExcept(q, table, seat, start, end, account, "")
}

// reservationHoldExcept 同 reservationHold，另外不算 except 这条预约（到店开台时它自己）。
func (s *Server) reservationHoldExcept(q *txn, table string, seat int, start, end time.Time, account, except string) *Reservation {
	now, grace := q.now(), q.reservationSettings().GraceMinutes
	// ★ 整桌单位：桌上任何一个座被预约住，这张桌就不能给走进来的客人开台。
	seats := unitSeats(q.table(table), seat)
	for _, x := range q.openReservations(now) {
		if x.ID == except {
			continue
		}
		for _, n := range seats {
			if x.Blocks(table, n, start, end, now, grace) && (account == "" || x.AccountID != account) {
				return x
			}
		}
	}
	return nil
}

// reservationText 是拒绝时说明压到的是哪个预约：「A3 桌 1 号座 17:00 开始的预约（小王）」。
func (s *Server) reservationText(q *txn, x *Reservation) string {
	place := "该桌"
	if t := q.table(x.TableID); t != nil {
		place = t.Code + " 桌"
		if t.SeatCount > 1 {
			place += fmt.Sprintf(" %d 号座", x.SeatNumber)
		}
	}
	name := x.GuestName
	if x.AccountID != "" {
		if account, ok := q.accountNames([]string{x.AccountID})[x.AccountID]; ok {
			name = account.Nickname
		}
	}
	text := fmt.Sprintf("%s %s 开始的预约", place, x.StartAt.In(storetime.Location).Format("15:04"))
	if name != "" {
		text += "（" + name + "）"
	}
	return text
}

// reservationForSeating 是这位顾客从 start 起坐 duration 分钟、时间上重叠的自己的预约（还会到店的），入座时把它结掉，
// 不让它挂着过期。不论约的是不是这个座位（2026-10-27 起）：顾客约了 B3、到店坐了 A1（B3 被占着，或他想换），那条预约也算
// 到店了，不然它一直占着 B3，过了宽限期还会被当成没来、标成爽约。约的就是这一座（seat 为 0 时是这张桌上任何一座）的优先，
// 其余按开始时间取最早的。
func (s *Server) reservationForSeating(q *txn, table string, seat int, account string, start time.Time, duration int, now time.Time) *Reservation {
	if account == "" {
		return nil
	}
	grace := q.reservationSettings().GraceMinutes
	end := start.Add(time.Duration(duration) * time.Minute)
	var earliest *Reservation
	for _, x := range q.openReservations(now) {
		if x.AccountID != account || !x.Live(now, grace) || !start.Before(x.EndAt()) || !x.StartAt.Before(end) {
			continue
		}
		if x.TableID == table && (seat == 0 || x.SeatNumber == seat) {
			return x
		}
		if earliest == nil {
			earliest = x
		}
	}
	return earliest
}

func reservationEntry(x Reservation, staff bool, now time.Time, grace int, tables map[string]*Table, names map[string]accountName) map[string]any {
	entry := map[string]any{"reservation": x, "displayStatus": x.Display(now, grace), "endAt": x.EndAt()}
	if table := tables[x.TableID]; table != nil {
		entry["tableNumber"] = table.Number
	}
	if staff {
		name := x.GuestName
		phone := ""
		if account, ok := names[x.AccountID]; ok {
			name, phone = account.Nickname, maskPhone(account.Phone)
		}
		entry["customerName"], entry["phoneMasked"] = name, phone
	}
	return entry
}

// selfServiceSuspended 报告这个账号是否因最近爽约次数达到老板设的上限而暂停自助预约；没开爽约限制时不查库。
func selfServiceSuspended(q *txn, account string, set reserve.Settings, now time.Time) bool {
	return set.NoShowLimit > 0 && set.Suspended(q.noShowsSince(account, set.NoShowSince(now)))
}

// reservationView 是顾客自己的全部预约，或员工还要处理的预约（待确认、已确认，包括过了时间还没标记到店或爽约的）。
// 操作的响应也用它。顾客的视图另带本人是否暂停自助预约，小程序据此提前告诉他，不用等下单被拒。
func (s *Server) reservationView(q *txn, account string, staff bool) map[string]any {
	if staff {
		view := s.reservationViewOf(q, q.pendingReservations(), true)
		view["customerCancellations"] = s.customerCancellations(q)
		return view
	}
	view := s.reservationViewOf(q, q.reservationsOf(account), false)
	view["selfServiceSuspended"] = selfServiceSuspended(q, account, *q.reservationSettings(), q.now())
	s.addNoticeView(q, view)
	return view
}

// customerCancellations 是员工现场页「等你处理」要提醒的顾客自己取消的预约（2026-10-27 业主定）：开始时间在门店今天、
// 还没到结束时间，没有员工点过「知道了」。员工替顾客取消的员工自己知道，不提醒；以后几天的不提醒，预约页里照样看得到。
// 条目同员工视图里的预约（带称呼、脱敏手机号），原因在 reservation.reason。
func (s *Server) customerCancellations(q *txn) []map[string]any {
	now := q.now()
	from, to, _ := storeDayRange(now.In(storetime.Location).Format(time.DateOnly))
	out := []map[string]any{}
	found := q.customerCancellations(from, to)
	if len(found) == 0 {
		return out
	}
	tables := map[string]*Table{}
	for _, t := range q.allTables() {
		tables[t.ID] = t
	}
	ids := make([]string, 0, len(found))
	for _, x := range found {
		ids = append(ids, x.AccountID)
	}
	names := q.accountNames(ids)
	grace := q.reservationSettings().GraceMinutes
	for _, x := range found {
		if x.EndAt().After(now) {
			out = append(out, reservationEntry(*x, true, now, grace, tables, names))
		}
	}
	return out
}

// reservationViewOf 是列出 mine 这些预约的视图，另带占座情况、套餐、桌位和预约设置。
func (s *Server) reservationViewOf(q *txn, mine []*Reservation, staff bool) map[string]any {
	set := *q.reservationSettings()
	now := q.now()
	tables := map[string]*Table{}
	for _, t := range q.allTables() {
		tables[t.ID] = t
	}
	var names map[string]accountName
	if staff {
		ids := make([]string, 0, len(mine))
		for _, x := range mine {
			ids = append(ids, x.AccountID)
		}
		names = q.accountNames(ids)
	}
	entries, busy := []map[string]any{}, []map[string]any{}
	listed := make([]Reservation, 0, len(mine))
	for _, x := range mine {
		entries = append(entries, reservationEntry(*x, staff, now, set.GraceMinutes, tables, names))
		listed = append(listed, *x)
	}
	for _, x := range q.openReservations(now) {
		if x.Live(now, set.GraceMinutes) {
			busy = append(busy, map[string]any{"serviceTableId": x.TableID, "seatNumber": x.SeatNumber, "startAt": x.StartAt, "endAt": x.EndAt(), "kind": "reservation"})
		}
	}
	busy = append(busy, sessionBusy(q, tables, now)...)
	// entries 保持 mine 的顺序（都是查询里排好的：处理完的新的在前，其余按开始时间）
	sort.Slice(busy, func(i, j int) bool {
		a, b := busy[i], busy[j]
		if a["serviceTableId"].(string) != b["serviceTableId"].(string) {
			return a["serviceTableId"].(string) < b["serviceTableId"].(string)
		}
		if a["seatNumber"].(int) != b["seatNumber"].(int) {
			return a["seatNumber"].(int) < b["seatNumber"].(int)
		}
		return a["startAt"].(time.Time).Before(b["startAt"].(time.Time))
	})
	packages := []member.Rule{}
	for _, rule := range offeredRules(q, q.membership().Rules()) {
		if rule.Kind == "package" {
			packages = append(packages, rule)
		}
	}
	sort.Slice(listed, func(i, j int) bool { return listed[i].ID < listed[j].ID })
	// settings 不再列已经过去的歇业日期；版本仍按存着的那份算。closedDays 是从今天起到最多提前天数为止的歇业日
	// （含每周休息日展开后的），顾客的日期条标店休、员工代客登记提示歇业都看它。
	return map[string]any{"reservations": entries, "busy": busy, "packages": packages, "tables": s.loyaltyTables(q),
		"settings": set.Upcoming(now), "settingsVersion": member.Version(set), "closedDays": set.ClosedDays(now, set.AdvanceDays),
		"version": member.Version(listed)}
}
