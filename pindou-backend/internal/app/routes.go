package app

import (
	"errors"
	"net/http"
	"path"
)

// routes 登记全部接口：标准库 ServeMux 的「方法 + 路径」模式，路径参数用 r.PathValue 取。
// 每条接口在这里写明它怎么用数据库事务（见 serveTx）：
//
//   - read：只读快照。
//   - write(resource, …)：可写事务，提交成功后推送「resource 变了」；resource 为空表示只发凭证、
//     不改业务数据（登录、发扫码登录挑战、网页轮询领会话），不推送。
//   - 直接登记的处理函数不进请求事务：事件流是长连接；先调微信的处理函数（注册、改资料换手机号、登录、
//     生成桌码与网页登录码、改小程序码指向的版本前的试生成）调用微信时不能占着数据库连接和事务；算密码哈希的处理函数（小程序认领会员、
//     员工发临时密码）同理。它们之后自己用 serveTx 或 s.read 开事务。
//   - limited：未登录就能调的身份接口（多数每次都花一次微信额度，密码接口每次都要算一次哈希），按来源限流
//     （见 ratelimit.go），在任何事务之前。
//   - accountLimited：登录后顾客自己就能反复点的写操作，按账户限流（见 ratelimit.go），同样在任何事务之前。
func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	handle := mux.HandleFunc
	read, write, limited, accountLimited := s.readRequest, s.writeRequest, s.rateLimited, s.accountLimited

	// 实时事件：长连接不占事务；每次推送前单独核对身份（见 realtime.go）。
	handle("GET /api/v2/event-streams", s.events)

	handle("POST /api/v2/auth/wechat-sessions", limited(s.createAuth))
	handle("POST /api/v2/auth/member-claims", limited(s.createMemberClaim))
	handle("POST /api/v2/auth/developer-sessions", write("auth", s.switchDeveloperMode))
	handle("DELETE /api/v2/auth/sessions/current", write("auth", s.revokeCurrentSession))
	handle("DELETE /api/v2/auth/web-sessions", write("auth", s.revokeWebSessions))
	handle("POST /api/v2/auth/web-login-challenges", limited(write("", s.createWebLogin)))
	handle("GET /api/v2/auth/web-login-challenges/{id}", read(s.viewWebLogin))
	handle("POST /api/v2/auth/web-login-challenges/{id}/decision", write("auth", s.decideWebLogin))
	handle("POST /api/v2/auth/web-login-challenges/{id}/session", write("", s.claimWebSession))
	handle("POST /api/v2/auth/web-login-challenges/{id}/code", limited(s.webLoginCode))

	handle("POST /api/v2/accounts", limited(s.createUser))
	handle("GET /api/v2/accounts", read(s.listAccounts))
	handle("POST /api/v2/member-accounts", write("accounts", s.createMemberAccount))
	handle("GET /api/v2/accounts/{id}", read(s.getAccount))
	handle("PATCH /api/v2/accounts/{id}", s.updateAccount)
	handle("GET /api/v2/accounts/{id}/sales-orders", read(s.accountOrders))
	handle("POST /api/v2/accounts/{id}/password-resets", s.createPasswordReset)
	handle("GET /api/v2/staff-role-assignments", read(s.listRoleAssignments))
	handle("POST /api/v2/staff-role-assignments", write("staff-role-assignments", s.assignRole))
	handle("DELETE /api/v2/staff-role-assignments/{id}", write("staff-role-assignments", s.revokeRoleAssignment))

	// 布局固定：建区域、改区域、建桌这几个接口还在契约里，登录后一律回 405（见 tables.go）。只核对登录，不写。
	handle("GET /api/v2/floor-areas", read(s.listAreas))
	handle("POST /api/v2/floor-areas", read(s.areaLayoutFixed))
	handle("PATCH /api/v2/floor-areas/{id}", read(s.areaLayoutFixed))
	handle("GET /api/v2/service-tables", read(s.listTables))
	handle("POST /api/v2/service-tables", read(s.tableLayoutFixed))
	handle("PATCH /api/v2/service-tables/{id}", write("service-tables", s.updateTable))

	handle("GET /api/v2/venue-sessions", read(s.listSessions))
	// 顾客自己的整桌计时（customer_sessions.go）；字面路径优先于下面的 {id}
	handle("GET /api/v2/venue-sessions/me", read(s.mySessions))
	handle("POST /api/v2/venue-sessions", write("venue-sessions", s.openSession))
	handle("GET /api/v2/venue-sessions/{id}", read(s.getSession))
	handle("PATCH /api/v2/venue-sessions/{id}", write("venue-sessions", s.updateSession))
	handle("DELETE /api/v2/venue-sessions/{id}", write("venue-sessions", s.cancelSession))

	handle("GET /api/v2/sales-orders", read(s.listOrders))
	handle("POST /api/v2/sales-orders", write("sales-orders", s.createOrder))
	handle("GET /api/v2/sales-orders/{id}", read(s.getOrder))
	handle("PATCH /api/v2/sales-orders/{id}", write("sales-orders", s.changeOrder("lines")))
	handle("PATCH /api/v2/sales-orders/{id}/customer", write("sales-orders", s.changeOrder("customer")))
	handle("POST /api/v2/sales-orders/{id}/payments", write("sales-orders", s.changeOrder("payments")))
	handle("POST /api/v2/sales-orders/{id}/refunds", write("sales-orders", s.changeOrder("refunds")))
	handle("POST /api/v2/sales-orders/{id}/discounts", write("sales-orders", s.changeOrder("discounts")))
	handle("POST /api/v2/sales-orders/{id}/comps", write("sales-orders", s.changeOrder("comps")))

	handle("GET /api/v2/catalog-items", read(s.listCatalogItems))
	handle("POST /api/v2/catalog-items", write("catalog-items", s.writeCatalogItem))
	handle("PATCH /api/v2/catalog-items/{id}", write("catalog-items", s.writeCatalogItem))
	// 入库和盘点改的都是库存，推送 stock-items。
	handle("GET /api/v2/stock-items", read(s.listInventory))
	handle("PATCH /api/v2/stock-items/{id}", write("stock-items", s.updateStockItem))
	handle("POST /api/v2/stock-receipts", write("stock-items", s.purchase))
	handle("GET /api/v2/stock-receipts/prefill", read(s.purchasePrefill))
	handle("POST /api/v2/stock-adjustments", write("stock-items", s.adjustInventory))
	handle("GET /api/v2/stock-movements", read(s.listStockMovements))

	handle("GET /api/v2/reports/exports/{kind}", read(s.exportRecords))
	// 全部数据导出要记审计，所以是写请求。
	handle("POST /api/v2/system/data-exports", write("system", s.exportData))
	handle("GET /api/v2/system/audit-events", read(s.listAudit))
	handle("GET /api/v2/system/miniapp-version", read(s.getMiniappVersion))
	handle("POST /api/v2/system/miniapp-version", write("miniapp-version", s.reportMiniappVersion))
	handle("GET /api/v2/system/code-settings", read(s.getCodeSettings))
	handle("PATCH /api/v2/system/code-settings", s.saveCodeSettings)
	// 收费开关不用登录就能读：顾客端据此藏价格（billing_settings.go）。
	handle("GET /api/v2/system/billing-settings", read(s.getBillingSettings))
	handle("PATCH /api/v2/system/billing-settings", write("billing-settings", s.saveBillingSettings))

	// 呼叫店员（servicecalls.go）：顾客发起按账户限流，在事务之前。
	handle("GET /api/v2/service-calls", read(s.listServiceCalls))
	handle("GET /api/v2/service-calls/me", read(s.myServiceCalls))
	handle("POST /api/v2/service-calls", accountLimited("service-calls", serviceCallRateLimit, serviceCallRateWindow, write("service-calls", s.createServiceCall)))
	handle("POST /api/v2/service-calls/{id}/handle", write("service-calls", s.handleServiceCall))
	handle("POST /api/v2/service-calls/{id}/claim", write("service-calls", s.claimServiceCall))

	// 会员码（membercode.go）：顾客签发按账户限流；员工凭码查人记审计。都不改业务数据，不推送。
	handle("POST /api/v2/member-codes", accountLimited("member-codes", memberCodeRateLimit, memberCodeRateWindow, write("", s.issueMemberCode)))
	handle("POST /api/v2/member-codes/lookups", write("", s.lookupMemberCode))
	// 手机扫码转给本人的网页（scanrelay.go）：只经 NOTIFY 转一次，不推送资源事件。
	handle("POST /api/v2/scan-relays", write("", s.relayScan))

	handle("GET /api/v2/loyalty/public", read(s.loyaltyPublic))
	handle("GET /api/v2/loyalty/table-code", s.tableCode)
	handle("GET /api/v2/loyalty/me", read(s.loyaltyMe))
	handle("GET /api/v2/loyalty/members", read(s.loyaltyMembers))
	handle("GET /api/v2/loyalty/settings", read(s.loyaltySettings))
	handle("GET /api/v2/loyalty/shift", read(s.loyaltyShift))
	handle("GET /api/v2/loyalty/account", read(s.loyaltyAccount))
	handle("GET /api/v2/loyalty/tables", read(s.loyaltyTableList))
	handle("POST /api/v2/loyalty/actions", s.loyaltyActionTx)

	// 消息从本人会员流水和预约读取，阅读时刻不发资源推送，也不需要幂等键。
	handle("GET /api/v2/messages/me", read(s.myMessages))
	handle("POST /api/v2/messages/me/reads", write("", s.markMyMessagesRead))

	handle("GET /api/v2/reservations/me", read(s.myReservations))
	handle("GET /api/v2/reservations/staff", read(s.staffReservations))
	handle("POST /api/v2/reservations/actions", write("reservations", s.postReservationAction))
	// 顾客允许微信提醒（notices.go）：先拿登录码调微信换 openid，再自己开事务
	handle("POST /api/v2/reservations/{id}/notices", accountLimited("reservation-notices", noticeRateLimit, noticeRateWindow, s.subscribeReservationNotices))

	// 小程序首页与图纸（storefront.go、patterns.go）：首页、图纸库和图片游客也能读。上传和换图要先在事务外重新编码图片，
	// 处理函数自己开事务。
	handle("GET /api/v2/storefront", read(s.getStorefront))
	handle("GET /api/v2/storefront/announcement", read(s.getAnnouncement))
	handle("PATCH /api/v2/storefront/announcement", write("storefront", s.saveAnnouncement))
	handle("GET /api/v2/patterns", read(s.listPatterns))
	handle("POST /api/v2/patterns", s.createPattern)
	handle("PATCH /api/v2/patterns/{id}", s.updatePattern)
	handle("DELETE /api/v2/patterns/{id}", write("patterns", s.deletePattern))
	handle("PATCH /api/v2/pattern-order", write("patterns", s.orderPatterns))
	handle("GET /api/v2/pattern-images/{id}/{size}", read(s.patternImage))
	handle("POST /api/v2/pattern-categories", write("patterns", s.createPatternCategory))
	handle("PATCH /api/v2/pattern-categories/{id}", write("patterns", s.updatePatternCategory))
	handle("DELETE /api/v2/pattern-categories/{id}", write("patterns", s.deletePatternCategory))
	handle("PATCH /api/v2/pattern-category-order", write("patterns", s.orderPatternCategories))

	// 顾客的「做图纸」工具（beads.go）：店里的豆子设置游客也能读；图纸只有本人能看能改，保存、删除按账户限流，不推实时事件。
	handle("GET /api/v2/bead-settings", read(s.getBeadSettings))
	handle("PATCH /api/v2/bead-settings", write("bead-settings", s.saveBeadSettings))
	handle("GET /api/v2/bead-patterns", read(s.listBeadPatterns))
	handle("GET /api/v2/bead-patterns/{id}", read(s.getBeadPattern))
	handle("PATCH /api/v2/bead-patterns/{id}", accountLimited("bead-patterns", beadSaveLimit, beadSaveWindow, write("", s.saveBeadPattern)))
	handle("DELETE /api/v2/bead-patterns/{id}", accountLimited("bead-patterns", beadSaveLimit, beadSaveWindow, write("", s.deleteBeadPattern)))
	return mux
}

// serveAPI 把接口请求交给 ServeMux。ServeMux 自己回的 404、405 是纯文本，这里换成接口统一的
// JSON 错误（405 照样带 Allow，列出这个路径接受的方法）。不规整的路径（`//`、`.`、`..`、结尾斜杠）
// ServeMux 会 301 跳到规整的写法，接口不跳，直接 404。
func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	if path.Clean(r.URL.Path) != r.URL.Path {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if h, pattern := s.mux.Handler(r); pattern == "" {
		reply := &statusOnly{header: http.Header{}}
		h.ServeHTTP(reply, r)
		if reply.status == http.StatusMethodNotAllowed {
			w.Header().Set("Allow", reply.header.Get("Allow"))
			s.writeError(w, r, 405, "method_not_allowed", errMethodNotAllowed)
			return
		}
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	s.mux.ServeHTTP(w, r)
}

var errMethodNotAllowed = errors.New("method not allowed")

// statusOnly 只记下 ServeMux 自己的 404/405 回了什么状态和头，正文丢掉。
type statusOnly struct {
	header http.Header
	status int
}

func (w *statusOnly) Header() http.Header         { return w.header }
func (w *statusOnly) WriteHeader(status int)      { w.status = status }
func (w *statusOnly) Write(p []byte) (int, error) { return len(p), nil }

// readRequest 在只读事务里执行 h。
func (s *Server) readRequest(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.serveTx(w, r, false, "", h) }
}

// writeRequest 在可写事务里执行 h，提交成功后推送 resource（为空不推送）。
func (s *Server) writeRequest(resource string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { s.serveTx(w, r, true, resource, h) }
}

// rateLimited 先按来源限流再执行 h：被拦下的请求碰不到处理函数、事务和业务数据。
func (s *Server) rateLimited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.throttled(w, r) {
			return
		}
		h(w, r)
	}
}

// signedIn 认出登录的人；没登录（或令牌无效）时回 401，返回 false。
func (s *Server) signedIn(w http.ResponseWriter, r *http.Request) (*User, bool) {
	u, err := s.userFor(r)
	if err != nil {
		s.writeError(w, r, 401, "unauthorized", err)
		return nil, false
	}
	return u, true
}

// staffMember 认出员工（店员、店长、老板）：没登录回 401，不是员工回 403，返回 false。
func (s *Server) staffMember(w http.ResponseWriter, r *http.Request) (*User, bool) {
	u, ok := s.signedIn(w, r)
	if !ok {
		return nil, false
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return nil, false
	}
	return u, true
}
