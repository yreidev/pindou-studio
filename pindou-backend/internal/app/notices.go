package app

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"

	wechatapi "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/identity/infrastructure/wechat"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storage/queries"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

// 顾客预约的微信订阅消息（2026-10-20 业主定，docs/plan-notify-and-share.md 第 3 节，迁移 026）：
// 顾客在小程序里点「提交预约」时一并允许，或者之后在「我的预约」那条预约上点「开启微信提醒」；店员确认、店员取消时各发一条，
// 开始前几小时（老板在网页后台「营业与预约」里设，默认 2 小时，0 不提醒）由 RunNotices 发提醒。员工不推送。
//
// openid：发消息要它本身，库里原来只存哈希。允许订阅时小程序带一个新的登录码，换出 openid、核对哈希属于这个账户，
// 加密（AES-256-GCM，附加数据是这一行的身份哈希）存进 account_wechat_identities.openid_sealed，只在发消息那一刻解开。
// 日志、接口、错误里都不出现 openid。没配密钥（PINDOU_WECHAT_OPENID_KEY）时整个功能关着，顾客端不弹订阅框。
//
// 发送不在数据库事务里（事务里不调外部服务）：请求事务里把这条通知领成 sending、备好内容，提交之后再调微信，
// 结果另开一个短事务记下。失败只记错误码，不重试、不打扰店员。

const (
	noticeConfirmed = "confirmed"
	noticeReminder  = "reminder"
	noticeCancelled = "cancelled"
)

// noticeKinds 是顾客能允许的通知，也是小程序请求订阅时模板的顺序。
var noticeKinds = []string{noticeConfirmed, noticeReminder, noticeCancelled}

// noticeField 是模板里一个关键词填什么。
type noticeField int

const (
	// noticeStart 是开始时间：2026年10月21日 15:00
	noticeStart noticeField = iota
	// noticeStore 是门店名
	noticeStore
	// noticeSeat 是座位：B3 桌、B3 桌 2 号座
	noticeSeat
	// noticeSeatCode 是座位编号，只能是字母、数字、符号：B3、B3-2
	noticeSeatCode
	// noticeReason 是店员写的取消原因
	noticeReason
	// noticeTip 是温馨提示
	noticeTip
)

type noticeTemplate struct {
	ID       string
	Keywords map[string]noticeField
}

// wechatNoticeTemplates 是业主 2026-10-20 在公众平台「订阅消息 › 我的模板」选的三个一次性订阅模板（类目休闲娱乐）。
// 关键词编号照模板详情抄；换模板要连关键词一起改。每种关键词的格式限制见 fitKeyword。
var wechatNoticeTemplates = map[string]noticeTemplate{
	// 预约成功通知（模板编号 1787）
	noticeConfirmed: {ID: "mvZTo2GkECPKQ9twhw9N9dzZtNF6wuTAHRKYfeGge1w", Keywords: map[string]noticeField{
		"time14": noticeStart, "thing4": noticeStore, "thing20": noticeSeat, "thing2": noticeTip}},
	// 预约提醒通知（模板编号 372）：「预订座位号」是 character_string，不能有汉字
	noticeReminder: {ID: "cdLedLpN5hoOwXKCPZoAskBtGBLa33CEMrH3_T_WVQU", Keywords: map[string]noticeField{
		"date7": noticeStart, "thing6": noticeStore, "character_string25": noticeSeatCode, "thing9": noticeTip}},
	// 预约取消通知（模板编号 1667）
	noticeCancelled: {ID: "RaaPsRNvdxQ5BIszFiwlRSaVKJNXayHtXBHjsBvauNE", Keywords: map[string]noticeField{
		"time2": noticeStart, "thing16": noticeStore, "thing11": noticeSeat, "thing14": noticeReason, "thing22": noticeTip}},
}

// noticeStoreName 是消息里的门店名。
const noticeStoreName = "EXAMPLE 示例工坊"

// 顾客开提醒每次都要调一次微信换 openid：每个账户每 10 分钟最多 20 次。
const (
	noticeRateLimit  = 20
	noticeRateWindow = 10 * time.Minute
)

// noticeSender 是发订阅消息的微信接口（wechatapi.Client），测试换成记下发了什么的实现。
type noticeSender interface {
	SendSubscribeMessage(ctx context.Context, m wechatapi.SubscribeMessage) error
}

// ConfigureNoticeKey 设定加密 openid 的密钥（32 字节，部署配置 PINDOU_WECHAT_OPENID_KEY 是它的 base64）；
// 空的表示不开顾客通知。
func (s *Server) ConfigureNoticeKey(key []byte) error {
	if len(key) == 0 {
		s.openids = nil
		return nil
	}
	if len(key) != 32 {
		return errors.New("PINDOU_WECHAT_OPENID_KEY must be 32 bytes (base64)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	s.openids = aead
	return nil
}

// sealOpenID 加密 openid：随机 nonce 放在密文前面，附加数据是身份哈希（密文挪到别的身份行上就解不开）。
func (s *Server) sealOpenID(openid, identityHash string) []byte {
	nonce := make([]byte, s.openids.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return s.openids.Seal(nonce, nonce, []byte(openid), []byte(identityHash))
}

func (s *Server) openOpenID(sealed []byte, identityHash string) (string, error) {
	size := s.openids.NonceSize()
	if len(sealed) <= size {
		return "", errors.New("sealed openid is too short")
	}
	plain, err := s.openids.Open(nil, sealed[:size], sealed[size:], []byte(identityHash))
	return string(plain), err
}

// noticeTemplatesView 是小程序请求订阅用的模板（种类和编号，按 noticeKinds 的顺序）；没开顾客通知时为空。
func (s *Server) noticeTemplatesView() []map[string]string {
	out := []map[string]string{}
	if s.openids == nil {
		return out
	}
	for _, kind := range noticeKinds {
		out = append(out, map[string]string{"kind": kind, "templateId": wechatNoticeTemplates[kind].ID})
	}
	return out
}

// addNoticeView 给顾客的预约视图带上订阅用的模板，每条预约带上顾客已经允许过的种类（「我的预约」据此决定给不给「开启微信提醒」）。
func (s *Server) addNoticeView(q *txn, view map[string]any) {
	view["noticeTemplates"] = s.noticeTemplatesView()
	entries, _ := view["reservations"].([]map[string]any)
	if s.openids == nil || len(entries) == 0 {
		return
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry["reservation"].(Reservation).ID)
	}
	kinds := map[string][]string{}
	for _, row := range must(q.db().ReservationNoticeKinds(q.ctx, ids)) {
		kinds[row.ReservationID] = append(kinds[row.ReservationID], row.Kind)
	}
	for _, entry := range entries {
		got := kinds[entry["reservation"].(Reservation).ID]
		if got == nil {
			got = []string{}
		}
		entry["notices"] = got
	}
}

// subscribeReservationNotices 记下顾客在小程序里允许了这条预约的哪几种微信提醒（POST /reservations/{id}/notices）。
// 先在事务外拿登录码换 openid（同 createAuth），再在事务里核对：预约是本人的、还没结束；这个微信就是账户绑定的那个。
// 预约已经确认了的，「预约成功」那种不用再记。
func (s *Server) subscribeReservationNotices(w http.ResponseWriter, r *http.Request) {
	if s.openids == nil {
		s.writeError(w, r, 409, "notices_unavailable", errors.New("门店还没开通微信提醒"))
		return
	}
	// 没登录的不替他调微信
	if _, err := s.userFor(r); err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return
	}
	var in struct {
		WechatLoginCode string   `json:"wechatLoginCode"`
		Kinds           []string `json:"kinds"`
	}
	if err := decode(r, &in); err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	valid := in.WechatLoginCode != "" && utf8.RuneCountInString(in.WechatLoginCode) <= 2048 && len(in.Kinds) > 0
	for i, kind := range in.Kinds {
		valid = valid && slices.Contains(noticeKinds, kind) && !slices.Contains(in.Kinds[:i], kind)
	}
	if !valid {
		s.writeError(w, r, 400, "invalid_request", errors.New("要带上登录码；kinds 只能是 confirmed、reminder、cancelled，各一次"))
		return
	}
	openid := in.WechatLoginCode
	if s.wechat != nil {
		var err error
		if openid, err = s.wechat.ExchangeLogin(r.Context(), in.WechatLoginCode); err != nil {
			s.writeError(w, r, 502, "wechat_unavailable", errors.New("微信暂时没有响应，请重试"))
			return
		}
	}
	target := r.PathValue("id")
	s.serveTx(w, r, true, "reservations", func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.signedIn(w, r)
		if !ok {
			return
		}
		q := s.tx(r)
		x := q.reservation(target)
		if x == nil || x.AccountID != u.ID {
			s.writeError(w, r, 404, "not_found", errNotFound)
			return
		}
		if !x.Live(q.now(), q.reservationSettings().GraceMinutes) {
			s.writeError(w, r, 409, "reservation_ended", errors.New("这个预约已经结束了，不用再开提醒"))
			return
		}
		hash := identityKey(openid)
		if owner := q.userByWechat(hash); owner == nil || owner.ID != u.ID {
			s.writeError(w, r, 403, "wechat_mismatch", errors.New("现在的微信不是这个账户绑定的微信，请换回原来的微信再开提醒"))
			return
		}
		q.fail(errIfNone(q.dbWrite().SealWechatOpenID(q.ctx, queries.SealWechatOpenIDParams{Sealed: s.sealOpenID(openid, hash), IdentityHash: hash, AccountID: u.ID})))
		for _, kind := range in.Kinds {
			if kind == noticeConfirmed && x.Status != "pending" {
				continue
			}
			q.fail(q.dbWrite().AddReservationNotice(q.ctx, queries.AddReservationNoticeParams{ReservationID: x.ID, Kind: kind, AccountID: u.ID, Now: q.now()}))
		}
		writeJSON(w, 200, s.reservationView(q, u.ID, false))
	})
}

// reservationNoticesAfter 在预约状态变了之后安排通知：event 是 noticeConfirmed（店员确认）、noticeCancelled（店员取消）
// 时发那一种，其余（顾客自己取消、爽约、到店开台）传空串，把没发的作废。这里只领取、备好内容，提交之后才调微信。
func (s *Server) reservationNoticesAfter(q *txn, x *Reservation, event string) {
	if s.openids == nil {
		return
	}
	if event != "" {
		s.queueNotice(q, x, event)
	}
	if event != noticeConfirmed {
		q.fail(q.dbWrite().VoidReservationNotices(q.ctx, queries.VoidReservationNoticesParams{Now: q.now(), ReservationID: x.ID}))
	}
}

// queueNotice 领取这条预约这一种还没发的通知（没允许过、发过了的领不到），提交之后发出去。
func (s *Server) queueNotice(q *txn, x *Reservation, kind string) {
	accounts := must(q.dbWrite().ClaimReservationNotice(q.ctx, queries.ClaimReservationNoticeParams{Now: q.now(), ReservationID: x.ID, Kind: kind}))
	if len(accounts) == 0 {
		return
	}
	if job := s.prepareNotice(q, x, kind, accounts[0]); job != nil {
		q.after = append(q.after, job)
	}
}

// prepareNotice 备好一条已领取的通知（内容按事务里的数据填），返回提交之后要做的发送；顾客的 openid 不在了时
// 当场记成失败，返回 nil。
func (s *Server) prepareNotice(q *txn, x *Reservation, kind, account string) func(context.Context) {
	sealed := must(q.db().SealedWechatOpenID(q.ctx, account))
	if len(sealed) == 0 {
		failure := "no_openid"
		q.fail(errIfNone(q.dbWrite().FinishReservationNotice(q.ctx, queries.FinishReservationNoticeParams{Status: "failed", Failure: &failure, Now: q.now(), ReservationID: x.ID, Kind: kind})))
		return nil
	}
	template := wechatNoticeTemplates[kind]
	data := make(map[string]string, len(template.Keywords))
	for keyword, field := range template.Keywords {
		data[keyword] = fitKeyword(keyword, s.noticeValue(q, x, kind, field))
	}
	message := wechatapi.SubscribeMessage{TemplateID: template.ID, Page: wechatapi.MyReservationsPage, State: wechatapi.MessageState(q.codeSettings().Env), Data: data}
	reservation, row := x.ID, sealed[0]
	return func(ctx context.Context) { s.deliverNotice(ctx, reservation, kind, row, message) }
}

// noticeValue 是一个关键词的内容（还没按关键词的格式截短）。
func (s *Server) noticeValue(q *txn, x *Reservation, kind string, field noticeField) string {
	switch field {
	case noticeStart:
		return x.StartAt.In(storetime.Location).Format("2006年01月02日 15:04")
	case noticeStore:
		return noticeStoreName
	case noticeSeat, noticeSeatCode:
		t := q.table(x.TableID)
		if t == nil {
			return "—"
		}
		if field == noticeSeatCode {
			if t.SeatCount > 1 {
				return fmt.Sprintf("%s-%d", t.Code, x.SeatNumber)
			}
			return t.Code
		}
		if t.SeatCount > 1 {
			return fmt.Sprintf("%s 桌 %d 号座", t.Code, x.SeatNumber)
		}
		return t.Code + " 桌"
	case noticeReason:
		if x.Reason != "" {
			return x.Reason
		}
		return "门店取消了这次预约"
	case noticeTip:
		switch kind {
		case noticeConfirmed:
			return fmt.Sprintf("请在开始后%d分钟内到店，逾期座位释放", q.reservationSettings().GraceMinutes)
		case noticeReminder:
			return "记得准时到店，来不了请提前取消"
		}
		return "有疑问请联系门店，欢迎再约"
	}
	return ""
}

// keywordLimits 是各种关键词最多几个字（微信订阅消息文档的「关键词类型」）；没列的（时间、日期）不截。
var keywordLimits = map[string]int{"thing": 20, "character_string": 32, "number": 32, "letter": 32, "symbol": 5, "phrase": 5, "name": 10, "phone_number": 17, "car_number": 8}

// fitKeyword 让内容合关键词的格式：换行、连续空白并成一个空格；超长的截短（事物类末尾加省略号）；
// character_string 只能是字母、数字和符号，其余字去掉。不合格式微信会整条拒收（47003）。
func fitKeyword(keyword, value string) string {
	kind := strings.TrimRight(keyword, "0123456789")
	value = strings.Join(strings.Fields(value), " ")
	if kind == "character_string" {
		value = strings.Map(func(r rune) rune {
			if r > ' ' && r < 0x7f {
				return r
			}
			return -1
		}, value)
	}
	limit, runes := keywordLimits[kind], []rune(value)
	if limit == 0 || len(runes) <= limit {
		return value
	}
	if kind == "thing" {
		return string(runes[:limit-1]) + "…"
	}
	return string(runes[:limit])
}

// deliverNotice 发一条备好的通知并记下结果。在请求事务提交之后、或提醒工作者的事务之外调用。
func (s *Server) deliverNotice(ctx context.Context, reservation, kind string, row queries.SealedWechatOpenIDRow, m wechatapi.SubscribeMessage) {
	status, failure := "sent", ""
	openid, err := s.openOpenID(row.OpenidSealed, row.IdentityHash)
	switch {
	case err != nil:
		status, failure = "failed", "unseal"
	case s.notifier == nil:
		status, failure = "failed", "no_wechat"
	default:
		m.ToUser = openid
		if err := s.notifier.SendSubscribeMessage(ctx, m); err != nil {
			var rejected *wechatapi.MessageRejected
			status, failure = "failed", "request"
			if errors.As(err, &rejected) {
				failure = strconv.Itoa(rejected.Code)
			}
		}
	}
	slog.Info("reservation notice", "reservationId", reservation, "kind", kind, "status", status, "failure", failure)
	var reason *string
	if failure != "" {
		reason = &failure
	}
	if err := s.writeTx(ctx, func(q *txn) error {
		_, err := q.dbWrite().FinishReservationNotice(q.ctx, queries.FinishReservationNoticeParams{Status: status, Failure: reason, Now: q.now(), ReservationID: reservation, Kind: kind})
		q.fail(err)
		return nil
	}); err != nil {
		slog.Error("reservation notice not recorded", "reservationId", reservation, "kind", kind, "error", err.Error())
	}
}

// noticeTimeout 是一次发送（换令牌、发消息、记结果）最多等多久。
const noticeTimeout = 15 * time.Second

// runAfter 在请求事务提交之后做 q.after 里的事（发微信通知），不让客户端等：各开一个协程。
func (s *Server) runAfter(jobs []func(context.Context)) {
	for _, job := range jobs {
		s.background.Add(1)
		go func() {
			defer s.background.Done()
			defer func() {
				if v := recover(); v != nil {
					slog.Error("background job panicked", "panic", fmt.Sprint(v))
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), noticeTimeout)
			defer cancel()
			job(ctx)
		}()
	}
}

// WaitBackground 等提交之后的发送做完，最多等 limit（进程退出前调用）。
func (s *Server) WaitBackground(limit time.Duration) {
	done := make(chan struct{})
	go func() {
		s.background.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(limit):
	}
}

// RunNotices 每分钟发一次到点的开始前提醒，直到 ctx 结束；没开顾客通知时什么都不做。两个副本都跑：
// 领取是一条 UPDATE，同一条提醒只有一个副本领得到（并发时数据库让另一个冲突重来，重来时已经不是 pending）。
func (s *Server) RunNotices(ctx context.Context) {
	if s.openids == nil {
		return
	}
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.sendDueReminders(ctx)
		}
	}
}

// sendDueReminders 领取到点的开始前提醒、备好内容，提交之后一条条发。
func (s *Server) sendDueReminders(ctx context.Context) {
	var jobs []func(context.Context)
	err := s.writeTx(ctx, func(q *txn) error {
		jobs = nil
		hours := q.reservationSettings().ReminderHours()
		if hours == 0 {
			return nil
		}
		now, lead := q.now(), time.Duration(hours)*time.Hour
		due := must(q.dbWrite().ClaimDueReminders(q.ctx, queries.ClaimDueRemindersParams{Now: now, DueBefore: now.Add(lead), Lead: pgtype.Interval{Microseconds: lead.Microseconds(), Valid: true}}))
		for _, row := range due {
			if x := q.reservation(row.ReservationID); x != nil {
				if job := s.prepareNotice(q, x, noticeReminder, row.AccountID); job != nil {
					jobs = append(jobs, job)
				}
			}
		}
		return nil
	})
	if err != nil {
		slog.Error("reservation reminders", "error", err.Error())
		return
	}
	for _, job := range jobs {
		send, cancel := context.WithTimeout(context.WithoutCancel(ctx), noticeTimeout)
		job(send)
		cancel()
	}
}
