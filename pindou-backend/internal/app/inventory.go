package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"slices"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"

	catalogapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/catalog/application"
	ordersapp "github.com/yreidev/pindou-studio/pindou-backend/internal/modules/orders/application"
	"github.com/yreidev/pindou-studio/pindou-backend/internal/storetime"
)

func (s *Server) listInventory(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	out := []stockItemView{}
	for _, x := range s.tx(r).allStock() {
		out = append(out, viewStockItem(x))
	}
	writeJSON(w, 200, out)
}

// stockItemView 是库存列表的一项。库存不高于预警线（含等于）就算偏低。
type stockItemView struct {
	ID        string `json:"id"`
	ProductID string `json:"productId"`
	Quantity  int64  `json:"quantity"`
	AlertAt   int64  `json:"alertAt"`
	LowStock  bool   `json:"lowStock"`
}

func viewStockItem(x *inventoryItem) stockItemView {
	return stockItemView{ID: x.ID, ProductID: x.ProductID, Quantity: x.Quantity, AlertAt: x.AlertAt, LowStock: x.Quantity <= x.AlertAt}
}

// maxStockAlert 是预警线的上限，挡住多敲几个 0 这类手误；单店的一种商品备不到这么多。
const maxStockAlert = 1_000_000

// updateStockItem 修改库存项目的预警线。只收 alertAt：数量只能经采购、盘点、结账和退款变动，
// 每一笔都有流水。店长、老板可改，写审计（原值和新值）；和其他库存写操作一样要幂等键，
// 在同一个请求事务里落库。
func (s *Server) updateStockItem(w http.ResponseWriter, r *http.Request) {
	itemID := r.PathValue("id")
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	key := idemKey(r)
	if key == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	var in struct {
		AlertAt *int64 `json:"alertAt"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	if in.AlertAt == nil || *in.AlertAt < 0 || *in.AlertAt > maxStockAlert {
		s.writeError(w, r, 400, "invalid_stock_alert", fmt.Errorf("预警线填 0 到 %d 之间的整数", maxStockAlert))
		return
	}
	if !validID(itemID) {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	cacheKey, fingerprint := "stock-alert:"+u.ID+":"+itemID+":"+key, requestFingerprint(in)
	q := s.tx(r)
	if c := q.idemGet(cacheKey); c != nil {
		if c.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
			return
		}
		w.Header().Set("Content-Type", c.ContentType)
		w.WriteHeader(c.Status)
		_, _ = w.Write(c.Body)
		return
	}
	it := q.stockItem(itemID)
	if it == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	previous := it.AlertAt
	it.AlertAt = *in.AlertAt
	if previous != it.AlertAt {
		q.audit(u.ID, "stock.alert_updated", it.ID, fmt.Sprintf("预警线 %d 件 → %d 件", previous, it.AlertAt), requestID(r))
	}
	body, _ := json.Marshal(viewStockItem(it))
	body = append(body, '\n')
	q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 200, ContentType: "application/json", Body: body})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(body)
}

// stockMovementView 是库存流水的一条：正数入库、负数出库。流水只追加，不改写也不删除。
// 内部把「采购单号、订单号、盘点原因」都放在 Reason 里，这里按类型拆开，免得前端猜。
type stockMovementView struct {
	ID            string    `json:"id"`
	StockItemID   string    `json:"stockItemId"`
	ProductID     string    `json:"productId"`
	Kind          string    `json:"kind"`
	QuantityDelta int64     `json:"quantityDelta"`
	CreatedAt     time.Time `json:"createdAt"`
	// Reason 只有盘点调整有：员工填写的原因。
	Reason string `json:"reason,omitempty"`
	// ReferenceID：采购是采购单号，销售与退款是订单号，会员业务是订单号或会员流水号。
	ReferenceID  string `json:"referenceId,omitempty"`
	SupplierName string `json:"supplierName,omitempty"`
	Note         string `json:"note,omitempty"`
	// ActorID、ActorName 是办这笔的员工及其当前昵称（读取时换算，店员看流水也不用另查账户）。
	// 2026-10 之前的流水没有记录操作人，两项都不带。
	ActorID   string `json:"actorId,omitempty"`
	ActorName string `json:"actorName,omitempty"`
}

// listStockMovements 按时间倒序列出库存流水，可按库存项目和门店日期筛选。所有员工可读，和库存列表一致。
func (s *Server) listStockMovements(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	query := r.URL.Query()
	itemID := query.Get("stockItemId")
	if itemID != "" && !validID(itemID) {
		s.writeError(w, r, 400, "invalid_request", errors.New("库存项目编号格式不对"))
		return
	}
	from, to, dateErr := exportDateRange(query.Get("from"), query.Get("to"))
	if dateErr != nil {
		s.writeError(w, r, 400, "invalid_date_range", dateErr)
		return
	}
	kind := query.Get("kind")
	if kind != "" && !movementKinds[kind] {
		s.writeError(w, r, 400, "invalid_request", errors.New("流水类型只能是 purchase、adjustment、sale、refund、loyalty"))
		return
	}
	page, pageSize, err := pageParams(query)
	if err != nil {
		s.writeError(w, r, 400, "invalid_request", err)
		return
	}
	out, total := s.tx(r).movementViews(movementFilter{item: itemID, kind: kind, from: from, to: to, newestFirst: true}, page, pageSize)
	if pageSize > 0 {
		setPageHeaders(w, page, pageSize, total)
	}
	writeJSON(w, 200, out)
}

var movementKinds = map[string]bool{"purchase": true, "adjustment": true, "sale": true, "refund": true, "loyalty": true}

func (s *Server) listCatalogItems(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	// ?barcode= 按条码精确找（手机扫码入库）：找到就是只有这一件的列表，没登记过是空列表，不算错。
	if query := r.URL.Query(); query.Has("barcode") {
		code, err := catalogapp.Barcode(query.Get("barcode"))
		if err != nil || code == "" {
			s.writeError(w, r, 400, "invalid_barcode", catalogapp.ErrInvalidBarcode)
			return
		}
		out := []catalogapp.Item{}
		if item := s.tx(r).catalogByBarcode(code); item != nil {
			out = append(out, *item)
		}
		writeJSON(w, 200, out)
		return
	}
	// 只入过库、没建资料的商品在库里也有一行（名称为空），和有资料的一起按编号列出。
	items := s.tx(r).allCatalog()
	out := make([]catalogapp.Item, 0, len(items))
	for _, item := range items {
		out = append(out, *item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	writeJSON(w, 200, out)
}

func (s *Server) purchase(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	key := idemKey(r)
	if key == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	var in struct {
		SupplierName string         `json:"supplierName"`
		Note         string         `json:"note"`
		Items        []purchaseItem `json:"items"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	if in.SupplierName == "" || utf8.RuneCountInString(in.SupplierName) > 100 || utf8.RuneCountInString(in.Note) > 200 || len(in.Items) == 0 {
		s.writeError(w, r, 400, "invalid_purchase", errors.New("supplierName and items are required"))
		return
	}
	for _, x := range in.Items {
		if !validID(x.ProductID) || x.Quantity < 1 || x.Quantity > maxStockQuantity || x.UnitCostCents < 0 || x.UnitCostCents > maxUnitCostCents {
			s.writeError(w, r, 400, "invalid_purchase", errors.New("采购明细填写有误"))
			return
		}
	}
	// 与订单写请求一致：幂等作用域绑定操作者，同键不同内容是冲突而不是重放。
	cacheKey, fingerprint := "purchase:"+u.ID+":"+key, requestFingerprint(in)
	q := s.tx(r)
	if c := q.idemGet(cacheKey); c != nil {
		if c.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
			return
		}
		w.Header().Set("Content-Type", c.ContentType)
		w.WriteHeader(c.Status)
		_, _ = w.Write(c.Body)
		return
	}
	p := &purchase{ID: id(), SupplierName: in.SupplierName, Note: in.Note, Items: in.Items, CreatedAt: q.now()}
	q.addPurchase(p)
	for _, x := range in.Items {
		it := q.stockByProduct(x.ProductID)
		if it == nil {
			it = &inventoryItem{ID: id(), ProductID: x.ProductID}
			q.addStockItem(it)
		}
		it.Quantity += x.Quantity
		addMovement(q, it.ID, x.Quantity, "purchase", p.ID, u.ID)
	}
	q.audit(u.ID, "stock.purchase.created", p.ID, "", requestID(r))
	body, _ := json.Marshal(map[string]any{"id": p.ID, "supplierName": p.SupplierName, "items": p.Items, "createdAt": p.CreatedAt})
	body = append(body, '\n')
	q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 201, ContentType: "application/json", Body: body})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(201)
	_, _ = w.Write(body)
}

// purchasePrefillView 是收货入库表单的预填值。
type purchasePrefillView struct {
	// SupplierName 是最近一次入库的供应商；还没入过库时不带。
	SupplierName  string             `json:"supplierName,omitempty"`
	LastUnitCosts []lastUnitCostView `json:"lastUnitCosts"`
}

type lastUnitCostView struct {
	ProductID     string `json:"productId"`
	UnitCostCents int64  `json:"unitCostCents"`
}

// purchasePrefill 是收货入库（手机和网页）要预填的：最近一次入库的供应商、每件商品最近一次入库的进价。
// 只是建议值，员工可以改，入库接口不看它；店员也能入库，所以所有员工可读。数据都从采购单现算，
// 前端不在本机记，入库后随 stock-items 的事件重读。
func (s *Server) purchasePrefill(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Clerk, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	supplier, costs := s.tx(r).purchasePrefill()
	out := purchasePrefillView{SupplierName: supplier, LastUnitCosts: make([]lastUnitCostView, 0, len(costs))}
	for _, c := range costs {
		out.LastUnitCosts = append(out.LastUnitCosts, lastUnitCostView{ProductID: c.ProductID, UnitCostCents: c.UnitCostCents})
	}
	writeJSON(w, 200, out)
}

// requestFingerprint 是请求内容的摘要，用来区分「同键重试」和「同键换了内容」。
func requestFingerprint(in any) string {
	b, _ := json.Marshal(in)
	return identityKey(string(b))
}

func (s *Server) adjustInventory(w http.ResponseWriter, r *http.Request) {
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	key := idemKey(r)
	if key == "" {
		s.writeError(w, r, 400, "idempotency_required", errors.New("Idempotency-Key is required"))
		return
	}
	var in struct {
		InventoryItemID string `json:"stockItemId"`
		QuantityDelta   int64  `json:"quantityDelta"`
		Reason          string `json:"reason"`
		// ExpectedQuantity 是提交时界面上的当前库存。给了就和库里的比，对不上说明确认之后有人结账、
		// 入库或盘点过，按旧数换算的变化量已经不对，拒绝让人重新核对。只看这一个库存项目，
		// 不用整体状态版本，别的商品变动不会让这次盘点失效。小程序不传，行为照旧。
		// omitempty：不传时请求摘要与加这个字段之前一致，已记下的幂等键照样能重放。
		ExpectedQuantity *int64 `json:"expectedQuantity,omitempty"`
	}
	if e := decode(r, &in); e != nil {
		s.writeError(w, r, 400, "invalid_request", e)
		return
	}
	if in.QuantityDelta > maxStockQuantity || in.QuantityDelta < -maxStockQuantity {
		s.writeError(w, r, 400, "invalid_adjustment", errors.New("调整数量过大，请核对"))
		return
	}
	if in.InventoryItemID == "" || in.QuantityDelta == 0 || in.Reason == "" || utf8.RuneCountInString(in.Reason) > 200 {
		s.writeError(w, r, 400, "invalid_adjustment", errors.New("stockItemId, non-zero quantityDelta and reason are required"))
		return
	}
	if in.ExpectedQuantity != nil && *in.ExpectedQuantity < 0 {
		s.writeError(w, r, 400, "invalid_adjustment", errors.New("盘点时的当前库存不能是负数"))
		return
	}
	cacheKey, fingerprint := "adjustment:"+u.ID+":"+key, requestFingerprint(in)
	q := s.tx(r)
	if c := q.idemGet(cacheKey); c != nil {
		if c.Fingerprint != fingerprint {
			s.writeError(w, r, 409, "idempotency_conflict", errors.New("key already used for a different request"))
			return
		}
		w.Header().Set("Content-Type", c.ContentType)
		w.WriteHeader(c.Status)
		_, _ = w.Write(c.Body)
		return
	}
	it := q.stockItem(in.InventoryItemID)
	if it == nil {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	if in.ExpectedQuantity != nil && *in.ExpectedQuantity != it.Quantity {
		s.writeError(w, r, 409, "stock_quantity_conflict", fmt.Errorf("库存已变化（现为 %d 件），请重新核对后再盘点", it.Quantity))
		return
	}
	if it.Quantity+in.QuantityDelta < 0 {
		s.writeError(w, r, 409, "insufficient_stock", errors.New("调整后库存会变成负数"))
		return
	}
	it.Quantity += in.QuantityDelta
	addMovement(q, it.ID, in.QuantityDelta, "adjustment", in.Reason, u.ID)
	q.audit(u.ID, "stock.adjusted", it.ID, in.Reason, requestID(r))
	body, _ := json.Marshal(map[string]any{"id": it.ID, "quantity": it.Quantity})
	body = append(body, '\n')
	q.rememberIdem(cacheKey, idemResponse{Fingerprint: fingerprint, Status: 201, ContentType: "application/json", Body: body})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(201)
	_, _ = w.Write(body)
}

func (s *Server) exportRecords(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	u, e := s.userFor(r)
	if e != nil {
		s.writeError(w, r, 401, "unauthorized", e)
		return
	}
	if !hasRole(u, Manager, Owner) {
		s.writeError(w, r, 403, "forbidden", errForbidden)
		return
	}
	if kind != "orders" && kind != "refunds" && kind != "inventory" && kind != "purchases" && kind != "movements" {
		s.writeError(w, r, 404, "not_found", errNotFound)
		return
	}
	from, to, dateErr := exportDateRange(r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if dateErr != nil {
		s.writeError(w, r, 400, "invalid_date_range", dateErr)
		return
	}
	q := s.tx(r)
	var rows [][]string
	switch kind {
	case "orders":
		// 免单的单 paid_cents（实收）为 0，comp_cents 是免掉的金额、comp_reason 是原因，对账时单独列出
		rows = append(rows, []string{"id", "status", "receivable_cents", "paid_cents", "comp_cents", "comp_reason"})
		for _, o := range q.ordersCreatedBetween(from, to) {
			comp, reason := "", ""
			for _, p := range o.Payments {
				if p.Method == ordersapp.PaymentComp {
					comp, reason = fmt.Sprint(p.AmountCents), p.Reason
				}
			}
			rows = append(rows, []string{o.ID, o.Status, fmt.Sprint(o.ReceivableCents), fmt.Sprint(o.PaidCents), comp, reason})
		}
	case "refunds":
		rows = append(rows, []string{"order_id", "amount_cents", "reason", "created_at"})
		for _, x := range q.refundsBetween(from, to) {
			rows = append(rows, []string{x.orderID, fmt.Sprint(x.AmountCents), x.Reason, x.CreatedAt.Format(time.RFC3339)})
		}
	case "inventory":
		rows = append(rows, []string{"stock_item_id", "product_id", "quantity"})
		for _, x := range q.allStock() {
			rows = append(rows, []string{x.ID, x.ProductID, fmt.Sprint(x.Quantity)})
		}
	case "purchases":
		rows = append(rows, []string{"id", "supplier", "created_at"})
		for _, x := range q.purchasesBetween(from, to) {
			rows = append(rows, []string{x.ID, x.SupplierName, x.CreatedAt.Format(time.RFC3339)})
		}
	case "movements":
		rows = movementExportRows(q, from, to)
	}
	var file bytes.Buffer
	if err := writeXLSX(&file, rows); err != nil {
		s.writeError(w, r, 500, "export_failed", fmt.Errorf("导出文件生成失败，请重试：%w", err))
		return
	}
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%s.xlsx", kind))
	_, _ = w.Write(file.Bytes())
}

// movementExportRows 是「库存流水」导出：按发生时间从早到晚，时间用门店时区，
// 类型和网页后台流水页的叫法一致。
func movementExportRows(q *txn, from, to time.Time) [][]string {
	views, _ := q.movementViews(movementFilter{from: from, to: to}, 1, 0)
	names := map[string]string{}
	for _, item := range q.allCatalog() {
		names[item.ID] = item.Name
	}
	rows := [][]string{{"时间", "商品", "类型", "数量变化", "原因", "供应商", "采购备注", "关联单号", "操作人"}}
	for _, v := range views {
		rows = append(rows, []string{
			v.CreatedAt.In(storetime.Location).Format("2006-01-02 15:04:05"),
			productName(names, v.ProductID),
			movementKindLabel(v.Kind, v.QuantityDelta),
			fmt.Sprint(v.QuantityDelta),
			v.Reason,
			v.SupplierName,
			v.Note,
			v.ReferenceID,
			v.ActorName,
		})
	}
	return rows
}

// productName 是商品资料里的名称；只入过库、没建资料的商品写「未命名商品 · 编号前 8 位」，和网页后台一致。
func productName(names map[string]string, productID string) string {
	if name := names[productID]; name != "" {
		return name
	}
	short := productID
	if len(short) > 8 {
		short = short[:8]
	}
	return "未命名商品 · " + short
}

// movementKindLabel 是流水类型的中文名。会员业务分出库（会员结账、积分兑换、生日礼物核销）和退回（会员退款）。
func movementKindLabel(kind string, delta int64) string {
	switch kind {
	case "purchase":
		return "采购入库"
	case "adjustment":
		return "盘点调整"
	case "sale":
		return "销售出库"
	case "refund":
		return "退款回补"
	case "loyalty":
		if delta < 0 {
			return "会员出库"
		}
		return "会员退回"
	}
	return kind
}

// 采购和调整的数量、单价上限：防止笔误把库存或金额合计推到溢出。
const (
	maxStockQuantity = 1_000_000
	maxUnitCostCents = 100_000_000 // ¥100 万
)

// exportDateRange 按门店日期取 [from 00:00, to 24:00)。
//
// ★ 以前按 UTC 解析：北京时间 09-19 凌晨 01:00 的订单落在 UTC 的 09-18，
//
//	老板导出 09-19 的账找不到它，导出 09-18 的反而多出来。
func exportDateRange(fromValue, toValue string) (time.Time, time.Time, error) {
	var from, to time.Time
	var err error
	if fromValue != "" {
		from, err = time.ParseInLocation("2006-01-02", fromValue, storetime.Location)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("开始日期格式应为 YYYY-MM-DD")
		}
	}
	if toValue != "" {
		to, err = time.ParseInLocation("2006-01-02", toValue, storetime.Location)
		if err != nil {
			return time.Time{}, time.Time{}, errors.New("结束日期格式应为 YYYY-MM-DD")
		}
		to = to.AddDate(0, 0, 1).Add(-time.Nanosecond)
	}
	if !from.IsZero() && !to.IsZero() && from.After(to) {
		return time.Time{}, time.Time{}, errors.New("开始日期不能晚于结束日期")
	}
	return from, to, nil
}

func exportDateMatch(value, from, to time.Time) bool {
	if from.IsZero() && to.IsZero() {
		return true
	}
	if value.IsZero() {
		return false
	}
	return (from.IsZero() || !value.Before(from)) && (to.IsZero() || !value.After(to))
}

// exportSheet 是导出文件里唯一一张表的名字。
const exportSheet = "Export"

// writeXLSX 把 rows 写成只有一张表（Export）的 xlsx（github.com/xuri/excelize/v2）。单元格一律是文本：
// 金额（分）、数量也按文字写，和以前一样，表格软件不会把编号之类的长数字改成科学计数法。
//
// 不用 excelize 的流式写入：数据超过 16 MB 它要在临时目录落盘，生产容器的根文件系统是只读的。
func writeXLSX(dst io.Writer, rows [][]string) error {
	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	if err := f.SetSheetName("Sheet1", exportSheet); err != nil {
		return err
	}
	width := 0
	for i, row := range rows {
		width = max(width, len(row))
		for j, value := range row {
			cell, err := excelize.CoordinatesToCellName(j+1, i+1)
			if err != nil {
				return err
			}
			if err := f.SetCellStr(exportSheet, cell, value); err != nil {
				return err
			}
		}
	}
	// dimension：告诉阅读器这张表有多大。excelize 不会随写入更新它（新表一直是 A1），
	// 缺了它或范围不对，严格的阅读器会把表当成空的。
	if len(rows) > 0 && width > 0 {
		end, err := excelize.CoordinatesToCellName(width, len(rows))
		if err != nil {
			return err
		}
		if err := f.SetSheetDimension(exportSheet, "A1:"+end); err != nil {
			return err
		}
	}
	f.SetZipWriter(func(w io.Writer) excelize.ZipWriter { return &contentTypesFirst{zip: zip.NewWriter(w)} })
	return f.Write(dst)
}

// contentTypesFirst 是给 excelize 用的 zip 写入器：各部件先记在内存里，关闭时按 Excel 自己存盘的顺序写：
// [Content_Types].xml、_rels/.rels、xl/workbook.xml 和它的关系表在前，其余（表、主题、样式、共享字符串、
// 文档属性）照 excelize 给的顺序，正好也是 Excel 的顺序。
//
// ★★ excelize 按部件名倒序写 zip，[Content_Types].xml 会落在最后。OPC 规范要求它在最前：流式阅读器靠它
// 确定各部件的内容类型，找不到就整包解析不出来。Excel 宽容（会先扫完整个目录），但微信的文档预览器不宽容——
// 2026-09-19 真机验收实测：它不在最前时，导出的 xlsx 在手机上打开完全空白，连表头都没有。
type contentTypesFirst struct {
	zip   *zip.Writer
	names []string
	parts map[string]*bytes.Buffer
}

func (c *contentTypesFirst) Create(name string) (io.Writer, error) {
	if c.parts == nil {
		c.parts = map[string]*bytes.Buffer{}
	}
	if _, ok := c.parts[name]; ok {
		return nil, fmt.Errorf("xlsx 部件 %s 重复", name)
	}
	part := new(bytes.Buffer)
	c.names = append(c.names, name)
	c.parts[name] = part
	return part, nil
}

// AddFS 是 excelize 的 ZipWriter 接口要求的，它保存文件时不调用。
func (c *contentTypesFirst) AddFS(fs.FS) error {
	return errors.New("xlsx 导出不支持追加外部文件")
}

func (c *contentTypesFirst) Close() error {
	first := []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
	priority := func(name string) int {
		if i := slices.Index(first, name); i >= 0 {
			return i
		}
		return len(first)
	}
	sort.SliceStable(c.names, func(i, j int) bool { return priority(c.names[i]) < priority(c.names[j]) })
	for _, name := range c.names {
		part, err := c.zip.Create(name)
		if err != nil {
			return err
		}
		if _, err := part.Write(c.parts[name].Bytes()); err != nil {
			return err
		}
	}
	return c.zip.Close()
}
